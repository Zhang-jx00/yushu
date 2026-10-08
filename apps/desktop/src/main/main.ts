import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { CHANNELS } from "../shared/ipc.js";
import { CloseCoordinator, registerCloseCoordinator, unregisterCloseCoordinator } from "./close-coordinator.js";
import { attachProject, registerIpcHandlers } from "./ipc.js";
import { appRoot } from "./paths.js";
import { runPerfProbe } from "./perf-runner.js";
import { parseTrialDir, runTrial } from "./trial.js";
import { parseWalkthroughDir, prepareWalkthrough, runWalkthrough, startMockOpenAI } from "./walkthrough.js";

/** 御书桌面端入口（M1：主进程 + 白名单 IPC + React renderer） */

/** --ui-trial 逐组销毁/新建窗口；期间必须抑制「窗口全关即退出」，末尾由 runTrial 统一 app.exit */
let autoQuitDisabled = false;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: "御书",
    backgroundColor: "#f7f4ee",
    webPreferences: {
      preload: join(appRoot, "preload", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 保存管线依赖渲染层计时器（自动保存 800ms 防抖、编辑日志 500ms 快照）：
      // 窗口被遮挡时若被 Chromium 后台节流，保存会显著延后（e2e 探针实测暴露）——
      // 写作工具以"防丢稿"为硬约束，禁用后台节流换取计时器可靠性。
      backgroundThrottling: false,
    },
  });

  // 关闭窗口前 flush（T2-6 完整版）：首次 close 拦截 → 渲染层落盘 → 回执后真正关闭；超时（5s）兜底强关。
  // 页面尚未加载完成时无未落盘内容可言：requestFlush 返回 false 直接放行，不拖延用户退出。
  const coordinator = new CloseCoordinator({
    requestFlush: () => {
      if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isLoading()) return false;
      win.webContents.send(CHANNELS.appBeforeClose);
      return true;
    },
    forceClose: () => {
      if (!win.isDestroyed()) win.destroy();
    },
    onEvent: (event) => console.log(`[close-flush] ${event}`),
  });
  const webContentsId = win.webContents.id;
  registerCloseCoordinator(webContentsId, coordinator);
  win.on("close", (event) => coordinator.handleClose(event));
  win.on("closed", () => unregisterCloseCoordinator(webContentsId));

  // 开发模式：加载 Vite dev server（scripts/dev.mjs 注入）；生产：加载构建产物
  const devServerUrl = process.env["VITE_DEV_SERVER_URL"];
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(appRoot, "renderer", "dist", "index.html"));
  }
  return win;
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  // --smoke：无窗口启动冒烟（CI/命令行验证主进程与 IPC 装配，不弹窗）
  if (process.argv.includes("--smoke")) {
    console.log("[smoke] 主进程启动成功，IPC 通道已注册");
    setTimeout(() => app.quit(), 200);
    return;
  }
  // --open-and-quit：真实启动窗口验证渲染端可加载且 React 挂载成功，随后自动退出
  if (process.argv.includes("--open-and-quit")) {
    const win = createWindow();
    win.webContents.on("did-finish-load", () => {
      void win.webContents
        .executeJavaScript(
          `({ rootChildren: document.getElementById("root")?.childElementCount ?? -1, hasApi: !!window.yushu })`,
        )
        .then((info: { rootChildren: number; hasApi: boolean }) => {
          console.log(
            `[smoke] renderer 加载成功：React 根节点子元素 ${info.rootChildren} 个，preload API ${info.hasApi ? "已注入" : "缺失"}`,
          );
          const ok = info.rootChildren > 0 && info.hasApi;
          setTimeout(() => (ok ? app.quit() : app.exit(1)), 400);
        })
        .catch((err: unknown) => {
          console.error("[smoke] 渲染端检查失败:", err);
          app.exit(1);
        });
    });
    win.webContents.on("did-fail-load", (_event, code, desc) => {
      console.error("[smoke] renderer 加载失败:", code, desc);
      app.exit(1);
    });
    return;
  }
  // --e2e-smoke：端到端验收——在真实窗口内经 IPC 走完 建项目→建设定卡→生成大纲→创建草稿章节 全链路
  if (process.argv.includes("--e2e-smoke")) {
    // 关闭前 flush 探针会自行 destroy 窗口：抑制「窗口全关即退出」，末尾由断言结果统一 app.exit
    autoQuitDisabled = true;
    const win = createWindow();
    // once：关闭前 flush 探针会 reload 渲染层，did-finish-load 会再次触发——绝不能让 e2e 跑第二遍
    win.webContents.once("did-finish-load", () => {
      void runE2E(win);
    });
    win.webContents.on("did-fail-load", (_event, code, desc) => {
      console.error("[e2e] renderer 加载失败:", code, desc);
      app.exit(1);
    });
    return;
  }
  // --ui-walkthrough[=<目录>]：M1 验收场景的 UI 自动化预演（驱动 DOM + 逐步截图 + JSON 报告）
  const walkthroughArg = process.argv.find((arg) => arg.startsWith("--ui-walkthrough"));
  if (walkthroughArg) {
    void (async () => {
      // 预演前置必须在窗口加载前完成：renderer 挂载时会调 project:current 并自动进入项目页
      const context = await prepareWalkthrough(parseWalkthroughDir(walkthroughArg));
      const win = createWindow();
      win.webContents.on("did-fail-load", (_event, code, desc) => {
        console.error("[walkthrough] renderer 加载失败:", code, desc);
        app.exit(1);
      });
      win.webContents.once("did-finish-load", () => {
        // 预演中途一旦抛出未捕获异常（如证据写入失败），必须响亮地退出码 1，
        // 不能只留一个 UnhandledPromiseRejection 警告 + 窗口常开——那会让调用方一直等到超时。
        void runWalkthrough(win, context).catch((err: unknown) => {
          console.error("[walkthrough] 执行中断:", err);
          app.exit(1);
        });
      });
    })().catch((err: unknown) => {
      console.error("[walkthrough] 启动失败:", err);
      app.exit(1);
    });
    return;
  }
  // --ui-trial[=<baseDir>]：A0 验收的机器替代——3 组虚拟用户画像各自走完 M1 场景 + 索引加分项 + 网络审计
  const trialArg = process.argv.find((arg) => arg.startsWith("--ui-trial"));
  if (trialArg) {
    autoQuitDisabled = true;
    void runTrial({ baseDir: parseTrialDir(trialArg), createWindow }).catch((err: unknown) => {
      console.error("[trial] 启动失败:", err);
      app.exit(1);
    });
    return;
  }
  // --kill-edit=<dir> / --kill-recover=<dir>：杀进程不丢稿实测（M2 门禁 §5.5 A1）两阶段，
  // 由 scripts/kill-recovery.mjs 编排：A 持续输入 → 外部 taskkill 强杀 → B 重启恢复。
  const killEditArg = process.argv.find((arg) => arg.startsWith("--kill-edit="));
  if (killEditArg) {
    autoQuitDisabled = true; // 保持存活等待被强杀（不做任何退出 / 落盘逻辑）
    void runKillEdit(killEditArg.slice("--kill-edit=".length)).catch((err: unknown) => {
      console.error("[kill-edit] 失败:", err);
      app.exit(2);
    });
    return;
  }
  const killRecoverArg = process.argv.find((arg) => arg.startsWith("--kill-recover="));
  if (killRecoverArg) {
    autoQuitDisabled = true;
    void runKillRecover(killRecoverArg.slice("--kill-recover=".length)).catch((err: unknown) => {
      console.error("[kill-recover] 失败:", err);
      app.exit(2);
    });
    return;
  }
  // --perf-probe[=<dir>]：性能实测探针（M2 / T2-10；synth-1m 百万字夹具 + perf-budget.yaml 全指标）
  const perfProbeArg = process.argv.find((arg) => arg.startsWith("--perf-probe"));
  if (perfProbeArg) {
    autoQuitDisabled = true;
    const dirArg = perfProbeArg.includes("=") ? perfProbeArg.slice(perfProbeArg.indexOf("=") + 1) : "";
    void runPerfProbe({ dirArg, createWindow }).catch((err: unknown) => {
      console.error("[perf] 实测失败:", err);
      app.exit(2);
    });
    return;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 杀进程实测的全局唯一标记（harness 与两个阶段共用；改这里需同步 scripts/kill-recovery.mjs） */
const KILL_TEST_MARKER = "杀进程实测：孤灯残卷。";

/**
 * 杀进程不丢稿实测（一阶段·--kill-edit）：空目录 → 夹具（项目 / 大纲 / 草稿章节 / 初始正文）→
 * 驱动编辑器**持续输入**（自动保存防抖 800ms 永不触发，编辑日志 500ms 照常落盘）→
 * 经产品自身检测接口确认 journal 后打印 KILL_READY → 保持存活等待被外部强杀（taskkill /F）。
 */
async function runKillEdit(dir: string): Promise<void> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(join(dir, "world", "world.yaml"))) {
    const { ProjectGateway } = await import("./file-gateway.js");
    const { createOutlineChapter, createProject, generateOutline } = await import("./project-ops.js");
    const { writeChapterBody } = await import("./chapter-ops.js");
    const { readChapterFile } = await import("@yushu/world-engine");
    await createProject({
      dir,
      title: "杀进程实测",
      packIds: ["xuanhuan-xitong"],
      axes: {
        channel: ["男频"],
        world: ["玄幻"],
        technique: ["系统流"],
        tone: ["爽文"],
        romance_mode_default: "无女主",
      },
    });
    const gateway = new ProjectGateway(dir);
    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "杀进程实测",
      volumeCount: 1,
      chaptersPerVolume: 1,
    });
    const volume = generated.doc.volumes[0]!;
    const chapter = volume.chapters[0]!;
    const draft = await createOutlineChapter(gateway, {
      volumeId: volume.id,
      chapterId: chapter.id,
      baseHash: generated.hash,
    });
    const snapshot = await gateway.readDoc(draft.chapterPath);
    await writeChapterBody(gateway, {
      path: draft.chapterPath,
      body: `${readChapterFile(snapshot.content).body}\n\n初始正文（杀进程实测夹具）。`,
      baseHash: snapshot.hash,
    });
    console.log(`[kill-edit] 夹具就绪：${draft.chapterPath}`);
  }
  await attachProject(dir);
  const win = createWindow();
  await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  await win.webContents.executeJavaScript("window.__yushuDebug = true;");
  const probe = (await win.webContents.executeJavaScript(killEditScript)) as {
    ok: boolean;
    marker?: string;
    note?: string;
  };
  if (!probe.ok) {
    console.error("[kill-edit] 输入失败:", probe.note ?? "(无详情)");
    app.exit(2);
    return;
  }
  console.log(`KILL_READY ${probe.marker ?? ""}`);
  // 不退出：窗口保持打开、输入定时器持续使自动保存防抖不到来——等待 taskkill /F 强杀
}

/**
 * 杀进程不丢稿实测（二阶段·--kill-recover）：重启进入项目 → 恢复面板检出编辑日志 → 点「恢复」→
 * 编辑器载入恢复内容 → 自动保存落盘 → journal 清除；文件级断言在主进程侧完成，输出 KILL_RESULT JSON。
 */
async function runKillRecover(dir: string): Promise<void> {
  const { readFile, readdir } = await import("node:fs/promises");
  const { ProjectGateway } = await import("./file-gateway.js");
  const { listDraftTargets } = await import("./ai-ops.js");
  await attachProject(dir);
  // T2-8 切片 B：二阶段重启应检出「上次会话（被强杀的一阶段）异常退出」——作为崩溃检测证据
  const { currentSessionAbnormal } = await import("./ipc.js");
  const sessionAbnormal = currentSessionAbnormal() !== null;
  const win = createWindow();
  await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  await win.webContents.executeJavaScript("window.__yushuDebug = true;");
  const probe = (await win.webContents.executeJavaScript(killRecoverScript)) as {
    ok: boolean;
    listed?: boolean;
    restoredInEditor?: boolean;
    savedShown?: boolean;
    note?: string;
  };
  const gateway = new ProjectGateway(dir);
  const drafts = await listDraftTargets(gateway).catch(() => []);
  const chapterPath = drafts[0]?.chapterPath ?? "";
  const disk = chapterPath ? await readFile(join(dir, chapterPath), "utf8").catch(() => "") : "";
  const remaining = (await readdir(join(dir, ".yushu", "recovery")).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".json"),
  );
  const result = {
    ok:
      probe.listed === true &&
      probe.restoredInEditor === true &&
      probe.savedShown === true &&
      disk.includes(KILL_TEST_MARKER) &&
      remaining.length === 0 &&
      sessionAbnormal, // T2-8 切片 B：重启检出上次会话异常退出
    journalDetected: probe.listed === true,
    restoredInEditor: probe.restoredInEditor === true,
    savedShown: probe.savedShown === true,
    persisted: disk.includes(KILL_TEST_MARKER),
    journalCleared: remaining.length === 0,
    sessionAbnormal,
    chapterPath,
    note: probe.note ?? "",
  };
  console.log(`KILL_RESULT ${JSON.stringify(result)}`);
  app.exit(result.ok ? 0 : 1);
}

/** 一阶段注入脚本：编辑器持续输入 + 经 recovery:list 确认 journal（与恢复面板同一检测逻辑） */
const killEditScript = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 25000) => {
    const t0 = Date.now();
    for (;;) {
      let r = null;
      try { r = fn(); } catch { r = null; }
      if (r) return r;
      if (Date.now() - t0 > timeout) return null;
      await sleep(80);
    }
  };
  const tabs = await waitFor(() => (document.querySelectorAll('.tab').length > 0 ? true : null), 25000);
  if (!tabs) return { ok: false, note: '项目页标签未出现' };
  const tab = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('编辑器'));
  if (!tab) return { ok: false, note: '找不到编辑器标签页' };
  tab.click();
  const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null), 20000);
  const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
  if (!view || !ie) return { ok: false, note: '编辑器未就绪' };
  await ie.reload();
  const marker = ${JSON.stringify(KILL_TEST_MARKER)};
  let n = 0;
  setInterval(() => {
    n += 1;
    view.dispatch({ changes: { from: view.state.doc.length, insert: n === 1 ? '\\n\\n' + marker : '·' } });
  }, 150);
  let confirmed = false;
  for (let i = 0; i < 100 && !confirmed; i += 1) {
    try {
      const entries = await window.yushu.recovery.list();
      confirmed = entries.some((e) => String(e.body).includes(marker));
    } catch { /* 检测失败重试 */ }
    await sleep(80);
  }
  if (!confirmed) return { ok: false, note: '编辑日志未在超时内检出 marker' };
  return { ok: true, marker };
})()`;

/** 二阶段注入脚本：恢复面板 → 「恢复」→ 编辑器载入 → 自动保存 */
const killRecoverScript = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 25000) => {
    const t0 = Date.now();
    for (;;) {
      let r = null;
      try { r = fn(); } catch { r = null; }
      if (r) return r;
      if (Date.now() - t0 > timeout) return null;
      await sleep(100);
    }
  };
  const marker = ${JSON.stringify(KILL_TEST_MARKER)};
  const banner = await waitFor(() => document.querySelector('.recovery-banner'), 25000);
  if (!banner) return { ok: false, note: '恢复面板未出现：' + document.body.innerText.slice(0, 160) };
  const listed = String(banner.textContent).includes('崩溃前的未保存编辑');
  const restoreBtn = [...banner.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复');
  if (!restoreBtn) return { ok: false, listed, note: '找不到「恢复」按钮' };
  restoreBtn.click();
  const inEditor = await waitFor(() => {
    const el = document.querySelector('.cm-content');
    return el && el.textContent.includes(marker) ? true : null;
  }, 20000);
  const saved = await waitFor(() => {
    const el = document.querySelector('.autosave-status');
    return el && el.textContent.includes('已自动保存') ? true : null;
  }, 20000);
  return { ok: true, listed, restoredInEditor: inEditor === true, savedShown: saved === true };
})()`;

async function runE2E(win: BrowserWindow): Promise<void> {
  const { mkdtemp, rm, readFile, readdir, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "yushu-e2e-"));
  // T3-2 重试探针：mock 第一次请求返回 429，验证「按错误类别退避重试」端到端生效
  const mock = await startMockOpenAI(2, { failFirst: 1, failStatus: 429 });
  // A2 取证专用两端（docs/04 §6.5）：旗舰端点**全程 503**（触发重试 + 回落 + 冷却），小模型端点正常承接。
  // 两个计数器各自独立，因此"哪一端被打了几次"是可精确断言的（现有单 mock 只能看全局 hits）。
  const mockBad = await startMockOpenAI(2, { failFirst: 10_000, failStatus: 503 });
  const mockGood = await startMockOpenAI(2, {});
  // T3-1 迁移探针：预置 v1 简表配置（读取时应迁移为 v2；保存时先备份 v1 → .bak-v1）
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(
    join(dir, "config", "llm.yaml"),
    [
      "apiVersion: yushu.llm/v1",
      "format_version: 1",
      "providers:",
      "  - id: mock",
      "    kind: openai-compatible",
      `    base_url: ${mock.baseUrl}`,
      "    model: legacy-model",
      "",
    ].join("\n"),
    "utf8",
  );
  // T3-2 路由探针：预置 config/routing.yaml（drafting 路由 + fallback 链 + 自定义重试策略）
  await writeFile(
    join(dir, "config", "routing.yaml"),
    [
      "apiVersion: yushu.llm/v1",
      "format_version: 1",
      "routes:",
      "  drafting: {prefer: [flagship], require: [stream]}",
      "  extract: {prefer: [small], require: [structured_output]}",
      "fallback:",
      "  drafting: [mock]",
      "reliability:",
      "  retry_policy:",
      "    RateLimitError: {max_retries: 2, backoff: fixed, base_delay_ms: 1, max_delay_ms: 2}",
      "",
    ].join("\n"),
    "utf8",
  );
  const payload = JSON.stringify({
    dir,
    baseUrl: mock.baseUrl,
    badUrl: mockBad.baseUrl,
    goodUrl: mockGood.baseUrl,
  });
  const script = `(async () => {
    const api = window.yushu;
    const { dir, baseUrl, badUrl, goodUrl } = ${payload};
    const catalog = await api.pack.catalog();
    const preview = await api.pack.fuse(["xuanhuan-xitong"]);
    const snap = await api.project.create({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: preview.genreAxes });
    const card = await api.card.write({ card: { type: "character", name: "林渊", layer: "characters" }, body: "## 问卷回答\\n\\n- **出身**：边城少年\\n" });
    await api.card.write({ card: { type: "law", name: "灵气法则", layer: "laws" }, body: "" });
    const list = await api.card.list();
    const world = await api.project.world();
    const doc = await api.card.read(card.path);
    const outlineState = await api.outline.read();
    const template = outlineState.templates.find((item) => !item.error);
    const generated = await api.outline.generate({ templateId: template.id, title: "天启界", volumeCount: 3, chaptersPerVolume: 2 });
    const volume = generated.doc.volumes[0];
    const co = volume.chapters[0];
    const draft = await api.outline.createChapter({ volumeId: volume.id, chapterId: co.id, baseHash: generated.hash });
    const chapterDoc = await api.doc.read(draft.chapterPath);
    const reread = await api.outline.read();

    // AI 副驾全链路：配置（v1 预置 → 读取迁移为 v2 → 保存写回并备份）→ 上下文预览 → 流式生成（含中止能力）→ 采纳 → 使用记录
    const configBefore = await api.ai.config();
    const configMigrated = {
      formatVersion: configBefore.config.format_version,
      kind: configBefore.config.providers[0] ? configBefore.config.providers[0].kind : "",
      protocol: configBefore.config.providers[0] ? configBefore.config.providers[0].protocol : "",
      modelName: configBefore.config.providers[0] ? configBefore.config.providers[0].models[0].name : "",
    };
    const savedConfig = await api.ai.saveConfig({
      providers: [{
        id: "mock",
        kind: "local",
        protocol: "openai_chat",
        base_url: baseUrl,
        models: [{ name: "mock-model", tier: "flagship", capabilities: { stream: true, usage: true }, limits: { context: 32768, max_output: 2048 } }],
      }],
      ...(configBefore.hash ? { baseHash: configBefore.hash } : {}),
    });
    const configAfter = await api.ai.config();
    const configProbe = {
      formatVersion: configAfter.config.format_version,
      modelName: configAfter.config.providers[0] ? configAfter.config.providers[0].models[0].name : "",
      tier: configAfter.config.providers[0] ? configAfter.config.providers[0].models[0].tier : "",
      streamCap: configAfter.config.providers[0] ? configAfter.config.providers[0].models[0].capabilities.stream : false,
      toolsCap: configAfter.config.providers[0] ? configAfter.config.providers[0].models[0].capabilities.tools : true,
      contextLimit: configAfter.config.providers[0] ? configAfter.config.providers[0].models[0].limits.context : 0,
    };
    const routingProbe = {
      exists: configAfter.routing.exists,
      source: configAfter.routing.path,
      draftingPrefer: (configAfter.routing.routes.find((item) => item.task === 'drafting') || {}).prefer || [],
      draftingRequire: (configAfter.routing.routes.find((item) => item.task === 'drafting') || {}).require || [],
      fallbackDrafting: configAfter.routing.fallback.drafting || [],
      rateLimitRetries: (configAfter.routing.reliability.retry_policy.find((item) => item.kind === 'RateLimitError') || {}).max_retries,
      cooldownS: configAfter.routing.reliability.cooldown.cooldown_s,
      concurrencyGlobal: configAfter.routing.reliability.concurrency.global,
    };
    // T3-4：能力差异标注（v1 迁移后的 provider 未声明 capabilities → 应有体检提示）与本地预设清单
    const presetProbe = {
      migrationWarnings: configBefore.warnings.length,
      presetIds: configAfter.localPresets.map((preset) => preset.id),
    };
    // A4 闸门落在主进程，因此自动化里必须**显式开启**一次（与真实用户点勾选等价），
    // 而不是让 e2e 靠"主进程没有闸门"才能跑——那样闸门就成了只为 UI 准备的装饰。
    const cfgEnabled = await api.ai.setEnabled(true);
    if (cfgEnabled.aiEnabled !== true) throw new Error("AI 总开关未能开启");
    const drafts = await api.ai.drafts();
    const contextPreview = await api.ai.context({ volumeId: volume.id, chapterId: co.id });
    const events = [];
    const off = api.ai.onEvent((event) => events.push(event));
    await api.ai.start({ streamId: "e2e-stream", volumeId: volume.id, chapterId: co.id, task: "draft-first", targetWords: 800 });
    const done = await (async () => {
      for (let i = 0; i < 400; i += 1) {
        const found = events.find((event) => event.type === "done" || event.type === "error");
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("等待流式 done 事件超时");
    })();
    off();
    const adopted = done.type === "done"
      ? await api.ai.adopt({ usageId: done.usageId, volumeId: volume.id, chapterId: co.id, text: done.text, mode: "append" })
      : null;
    const chapterAfter = adopted ? await api.doc.read(adopted.chapterPath) : null;
    const usage = await api.ai.usage();

    // T3-3 降级探针：把 mock 模型声明改为 stream:false → 生成应降级为「一次性返回」（非流式 mock 分支）
    const config3 = await api.ai.config();
    await api.ai.saveConfig({
      providers: [{
        id: "mock",
        kind: "local",
        protocol: "openai_chat",
        base_url: baseUrl,
        models: [{ name: "mock-model", tier: "flagship", capabilities: { stream: false, usage: true }, limits: { context: 32768, max_output: 2048 } }],
      }],
      baseHash: config3.hash,
    });
    const events2 = [];
    const off2 = api.ai.onEvent((event) => events2.push(event));
    await api.ai.start({ streamId: "e2e-downgrade", volumeId: volume.id, chapterId: co.id, task: "continue", targetWords: 500 });
    const done2 = await (async () => {
      for (let i = 0; i < 400; i += 1) {
        const found = events2.find((event) => event.type === "done" || event.type === "error");
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("等待降级流 done 事件超时");
    })();
    off2();
    const downgradeProbe = {
      done: done2.type === "done",
      downgradeEvent: events2.some((event) => event.type === "downgrade" && event.message.includes("降级")),
      deltas: events2.filter((event) => event.type === "delta").length,
      text: done2.type === "done" ? done2.text : "",
    };

    // 导出与自查全链路：追加含敏感词正文 → 预览（对账 + 命中）→ 未确认被拦截 → 确认导出 → 干净剪贴板
    if (done.type === "done") {
      await api.ai.adopt({ usageId: done.usageId, volumeId: volume.id, chapterId: co.id, text: "临走时他低声说：加微信详谈。", mode: "append" });
    }
    // 章节编辑器（M2 / T2-1 切片 A）：读取 → 写入正文 → 字数同步（导出对账必须保持一致）
    let chapterInfo = { readWords: 0, writeWords: 0, grew: false, error: "" };
    try {
      const chapterRead = await api.chapter.read(draft.chapterPath);
      const chapterWrite = await api.chapter.write({
        path: draft.chapterPath,
        body: chapterRead.body + "\\n\\n编辑器中补写的一段。",
        baseHash: chapterRead.hash,
      });
      chapterInfo = {
        readWords: chapterRead.wordCount,
        writeWords: chapterWrite.wordCount,
        grew: chapterWrite.wordCount > chapterRead.wordCount,
        error: "",
      };
    } catch (err) {
      chapterInfo.error = String(err && err.message).slice(0, 200);
    }
    // 码字统计（T2-9 切片 A/B）：章节保存后记账可见（净增口径 + 有效字数口径 + 速度序列）
    const statsProbe = await api.stats.read();
    // 写作会话与真实速度（T2-9 切片 C）：心跳由主进程在脚本前注入（间隔 90s，确定性）
    const statsActivityState = await api.stats.read();
    const statsActivity = {
      activeMs: statsActivityState.today.activeMs,
      sessions: statsActivityState.today.sessions,
      speedCpm: statsActivityState.todaySpeedCpm,
      delta: statsActivityState.today.delta,
    };
    const exportPreview = await api.export.preview();
    let confirmError = "";
    let confirmMessage = "";
    try {
      await api.export.run({ confirmed: false });
      confirmError = "(no-error-thrown)";
    } catch (err) {
      confirmError = String(err && err.code);
      confirmMessage = String(err && err.message).slice(0, 80);
    }
    const exported = await api.export.run({ confirmed: true, includeToc: true, stripMarkers: true });
    const exportedDoc = await api.doc.read(exported.path);
    const clipboardResult = await api.export.clipboard({ stripComments: true, stripAiMarks: true });

    // 检索索引全链路：重建（分片写入 + 进度流，T2-5 切片 B）→ 中文全文检索 + 实体检索 → 状态回读
    const indexProgressEvents = [];
    const offIndexProgress = api.index.onProgress((progress) => indexProgressEvents.push(progress));
    const indexRebuild = await api.index.rebuild();
    offIndexProgress();
    const indexSearch = await api.index.search("夜色");
    const indexEntitySearch = await api.index.search("林渊");
    const indexStatus = await api.index.status();

    // 索引增量（T2-5 切片 A）：改一章 → 增量重建（复用未变文件、只更新 1 个）→ 新词可检索
    const incBefore = await api.chapter.read(draft.chapterPath);
    await api.chapter.write({
      path: draft.chapterPath,
      body: incBefore.body + "\\n\\n增量索引验证：玄铁令。",
      baseHash: incBefore.hash,
    });
    const indexIncremental = await api.index.rebuild({ incremental: true });
    const indexIncSearch = await api.index.search("玄铁令");
    const incremental = {
      mode: indexIncremental.mode,
      reused: indexIncremental.reusedFiles,
      updated: indexIncremental.updatedFiles,
      removed: indexIncremental.removedFiles,
      issues: indexIncremental.integrityIssues.length,
      hit: indexIncSearch.chunks.length,
      filesKeep: indexIncremental.stats.files === indexRebuild.stats.files,
      parseVia: indexIncremental.parseVia,
    };

    // 保存即增量（T2-5 切片 B）：保存后自动刷新索引——不点任何重建按钮，新内容即可检索
    const autoBefore = await api.chapter.read(draft.chapterPath);
    await api.chapter.write({
      path: draft.chapterPath,
      body: autoBefore.body + "\\n\\n自动索引验证：落霞峰。",
      baseHash: autoBefore.hash,
    });
    const autoIndex = await (async () => {
      const started = Date.now();
      let autoHit = 0;
      let autoStatus = null;
      for (let i = 0; i < 120; i += 1) {
        const found = await api.index.search("落霞峰");
        autoHit = found.chunks.length;
        if (autoHit > 0) {
          autoStatus = await api.index.status();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return {
        hit: autoHit,
        elapsedMs: Date.now() - started,
        lastRunAt: autoStatus && autoStatus.refresh ? autoStatus.refresh.lastRunAt : null,
      };
    })();

    // 五层记忆（T3-5）：摘要候选（不入库）→ AI 入库（rev 0）→ 人工修订（rev 1）→ AI 覆盖被拒（E_MEMORY_REV_PROTECTED）
    const memState0 = await api.memory.state();
    const memTarget = memState0.targets.find((t) => t.layer === "chapter_summary" && t.sourceChars > 0);
    if (!memTarget) throw new Error("记忆探针：找不到有素材的章摘要目标");
    const memCandidate = await api.memory.summarize({ layer: memTarget.layer, id: memTarget.id, volumeId: memTarget.volume_id });
    const memState1 = await api.memory.state();
    const memNotAutoSaved = !memState1.summaries.some((s) => s.id === memTarget.id);
    const memSaved = await api.memory.saveSummary({ layer: memTarget.layer, id: memTarget.id, volume_id: memTarget.volume_id, text: memCandidate.text, origin: "ai" });
    const memState2 = await api.memory.state();
    const memAiRev = (memState2.summaries.find((s) => s.id === memTarget.id) || {}).summary_rev;
    const memHuman = await api.memory.saveSummary({ layer: memTarget.layer, id: memTarget.id, volume_id: memTarget.volume_id, text: "人工修订：主角在第一章末获得玄铁令（受保护版本）。", origin: "human", baseHash: memSaved.hash });
    let memReject = { blocked: false, code: "" };
    try {
      await api.memory.saveSummary({ layer: memTarget.layer, id: memTarget.id, text: "AI 覆盖尝试（应被拒绝）。", origin: "ai", baseHash: memHuman.hash });
    } catch (err) {
      memReject = { blocked: String(err && err.message).includes("E_MEMORY_REV_PROTECTED"), code: String(err && err.message).slice(0, 120) };
    }
    // 事实级出处链：登记（出处 ok）→ 涂改正文 → 出处 broken → 删除（携带 baseHash）
    const memBodyBefore = await api.chapter.read(draft.chapterPath);
    const memEnd = Math.min(12, memBodyBefore.body.length);
    const memFact = await api.memory.saveFact({ keys: ["玄铁令"], text: "主角在章节开头获得玄铁令。", provenance: { chapter_id: draft.chapterId, start: 0, end: memEnd } });
    const memState3 = await api.memory.state();
    const memFactOk = (memState3.facts.find((f) => f.id === memFact.id) || {}).provenance === "ok";
    const memTamper = await api.chapter.read(draft.chapterPath);
    await api.chapter.write({ path: draft.chapterPath, body: "【涂改】" + memTamper.body.slice(memEnd), baseHash: memTamper.hash });
    const memState4 = await api.memory.state();
    const memFactBroken = (memState4.facts.find((f) => f.id === memFact.id) || {}).provenance === "broken";
    const memFactHash = (memState4.facts.find((f) => f.id === memFact.id) || {}).hash;
    const memDeleted = await api.memory.deleteFact({ id: memFact.id, baseHash: memFactHash });
    const memState5 = await api.memory.state();
    const memFactGone = !memState5.facts.some((f) => f.id === memFact.id);
    const memoryProbe = {
      targetId: memTarget.id,
      candidateText: memCandidate.text,
      notAutoSaved: memNotAutoSaved,
      aiRev: memAiRev,
      humanRev: memHuman.summary_rev,
      rejectBlocked: memReject.blocked,
      rejectCode: memReject.code,
      factOk: memFactOk,
      factBroken: memFactBroken,
      factDeleted: memDeleted === true,
      factGone: memFactGone,
      summaryFindings: memState3.findings.length,
    };

    // T3-6 注入控制探针：事实注入配置持久化（trigger / manual / reveal_gate）+ 注入预演决策
    const injHit = await api.memory.saveFact({ keys: ["玄铁令"], text: "主角获得玄铁令。", injection: { mode: "trigger", priority: 90, position: "near_end", budget_tokens: 100 } });
    const injMiss = await api.memory.saveFact({ keys: ["不存在词"], text: "无命中关键词。", injection: { mode: "trigger", priority: 10, position: "near_end", budget_tokens: 100 } });
    const injManual = await api.memory.saveFact({ keys: ["玄铁令"], text: "手动清单事实。", injection: { mode: "manual", priority: 50, position: "near_start", budget_tokens: 100 } });
    const injGateOk = await api.memory.saveFact({ keys: ["玄铁令"], text: "门控已到的事实。", injection: { mode: "always", priority: 60, position: "after_system", budget_tokens: 100, reveal_gate: draft.chapterId } });
    const injGateLater = await api.memory.saveFact({ keys: ["玄铁令"], text: "门控未到的事实。", injection: { mode: "always", priority: 60, position: "after_system", budget_tokens: 100, reveal_gate: "ch-zzz999" } });
    const injState = await api.memory.state();
    const injPreview = await api.memory.injectionPreview({ chapterId: draft.chapterId });
    const injPreviewManual = await api.memory.injectionPreview({ chapterId: draft.chapterId, manualIds: [injManual.id] });
    const hitFact = injState.facts.find((f) => f.id === injHit.id) || {};
    const gateFact = injState.facts.find((f) => f.id === injGateLater.id) || {};
    const injectionProbe = {
      configPersisted: (hitFact.injection || {}).mode === "trigger" && (hitFact.injection || {}).priority === 90 && (hitFact.injection || {}).budget_tokens === 100,
      gatePersisted: (gateFact.injection || {}).reveal_gate === "ch-zzz999",
      hitEntry: injPreview.entries.some((e) => e.id === injHit.id && (e.matched_keys || []).includes("玄铁令")),
      missExcluded: injPreview.excluded.some((e) => e.id === injMiss.id && e.code === "no_trigger"),
      manualExcluded: injPreview.excluded.some((e) => e.id === injManual.id && e.code === "no_manual"),
      manualIncluded: injPreviewManual.entries.some((e) => e.id === injManual.id),
      gateOkIncluded: injPreview.entries.some((e) => e.id === injGateOk.id),
      gateLaterExcluded: injPreview.excluded.some((e) => e.id === injGateLater.id && e.code === "reveal_gate"),
      summaryAlways: injPreview.entries.some((e) => e.layer === "chapter_summary"),
      chapterOrdinal: injPreview.chapterOrdinal,
      tokens: injPreview.totals.tokens,
    };

    // T3-7 组装探针：固定槽位顺序 / 摘要与事实落位 / 去重（同文本事实）/ 小预算逐出 + 稳定前缀保留
    await api.memory.saveFact({ keys: ["玄铁令"], text: "主角获得玄铁令。", injection: { mode: "trigger", priority: 5, position: "near_end", budget_tokens: 100 } });
    const asmDefault = await api.memory.assemble({ chapterId: draft.chapterId });
    const asmSmall = await api.memory.assemble({ chapterId: draft.chapterId, budget_total: 40 });
    const slotOf = (result, name) => result.slots.find((s) => s.slot === name) || { items: [] };
    const assemblyProbe = {
      slotOrder: asmDefault.slots.map((s) => s.slot).join(">"),
      slots: asmDefault.slots.length,
      totalTokens: asmDefault.totalTokens,
      budget: asmDefault.budget_total,
      systemStable: slotOf(asmDefault, "system_prompt").items.length === 1 && (slotOf(asmDefault, "system_prompt").items[0] || {}).stable === true,
      chapterSummary: slotOf(asmDefault, "chapter_summary").items.length === 1,
      factsInjected: slotOf(asmDefault, "facts").items.length >= 2,
      recentProse: slotOf(asmDefault, "recent_prose").items.length === 1,
      dedupSimilar: asmDefault.dedup.by_similarity >= 1,
      stableTokens: asmDefault.stableTokens,
      smallBudget: asmSmall.budget_total === 40,
      smallEvicted: asmSmall.dropped.some((d) => d.reason === "budget"),
      smallWithin: asmSmall.totalTokens <= 40,
      smallKeepsSystem: slotOf(asmSmall, "system_prompt").items.length === 1,
    };

    // T3-8 RAG 探针：增量确认最新正文 → 双路召回（向量 + FTS5 bm25）→ RRF 融合 → 重排 → 出处（chapter_id + 区间 + hash）
    await api.index.rebuild({ incremental: true });
    const ragAuto = await api.memory.ragPreview({ chapterId: draft.chapterId });
    const ragCustom = await api.memory.ragPreview({ chapterId: draft.chapterId, query: "天启界", rerankTopK: 6 });
    const ragAssembly = await api.memory.assemble({ chapterId: draft.chapterId });
    const ragSlotItems = (ragAssembly.slots.find((s) => s.slot === "rag_chunks") || { items: [] }).items;
    const ragProbe = {
      autoQuery: ragAuto.query.trim().length > 0 && ragAuto.querySource === "auto",
      store: ragCustom.store,
      storeNote: ragCustom.storeNote.length > 0,
      fused: ragCustom.fused.length,
      reranked: ragCustom.reranked.length,
      vectorHits: ragCustom.paths.vector,
      keywordHits: ragCustom.paths.keyword,
      provenanceAll: ragCustom.fused.every((h) => h.textHash.length === 64 && h.charEnd > h.charStart && h.charStart >= 0),
      chapterProvenance: ragCustom.fused.some((h) => h.chapterId === draft.chapterId),
      fusedSorted: ragCustom.fused.every((h, i) => i === 0 || ragCustom.fused[i - 1].score >= h.score),
      dualPath: ragCustom.fused.some((h) => h.sources.vector && h.sources.keyword),
      rerankOk:
        ragCustom.reranked.length > 0 &&
        ragCustom.reranked.length <= 6 &&
        Boolean(ragCustom.reranked[0].rerank) &&
        String(ragCustom.reranked[0].rerank.reason).includes("词面覆盖"),
      slotStatus: ragAssembly.rag ? ragAssembly.rag.status : "missing",
      slotItems: ragSlotItems.length,
      slotProvenance: ragSlotItems.every((item) => String(item.source || "").includes("出处")),
    };

    // T3-9 上下文快照探针：两次导出 → fingerprint 一致（可复现）；小预算（40）快照 → 「被截断项」标记
    const snap1 = await api.memory.contextSnapshot({ chapterId: draft.chapterId });
    const snap2 = await api.memory.contextSnapshot({ chapterId: draft.chapterId });
    const snapSmall = await api.memory.contextSnapshot({ chapterId: draft.chapterId, budget_total: 40 });
    const snapshotProbe = {
      path: snap1.path,
      pathSmall: snapSmall.path,
      fingerprint: snap1.fingerprint,
      reproducible: snap1.fingerprint === snap2.fingerprint,
      bytes: snap1.bytes,
      smallTruncated: snapSmall.truncatedItems,
      smallTokens: snapSmall.totalTokens,
    };

    // T3-10 设定抽取探针：JSON Schema 契约 + 后校验（mock 返回合法 JSON）→ 候选一律 status=candidate →
    // 与既有卡三分类（林渊=补充 / 玄铁令=新增 / 林渊·location=冲突）→ 采纳仅 new；冲突入库被拒（服务端复核）
    const extractRun = await api.extract.preview({ chapterId: draft.chapterId });
    const extractNew = extractRun.candidates.find((c) => c.name === "玄铁令");
    const extractAugment = extractRun.candidates.find((c) => c.name === "林渊" && c.type === "character");
    const extractConflict = extractRun.candidates.find((c) => c.name === "林渊" && c.type === "location");
    if (!extractNew || !extractAugment || !extractConflict) {
      throw new Error("设定抽取探针：mock 候选未按预期返回（新增/补充/冲突三类）");
    }
    let extractConflictBlocked = false;
    try {
      await api.extract.adopt({ chapterId: draft.chapterId, candidate: extractConflict });
    } catch (err) {
      extractConflictBlocked = String(err && err.message).includes("E_EXTRACT_CONFLICT");
    }
    const extractAdopt = await api.extract.adopt({ chapterId: draft.chapterId, candidate: extractNew });
    const extractCard = await api.card.read(extractAdopt.path);
    const extractExt = ((extractCard.card.extensions || {}).extract || {});
    const extractProbe = {
      total: extractRun.candidates.length,
      allCandidate: extractRun.candidates.every((c) => c.status === "candidate"),
      provenance: extractRun.candidates.every(
        (c) => c.quote.trim().length > 0 && c.confidence >= 0 && c.confidence <= 1 && c.diff.reason.length > 0,
      ),
      newOk: extractNew.diff.kind === "new",
      augmentOk: extractAugment.diff.kind === "augment" && Boolean(extractAugment.diff.matched_card_id),
      conflictOk: extractConflict.diff.kind === "conflict",
      conflictBlocked: extractConflictBlocked,
      adoptPath: extractAdopt.path,
      adoptedStatus: extractExt.status === "accepted",
      adoptedQuote: String(extractExt.quote || "").length > 0,
      adoptedSource: (extractCard.card.source_chapters || []).includes(draft.chapterId),
      downgrade: extractRun.downgrade.map((d) => d.strategy).join(","),
      attempts: extractRun.attempts,
      provider: extractRun.provider_id,
    };
    console.log("[e2e] 设定抽取:", JSON.stringify({ total: extractProbe.total, kinds: [extractNew.diff.kind, extractAugment.diff.kind, extractConflict.diff.kind].join("/"), blocked: extractConflictBlocked, adopted: extractAdopt.path, attempts: extractRun.attempts, downgrade: extractProbe.downgrade }));

    // T3-11 写作 UX 探针：多候选差异化（独立标记）→ 句级局部采纳落盘 → 拒绝原因统计 → 半价通道规划/记账
    // （前序降级探针已把 mock 声明改为 stream:false 且保存——先恢复流式声明，让多候选走真实流式路径）
    const configForRestore = await api.ai.config();
    await api.ai.saveConfig({
      providers: configForRestore.config.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model, index) =>
          index === 0 ? { ...model, capabilities: { ...model.capabilities, stream: true } } : model,
        ),
      })),
      ...(configForRestore.hash ? { baseHash: configForRestore.hash } : {}),
    });
    const multiTexts = [];
    const multiUsageIds = [];
    const multiRecords = [];
    for (const candidateIndex of [1, 2]) {
      const sid = "e2e-multi-" + candidateIndex;
      const multiEvents = [];
      const offMulti = api.ai.onEvent((e) => { if (e.streamId === sid) multiEvents.push(e); });
      await api.ai.start({
        streamId: sid,
        volumeId: volume.id,
        chapterId: co.id,
        task: "draft-first",
        targetWords: 300,
        candidateIndex,
        candidateTotal: 2,
      });
      const doneMulti = await (async () => {
        for (let i = 0; i < 400; i += 1) {
          const found = multiEvents.find((e) => e.type === "done" || e.type === "error");
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("多候选等待 done 超时");
      })();
      offMulti();
      multiTexts.push(doneMulti.type === "done" ? doneMulti.text : "");
      multiUsageIds.push(doneMulti.type === "done" ? doneMulti.usageId : "");
      multiRecords.push(
        doneMulti.type + "|" + String(doneMulti.text || "").slice(0, 24) + "|" + String(doneMulti.message || "").slice(0, 80),
      );
    }
    const multiVaried = multiTexts[0] !== multiTexts[1] && multiTexts[0].includes("候选1") && multiTexts[1].includes("候选2");
    // 局部采纳（句级合并）：取候选 2 首句追加 → 正文含首句、不含第二句（未整段采纳）
    const firstSentence = multiTexts[1].split("。")[0] + "。";
    await api.ai.adopt({ usageId: multiUsageIds[1], volumeId: volume.id, chapterId: co.id, text: firstSentence, mode: "append" });
    const partialBody = await api.chapter.read(draft.chapterPath);
    const partialOk = partialBody.body.includes(firstSentence) && !partialBody.body.includes("（候选2）");
    // 拒绝原因记录（J15）：候选 1 → 太水
    const rejectState = await api.ai.reject({ usageId: multiUsageIds[0], task: "drafting", reason: "太水", excerpt: multiTexts[0].slice(0, 50) });
    const configForChannels = await api.ai.config();
    const usageForChannel = await api.ai.usage();
    const uxProbe = {
      multiVaried,
      multiRecords: multiRecords.join(" ; "),
      partialOk,
      feedbackHasShui: rejectState.counts.some((c) => c.reason === "太水" && c.count >= 1),
      feedbackTotal: rejectState.total,
      channels: (configForChannels.channels || []).map((c) => c.task + ":" + c.channel).join(","),
      channelNote: ((configForChannels.channels || []).find((c) => c.task === "extract") || {}).note || "",
      extractUsageChannel: ((usageForChannel.entries.find((e) => e.task === "extract")) || {}).channel || "",
    };
    console.log("[e2e] 写作 UX:", JSON.stringify(uxProbe));

    // T3-12 Token 与成本探针：
    // ① 给 mock 模型补 pricing（同时验证「providers 全量替换」不会抹掉手写价格）；
    // ② usage 实报与发送前估算确实落盘；
    // ③ 面板按任务/模型可分解、金额确实折算（非「未配置价格」）、预估vs实报偏差有值；
    // ④ 稳定前缀编排核对：断点落在 world_constraints 且稳定槽位全部置头。
    // 注：mock 的 usage 是固定值（12/6 输入），偏差数值只证明「对账链路通」，不代表估算器真实精度。
    const configForPricing = await api.ai.config();
    const savedPricing = await api.ai.saveConfig({
      providers: configForPricing.config.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model, index) =>
          index === 0
            ? { ...model, pricing: { currency: "CNY", input: 2, output: 8, cache_read: 0.2 } }
            : model,
        ),
      })),
      ...(configForPricing.hash ? { baseHash: configForPricing.hash } : {}),
    });
    const usageForTokens = await api.ai.usage();
    const costPanel = await api.ai.cost({ volumeId: volume.id, chapterId: co.id });
    // R49 预算护栏接线取证：坏配置 → 极小月度上限 → 复原为「不设上限」（不给后续探针留污染）
    await api.doc.write("config/budget.yaml", "apiVersion: yushu.budget/v1\\nmonthly_caps: 30\\n");
    const badBudget = (await api.ai.cost({})).budget;
    const badBudgetFile = await api.doc.read("config/budget.yaml");
    await api.doc.write(
      "config/budget.yaml",
      "apiVersion: yushu.budget/v1\\ncurrency: CNY\\nmonthly_cap: 0.00001\\n",
      badBudgetFile.hash,
    );
    const capBudget = (await api.ai.cost({})).budget;
    const capBudgetFile = await api.doc.read("config/budget.yaml");
    await api.doc.write(
      "config/budget.yaml",
      "apiVersion: yushu.budget/v1\\ncurrency: CNY\\n",
      capBudgetFile.hash,
    );
    const costProbe = {
      pricingKept: (savedPricing.config.providers[0] ? savedPricing.config.providers[0].models : [])
        .some((m) => !!m.pricing && m.pricing.input === 2),
      tokensRecorded: usageForTokens.entries.filter(
        (e) => e.type === "generate" && e.tokens && typeof e.tokens.prompt === "number",
      ).length,
      estimateRecorded: usageForTokens.entries.filter(
        (e) => e.estimate && typeof e.estimate.prompt === "number",
      ).length,
      priced: costPanel.totals.cost !== null,
      costText: costPanel.totals.costText,
      promptTokens: costPanel.totals.promptTokens,
      cachedTokens: costPanel.totals.cachedTokens,
      aggregateEntries: costPanel.totals.entries,
      tasks: costPanel.byTask.map((r) => r.key).join(","),
      models: costPanel.byModel.map((r) => r.key).join(","),
      unpriced: costPanel.totals.unpricedEntries,
      withoutTokens: costPanel.entriesWithoutTokens,
      // 端点回显名与配置名一致时应为 0（回落只在「provider 唯一单价」时启用，多价不猜）
      pricingFallback: costPanel.pricingFallback,
      deviationText: costPanel.totals.deviationText,
      cacheOrdered: costPanel.cache ? costPanel.cache.ordered : false,
      cacheMisplaced: costPanel.cache ? costPanel.cache.misplaced.join(",") : "(no-audit)",
      cacheBreakpoint: costPanel.cache ? costPanel.cache.breakpointAfter + "#" + costPanel.cache.breakpointIndex : "(no-audit)",
      cacheStableTokens: costPanel.cache ? costPanel.cache.stableTokens : -1,
      cacheDeclared: costPanel.cache ? costPanel.cache.cacheDeclared : true,
      cacheWarn: costPanel.cache ? costPanel.cache.warnings.join("；").slice(0, 140) : "",
      savingText: costPanel.cache ? costPanel.cache.savingText : "",
      notes: costPanel.notes.length,
      // R49 预算护栏与成本体检（三条都取实测原文，不靠单测外推）：
      //  ① 解析失败必须外显——拼错的键不得静默当成「未配置」；
      //  ② 月度上限极小 → budget-monthly-cap 升 error，且金额只取本月记录；
      //  ③ 未选章纲时 overflow 规则整条「未跑」必须进 skipped，不得显示成"没问题"。
      budgetInvalid: badBudget.error ? badBudget.error.slice(0, 60) : "(no-error)",
      budgetInvalidCode: badBudget.lint.length > 0 ? badBudget.lint[0].code : "(none)",
      budgetKeepsCapNull: badBudget.monthlyCap === null,
      capSeverity: capBudget.lint.some((f) => f.code === "budget-monthly-cap")
        ? capBudget.lint.filter((f) => f.code === "budget-monthly-cap")[0].severity
        : "(none)",
      capSpent: capBudget.spentRows.length > 0 ? capBudget.spentRows[0].totalText : "(empty)",
      capMonthKey: capBudget.monthKey,
      capSkippedCount: capBudget.skipped.length,
      // 未选章纲那次读数：溢出规则必须列进「未跑」而不是假装没问题
      noTargetSkipsOverflow: capBudget.skipped.some((line) => line.indexOf("budget-context-overflow") >= 0),
      // 带章纲那次能否真跑溢出规则，取决于 mock 是否声明 limits.context——只如实记录不断言
      overflowFoundWithTarget: costPanel.budget.lint.some((f) => f.code === "budget-context-overflow"),
    };
    console.log("[e2e] Token 与成本:", JSON.stringify(costProbe));

    // T3-14 密钥安全探针（三种情形都要诚实断言，不粉饰）：
    //  ① 后端可用：加密保存后明文既不进凭据库文件、也不进真源；真源只多一行 key_ref；随后仍可正常取用配置。
    //  ② 后端不可用：必须拒存并给 E_SECRETS_BACKEND，且**不产生任何文件**（绝不降级写明文）。
    //  ③ 无论①②：把含明文 api_key 的 llm.yaml 交回系统读取，必须被 parseLlmConfig 阻断（随后立即复原，
    //     避免污染后续探针）。
    const SECRET_MARK = "sk-e2e-plaintext-abcdefghijklmnopabcdefghijklmnop";
    let probeError = "";
    let securityProbe = {
      backend: false,
      ok: false,
      storedKeyOk: false,
      keyRefWritten: "",
      secretsHavePlain: null,
      yamlHavePlain: null,
      secretsFileCreated: false,
      backendReject: "",
      plaintextBlocked: "",
      restoredOk: false,
    };
    try {
    const cfgBeforeKey = await api.ai.config();
    const backend = cfgBeforeKey.keyBackendAvailable === true;
    let storedKeyOk = false;
    let keyRefWritten = "";
    let secretsHavePlain = null;
    let yamlHavePlain = null;
    let backendReject = "";
    let secretsFileCreated = false;
    if (backend) {
      const saved = await api.ai.saveKey("mock", SECRET_MARK);
      const state = (saved.keyStates || []).find((s) => s.provider_id === "mock") || {};
      storedKeyOk = state.has_stored_key === true;
      keyRefWritten = String((saved.config.providers[0] || {}).key_ref || "");
      const secretsDoc = await api.doc.read(".yushu/secrets.json").catch(() => null);
      secretsHavePlain = secretsDoc ? String(secretsDoc.content).includes(SECRET_MARK) : null;
      secretsFileCreated = secretsDoc !== null;
      yamlHavePlain = String((await api.doc.read("config/llm.yaml")).content).includes(SECRET_MARK);
    } else {
      try {
        await api.ai.saveKey("mock", SECRET_MARK);
        backendReject = "(未拒绝——后端不可用却保存成功)";
      } catch (err) {
        backendReject = String((err && err.code) || err);
      }
      secretsFileCreated = (await api.doc.read(".yushu/secrets.json").catch(() => null)) !== null;
    }
    const yamlBefore = await api.doc.read("config/llm.yaml");
    let plaintextBlocked = "";
    let poisonedWrite = "";
    try {
      poisonedWrite = String(await api.doc.write(
        "config/llm.yaml",
        yamlBefore.content + "api_key: " + SECRET_MARK + "\\n",
        yamlBefore.hash,
      ) ? "written" : "");
      await api.ai.config();
      plaintextBlocked = "(未报错——明文被静默接受)";
    } catch (err) {
      plaintextBlocked = String((err && err.message) || err).slice(0, 80) + " | write=" + poisonedWrite;
    }
    const poisoned = await api.doc.read("config/llm.yaml");
    await api.doc.write("config/llm.yaml", yamlBefore.content, poisoned.hash);
    const restored = await api.ai.config();
    securityProbe = {
      backend,
      ok: backend
        ? storedKeyOk && keyRefWritten === "mock" && secretsHavePlain === false && yamlHavePlain === false && secretsFileCreated && restored.exists
        : backendReject === "E_SECRETS_BACKEND" && !secretsFileCreated,
      storedKeyOk,
      keyRefWritten,
      secretsHavePlain,
      yamlHavePlain,
      secretsFileCreated,
      backendReject,
      plaintextBlocked,
      restoredOk: restored.exists === true,
    };
    } catch (err) {
      probeError = String((err && (err.code ? err.code + ": " : "") + (err.message || err)) || err).slice(0, 200);
      securityProbe = { ...securityProbe, backendReject: securityProbe.backendReject || probeError };
    }
    securityProbe = { ...securityProbe, ok: securityProbe.ok && probeError === "", probeError };
    console.log("[e2e] 密钥安全:", JSON.stringify(securityProbe));

    // 命名生成器（T1-8）：本地离线 + 种子可复现
    const naming = await api.naming.generate({ kind: "character", seed: "e2e", count: 4 });
    const namingAgain = await api.naming.generate({ kind: "character", seed: "e2e", count: 4 });
    const namingPlace = await api.naming.generate({ kind: "place", count: 3 });

    // 稿件总览（T2-4 切片 A）：全库视图汇总（全部章节 + 草稿状态 / 字数）
    const library = await api.library.list();

    // 保存管线（M2 / T2-6 切片）：外部改动 → baseHash 冲突拒绝（不盲覆盖）→ 冲突旁路写入，主文件保持外部版本
    let pipeline = { conflict: "", sidecarOk: false, mainKeptExternal: false };
    try {
      const before = await api.chapter.read(draft.chapterPath);
      await api.chapter.write({
        path: draft.chapterPath,
        body: before.body + "\\n\\n外部改动段落。",
        baseHash: before.hash,
      });
      let conflict = "(no-error-thrown)";
      try {
        await api.chapter.write({
          path: draft.chapterPath,
          body: before.body + "\\n\\n本地编辑段落。",
          baseHash: before.hash,
        });
      } catch (err) {
        conflict = String(err && err.message).includes("E_DOC_CONFLICT")
          ? "E_DOC_CONFLICT"
          : String(err && err.message).slice(0, 80);
      }
      const sidecar = await api.chapter.writeSidecar({
        path: draft.chapterPath,
        body: before.body + "\\n\\n本地编辑段落。",
      });
      const sidecarDoc = await api.doc.read(sidecar.sidecarPath);
      const mainDoc = await api.chapter.read(draft.chapterPath);
      pipeline = {
        conflict,
        sidecarOk:
          sidecar.sidecarPath.includes(".conflict-") &&
          sidecar.sidecarPath.endsWith(".md") &&
          sidecarDoc.content.includes("本地编辑段落。"),
        mainKeptExternal: mainDoc.body.includes("外部改动段落。") && !mainDoc.body.includes("本地编辑段落。"),
      };
    } catch (err) {
      pipeline = { conflict: "throw:" + String(err && err.message).slice(0, 80), sidecarOk: false, mainKeptExternal: false };
    }

    // 破坏前快照（T2-8 切片 B）：三类破坏性操作（删卷 / 删章 / 采纳替换）→ 每次写入前强制 pre_destructive 快照
    const preCount = async () =>
      (await api.snapshot.state()).snapshots.filter((s) => s.reason === "pre_destructive").length;
    const preBefore = await preCount();
    const outlineNow = await api.outline.read();
    const trimVolumes = JSON.parse(JSON.stringify(outlineNow.doc));
    trimVolumes.volumes = trimVolumes.volumes.slice(0, 2); // 删最后一卷（其章纲未绑定草稿，不影响后续探针）
    await api.outline.write({ doc: trimVolumes, baseHash: outlineNow.hash });
    const afterVolumes = await api.outline.read();
    const trimChapters = JSON.parse(JSON.stringify(afterVolumes.doc));
    trimChapters.volumes[1].chapters = trimChapters.volumes[1].chapters.slice(0, 1); // 删一个未绑定草稿的章纲
    const savedTrim = await api.outline.write({ doc: trimChapters, baseHash: afterVolumes.hash });
    await api.ai.adopt({ usageId: "e2e-pre", volumeId: volume.id, chapterId: co.id, text: "替换后的正文（破坏前快照探针）。", mode: "replace" });
    const preDestructive = {
      taken: (await preCount()) - preBefore,
      volumesAfterTrim: savedTrim.doc.volumes.length,
      chaptersAfterTrim: savedTrim.doc.volumes.reduce((n, v) => n + v.chapters.length, 0),
    };

    // Git 版本管理（T2-7 切片 B）：初始化 → 基线提交 → 二次改动提交 → 整体回滚工作区（HEAD 不动）
    const gitProbe = await (async () => {
      try {
        const g0 = await api.git.state();
        const g1 = await api.git.init();
        const c1 = await api.git.commit({ message: "e2e Git 基线" });
        const baseline = await api.chapter.read(draft.chapterPath); // c1 时的正文（回滚应精确回到此版本）
        await api.chapter.write({
          path: draft.chapterPath,
          body: baseline.body + "\\n\\nGit 回滚验证：云隐谷。",
          baseHash: baseline.hash,
        });
        const staged = await api.git.state();
        const c2 = await api.git.commit({ message: "e2e Git 二次改动" });
        const rb = await api.git.rollback({ oid: c1.oid });
        const after = await api.chapter.read(draft.chapterPath);
        const g3 = await api.git.state();
        return {
          initiallyUninitialized: g0.initialized === false,
          initialized: g1.initialized === true,
          baselineFiles: g1.changes.length,
          commit1Files: c1.files,
          stagedChapter: staged.changes.some((c) => c.path === draft.chapterPath && c.state === "modified"),
          commit2Files: c2.files,
          rollbackRestored: rb.restored,
          reverted: !after.body.includes("云隐谷") && after.body === baseline.body,
          preRestore: rb.preRestoreId !== null,
          headUnchanged: g3.head === c2.shortOid,
          pendingAfterRollback: g3.changes.some((c) => c.path === draft.chapterPath && c.state === "modified"),
        };
      } catch (err) {
        return { error: String(err && err.message).slice(0, 200) };
      }
    })();

    // T3-13 中文自查探针（J14）：两个通道都必须只读，且未确认一律不改稿
    let proofreadProbe = {
      ok: false, warn: 0, info: 0, blocked: 0, applied: 0, editCount: 0,
      diskUnchanged: false, spansOk: false, candidateGuard: "", error: "",
    };
    try {
      const pfBefore = await api.chapter.read(draft.chapterPath);
      await api.chapter.write({
        path: draft.chapterPath,
        body: "他走头无路,只能甘败下风。头发被风吹乱，慢慢的退后三步。",
        baseHash: pfBefore.hash,
      });
      const panel = await api.text.proofread({ path: draft.chapterPath });
      const autoEdits = panel.findings.filter((f) => f.autofix).map((f) => ({ start: f.span.start, rule: f.rule }));
      const unconfirmed = await api.text.fixBody({ path: draft.chapterPath, edits: autoEdits, confirmed: false });
      const confirmed = await api.text.fixBody({ path: draft.chapterPath, edits: autoEdits, confirmed: true });
      const diskAfter = await api.chapter.read(draft.chapterPath);
      const ambiguous = panel.findings.find((f) => f.rule === "proofread-conversion-ambiguous");
      const bogus = ambiguous
        ? await api.text.fixBody({
            path: draft.chapterPath,
            edits: [{ start: ambiguous.span.start, rule: ambiguous.rule, replacement: "随便写点什么" }],
            confirmed: true,
          })
        : null;
      const spansOk = panel.findings.every(
        (f) => unconfirmed.beforeBody.slice(f.span.start, f.span.end) === f.span.text,
      );
      const diskUnchanged = diskAfter.body === unconfirmed.beforeBody;
      const candidateGuard = bogus
        ? bogus.applied.length === 0
          ? "rejected:" + String((bogus.rejected[0] || {}).reason || "")
          : "APPLIED"
        : "(no-ambiguous)";
      proofreadProbe = {
        ok:
          panel.counts.warn >= 2 &&
          panel.checkedRules.length === 6 &&
          unconfirmed.body === unconfirmed.beforeBody &&
          unconfirmed.applied.length === 0 &&
          unconfirmed.blocked === autoEdits.length &&
          confirmed.applied.length === autoEdits.length &&
          confirmed.body.indexOf("走投无路") >= 0 &&
          confirmed.body.indexOf("走头无路") < 0 &&
          spansOk &&
          diskUnchanged &&
          candidateGuard.indexOf("候选") >= 0,
        warn: panel.counts.warn,
        info: panel.counts.info,
        blocked: unconfirmed.blocked,
        applied: confirmed.applied.length,
        editCount: autoEdits.length,
        diskUnchanged,
        spansOk,
        candidateGuard,
        error: "",
      };
    } catch (err) {
      proofreadProbe = { ...proofreadProbe, error: String((err && err.message) || err).slice(0, 160) };
    }
    console.log("[e2e] 中文自查:", JSON.stringify(proofreadProbe));

    // A2 任务路由取证（docs/04 §6.5，离线可做的那一半）：
    //  ① 旗舰端点全程 503 → 一次动作内先重试、再按 fallback 链回落到小模型端点并成功出文；
    //  ② 失败达阈进入冷却 → **第二次动作不再尝试坏端点**（冷却跳过事件带原因）；
    //  ③ 一次动作只记**一条** usage 记录，token 取成功那一次（503 不产 token，故不存在重复计费）。
    let routingA2 = {
      ok: false,
      summarizeOk: false,
      firstDone: false,
      secondDone: false,
      firstProvider: "",
      secondProvider: "",
      fallbackEvents: 0,
      cooldownSeen: false,
      recordsDelta: 0,
      promptTokensDelta: 0,
      reasons: "",
      error: "",
    };
    try {
      const rt = await api.doc.read("config/routing.yaml");
      await api.doc.write(
        "config/routing.yaml",
        [
          "apiVersion: yushu.llm/v1",
          "format_version: 1",
          "routes:",
          "  drafting: {prefer: [flagship], require: [stream]}",
          "fallback:",
          "  drafting: [flagship-bad, small-good]",
          "reliability:",
          "  retry_policy:",
          "    InternalServerError: {max_retries: 2, backoff: fixed, base_delay_ms: 1, max_delay_ms: 2}",
          "  cooldown: {allowed_fails: 1, window_s: 120, cooldown_s: 60}",
          "",
        ].join("\\n"),
        rt.hash,
      );
      const caps = (stream) => ({
        tools: false,
        structured_output: true,
        stream: stream,
        usage: true,
        reasoning: false,
        vision: false,
        batch: false,
      });
      const cfgA2 = await api.ai.config();
      await api.ai.saveConfig({
        providers: [
          {
            id: "flagship-bad",
            kind: "cloud",
            protocol: "openai_chat",
            base_url: badUrl,
            api_key_env: "YUSHU_E2E_UNSET_KEY",
            models: [{ name: "bad-model", tier: "flagship", capabilities: caps(true) }],
          },
          {
            id: "small-good",
            kind: "local",
            protocol: "openai_chat",
            base_url: goodUrl,
            models: [{ name: "small-model", tier: "small", capabilities: caps(true) }],
          },
        ],
        ...(cfgA2.hash ? { baseHash: cfgA2.hash } : {}),
      });
      await api.ai.setKey("flagship-bad", "sk-e2e-session-only");
      const usageBefore = (await api.ai.usage()).entries.length;
      const costBefore = await api.ai.cost({});
      const runOnce = async (streamId) => {
        const evs = [];
        const off = api.ai.onEvent((event) => {
          if (event.streamId === streamId) evs.push(event);
        });
        await api.ai.start({ streamId, volumeId: volume.id, chapterId: co.id, task: "draft-first", targetWords: 200 });
        const got = await (async () => {
          for (let i = 0; i < 600; i += 1) {
            const found = evs.find((event) => event.type === "done" || event.type === "error");
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return null;
        })();
        off();
        return {
          done: got !== null && got.type === "done",
          provider: got !== null && got.type === "done" ? got.providerId : "",
          prompt: got !== null && got.type === "done" && got.usage ? got.usage.prompt_tokens : -1,
          fallbacks: evs.filter((event) => event.type === "fallback"),
        };
      };
      const first = await runOnce("e2e-a2-1");
      const second = await runOnce("e2e-a2-2");
      // 第三条动作走**内置默认路由 summarize → prefer [small]**：应直接由小模型端点承接，坏端点不再被尝试
      const memAgain = await api.memory.summarize({ layer: memTarget.layer, id: memTarget.id, volumeId: memTarget.volume_id });
      const summarizeOk = typeof memAgain.text === "string" && memAgain.text.length > 0;
      const usageAfter = (await api.ai.usage()).entries.length;
      const costAfter = await api.ai.cost({});
      const reasons = first.fallbacks.concat(second.fallbacks).map((event) => event.reason).join(" / ");
      routingA2 = {
        ok:
          first.done &&
          second.done &&
          summarizeOk &&
          first.provider === "small-good" &&
          second.provider === "small-good" &&
          first.fallbacks.length >= 1 &&
          second.fallbacks.length >= 1 &&
          reasons.indexOf("冷却") >= 0 &&
          reasons.indexOf("503") >= 0 &&
          first.prompt === 12 &&
          usageAfter - usageBefore === 3 &&
          (costAfter.totals.promptTokens - costBefore.totals.promptTokens) === 30,
        summarizeOk,
        firstDone: first.done,
        secondDone: second.done,
        firstProvider: first.provider,
        secondProvider: second.provider,
        fallbackEvents: first.fallbacks.length + second.fallbacks.length,
        cooldownSeen: reasons.indexOf("冷却") >= 0,
        recordsDelta: usageAfter - usageBefore,
        promptTokensDelta: costAfter.totals.promptTokens - costBefore.totals.promptTokens,
        reasons: reasons.slice(0, 180),
        error: "",
      };
    } catch (err) {
      routingA2 = { ...routingA2, error: String((err && err.message) || err).slice(0, 160) };
    }

    // A4 取证：AI 整体关闭后（对照 docs/01 §7「除 AI 调用外的所有步骤可离线完成」）
    //  ① 三个真会联网的入口一律 E_AI_DISABLED；
    //  ② 端点计数不再增长（主进程侧核对 mockBad / mockGood 的 hits，等价于"一个请求都没发出去"）；
    //  ③ M1/M2 本地能力全部可用（卡片 / 命名 / 索引 / 检索 / 导出与敏感词 / 统计 / 快照 / Git / 记忆台账 / 中文自查 / 稿件总览）。
    let aiOffProbe = {
      ok: false,
      blocked: [],
      blockedAll: false,
      localFailed: [],
      localCount: 0,
      offState: false,
      error: "",
    };
    try {
      const cfgOff = await api.ai.setEnabled(false);
      aiOffProbe.offState = cfgOff.aiEnabled === true;
      const calls = [
        () => api.ai.start({ streamId: "e2e-a4-off", volumeId: volume.id, chapterId: co.id, task: "draft-first", targetWords: 120 }),
        () => api.memory.summarize({ layer: memTarget.layer, id: memTarget.id, volumeId: memTarget.volume_id }),
        () => api.extract.preview({ chapterId: draft.chapterId }),
      ];
      for (const call of calls) {
        try {
          await call();
          aiOffProbe.blocked.push("NOT-BLOCKED");
        } catch (err) {
          aiOffProbe.blocked.push(String((err && err.code) || err || "").slice(0, 30));
        }
      }
      aiOffProbe.blockedAll = aiOffProbe.blocked.length === 3 && aiOffProbe.blocked.every((code) => code.indexOf("E_AI_DISABLED") >= 0);
      const localChecks = {
        cardWrite: async () => api.card.write({ card: { type: "character", name: "A4离线卡", layer: "characters" }, body: "关闭 AI 时仍应可建档。" }),
        naming: async () => api.naming.generate({ kind: "place", count: 3, seed: "a4" }),
        rebuild: async () => api.index.rebuild({ incremental: true }),
        search: async () => api.index.search("A4离线卡", 5),
        library: async () => api.library.list(),
        exportPreview: async () => api.export.preview(),
        stats: async () => api.stats.read(),
        snapshot: async () => api.snapshot.take(),
        gitState: async () => api.git.state(),
        memoryState: async () => api.memory.state(),
        proofread: async () => api.text.proofread({ path: draft.chapterPath }),
      };
      for (const entry of Object.entries(localChecks)) {
        const name = entry[0];
        try {
          await entry[1]();
        } catch (err) {
          aiOffProbe.localFailed.push(name + "=" + String((err && err.message) || err || "").slice(0, 40));
        }
      }
      aiOffProbe.localCount = Object.keys(localChecks).length;
      aiOffProbe.ok =
        aiOffProbe.offState === false &&
        aiOffProbe.blockedAll &&
        aiOffProbe.localFailed.length === 0 &&
        aiOffProbe.localCount === 11;
      aiOffProbe.error = "";
    } catch (err) {
      aiOffProbe = { ...aiOffProbe, error: String((err && err.message) || err).slice(0, 160) };
    }

    return {
      packs: catalog.packs.length, ready: preview.ready, root: snap.root, cards: list.length,
      worldTitle: world && world.title, cardPath: card.path, readBack: doc.card.name,
      templateId: template.id, outlineVolumes: generated.doc.volumes.length,
      outlineChapters: generated.doc.volumes.reduce((n, v) => n + v.chapters.length, 0),
      chapterPath: draft.chapterPath, chapterOutlineRef: chapterDoc.content.includes("outline_ref: " + co.id),
      outlineExists: reread.exists, mapped: reread.doc.volumes[0].chapters[0].chapter_id === draft.chapterId,
      ai: {
        configReady: savedConfig.canGenerate,
        configMigrated,
        configProbe,
        routingProbe,
        presetProbe,
        downgradeProbe,
        drafts: drafts.length,
        slots: contextPreview.slots.length,
        stableChars: contextPreview.stableChars,
        deltas: events.filter((event) => event.type === "delta").length,
        doneText: done.type === "done" ? done.text : "",
        hinted: done.type === "done" ? done.hints.hints.length : -1,
        adoptPath: adopted && adopted.chapterPath,
        adoptWords: adopted && adopted.wordCount,
        chapterHasText: chapterAfter ? chapterAfter.content.includes("天启界的夜色") : false,
        usageGenerate: usage.entries.filter((entry) => entry.type === "generate" && entry.status === "ok").length,
        usageAdopt: usage.entries.filter((entry) => entry.type === "adopt").length,
      },
      exported: {
        missingDrafts: exportPreview.missingDrafts,
        chapters: exportPreview.chapters,
        reconcileMatched: exportPreview.reconcile.every((row) => row.matched),
        errorHits: exportPreview.bySeverity.error,
        hitTotal: exportPreview.hitTotal,
        confirmError,
        confirmMessage,
        path: exported.path,
        words: exported.words,
        clean: exported.clean,
        hasToc: exportedDoc.content.includes("═ 目录 ═"),
        hasAiText: exportedDoc.content.includes("天启界的夜色"),
        noComments: !exportedDoc.content.includes("<!--"),
        clipboardChapters: clipboardResult.chapters,
        clipboardHasSensitiveText: clipboardResult.preview.includes("加微信"),
      },
      indexed: {
        dbPath: indexRebuild.path,
        exists: indexRebuild.exists,
        files: indexRebuild.stats.files,
        entities: indexRebuild.stats.entities,
        chunks: indexRebuild.stats.chunks,
        ftsRows: indexRebuild.stats.ftsRows,
        skipped: indexRebuild.skipped.length,
        searchEntities: indexEntitySearch.entities.length,
        searchChunks: indexSearch.chunks.length,
        snippetHasHit: indexSearch.chunks.some((chunk) => chunk.snippet.includes("夜色")),
        statusChunks: indexStatus.stats ? indexStatus.stats.chunks : -1,
        shards: indexRebuild.shards,
        parseVia: indexRebuild.parseVia,
        progressOk:
          indexProgressEvents.some((event) => event.phase === "parse") &&
          indexProgressEvents.some((event) => event.phase === "chunks") &&
          indexProgressEvents[indexProgressEvents.length - 1]?.phase === "merge",
        progressShardsMatch:
          indexProgressEvents.filter((event) => event.phase === "chunks").length === indexRebuild.shards,
      },
      naming: {
        rulesId: naming.rulesId,
        count: naming.names.length,
        deterministic: JSON.stringify(naming.names) === JSON.stringify(namingAgain.names),
        allValid: naming.names.every((name) => name.length >= 2),
        placeCount: namingPlace.names.length,
      },
      library: {
        chapters: library.totals.chapters,
        drafted: library.totals.drafted,
        words: library.totals.words,
        draftedPathOk: library.chapters.some(
          (item) => item.chapterPath === draft.chapterPath && item.wordCount > 0 && item.status === "draft",
        ),
      },
      chapter: {
        readWords: chapterInfo.readWords,
        writeWords: chapterInfo.writeWords,
        grew: chapterInfo.grew,
        error: chapterInfo.error,
      },
      stats: {
        todayDelta: statsProbe.today.delta,
        todaySaves: statsProbe.today.saves,
        goal: statsProbe.goal.daily,
        dailyDays: statsProbe.daily.length,
        todayEffective: statsProbe.today.effective,
        speedPoints: statsProbe.speed.length,
        tiers: statsProbe.tiers,
      },
      statsActivity,
      incremental,
      autoIndex,
      pipeline,
      preDestructive,
      git: gitProbe,
      memory: memoryProbe,
      injection: injectionProbe,
      assembly: assemblyProbe,
      rag: ragProbe,
      snapshot: snapshotProbe,
      extract: extractProbe,
      ux: uxProbe,
      cost: costProbe,
      security: securityProbe,
      proofread: proofreadProbe,
      routingA2: routingA2,
      aiOff: aiOffProbe,
    };
  })()`;
  try {
    // T2-9 切片 C：主进程侧注入两次活动心跳（间隔 90s，确定性）——脚本内的 statsActivity 探针随后读取
    {
      const { ProjectGateway } = await import("./file-gateway.js");
      const { recordActivity } = await import("./stats-ops.js");
      const activityGateway = new ProjectGateway(dir);
      const base = Date.now();
      await recordActivity(activityGateway, new Date(base - 90_000));
      await recordActivity(activityGateway, new Date(base));
    }
    const result = (await win.webContents.executeJavaScript(script)) as {
      packs: number;
      ready: boolean;
      cards: number;
      worldTitle?: string;
      cardPath: string;
      readBack: string;
      templateId: string;
      outlineVolumes: number;
      outlineChapters: number;
      chapterPath: string;
      chapterOutlineRef: boolean;
      outlineExists: boolean;
      mapped: boolean;
      ai: {
        configReady: boolean;
        configMigrated: {
          formatVersion: number;
          kind: string;
          protocol: string;
          modelName: string;
        };
        configProbe: {
          formatVersion: number;
          modelName: string;
          tier: string;
          streamCap: boolean;
          toolsCap: boolean;
          contextLimit: number;
        };
        routingProbe: {
          exists: boolean;
          source: string;
          draftingPrefer: string[];
          draftingRequire: string[];
          fallbackDrafting: string[];
          rateLimitRetries: number;
          cooldownS: number;
          concurrencyGlobal: number;
        };
        presetProbe: {
          migrationWarnings: number;
          presetIds: string[];
        };
        downgradeProbe: {
          done: boolean;
          downgradeEvent: boolean;
          deltas: number;
          text: string;
        };
        drafts: number;
        slots: number;
        stableChars: number;
        deltas: number;
        doneText: string;
        hinted: number;
        adoptPath: string | null;
        adoptWords: number | null;
        chapterHasText: boolean;
        usageGenerate: number;
        usageAdopt: number;
      };
      exported: {
        missingDrafts: number;
        chapters: number;
        reconcileMatched: boolean;
        errorHits: number;
        hitTotal: number;
        confirmError: string;
        confirmMessage: string;
        path: string;
        words: number;
        clean: boolean;
        hasToc: boolean;
        hasAiText: boolean;
        noComments: boolean;
        clipboardChapters: number;
        clipboardHasSensitiveText: boolean;
      };
      indexed: {
        dbPath: string;
        exists: boolean;
        files: number;
        entities: number;
        chunks: number;
        ftsRows: number;
        skipped: number;
        searchEntities: number;
        searchChunks: number;
        snippetHasHit: boolean;
        statusChunks: number;
        shards: number;
        parseVia: string;
        progressOk: boolean;
        progressShardsMatch: boolean;
      };
      naming: {
        rulesId: string;
        count: number;
        deterministic: boolean;
        allValid: boolean;
        placeCount: number;
      };
      library: {
        chapters: number;
        drafted: number;
        words: number;
        draftedPathOk: boolean;
      };
      chapter: {
        readWords: number;
        writeWords: number;
        grew: boolean;
        error: string;
      };
      stats: {
        todayDelta: number;
        todaySaves: number;
        goal: number;
        dailyDays: number;
        todayEffective: number;
        speedPoints: number;
        tiers: { basic: number; advanced: number };
      };
      statsActivity: {
        activeMs: number;
        sessions: number;
        speedCpm: number | null;
        delta: number;
      };
      incremental: {
        mode: string;
        reused: number;
        updated: number;
        removed: number;
        issues: number;
        hit: number;
        filesKeep: boolean;
        parseVia: string;
      };
      autoIndex: {
        hit: number;
        elapsedMs: number;
        lastRunAt: string | null;
      };
      pipeline: {
        conflict: string;
        sidecarOk: boolean;
        mainKeptExternal: boolean;
      };
      preDestructive: {
        taken: number;
        volumesAfterTrim: number;
        chaptersAfterTrim: number;
      };
      git: {
        error?: string;
        initiallyUninitialized?: boolean;
        initialized?: boolean;
        baselineFiles?: number;
        commit1Files?: number;
        stagedChapter?: boolean;
        commit2Files?: number;
        rollbackRestored?: number;
        reverted?: boolean;
        preRestore?: boolean;
        headUnchanged?: boolean;
        pendingAfterRollback?: boolean;
      };
      memory: {
        targetId: string;
        candidateText: string;
        notAutoSaved: boolean;
        aiRev: number;
        humanRev: number;
        rejectBlocked: boolean;
        rejectCode: string;
        factOk: boolean;
        factBroken: boolean;
        factDeleted: boolean;
        factGone: boolean;
        summaryFindings: number;
      };
      injection: {
        configPersisted: boolean;
        gatePersisted: boolean;
        hitEntry: boolean;
        missExcluded: boolean;
        manualExcluded: boolean;
        manualIncluded: boolean;
        gateOkIncluded: boolean;
        gateLaterExcluded: boolean;
        summaryAlways: boolean;
        chapterOrdinal: number;
        tokens: number;
      };
      assembly: {
        slotOrder: string;
        slots: number;
        totalTokens: number;
        budget: number;
        systemStable: boolean;
        chapterSummary: boolean;
        factsInjected: boolean;
        recentProse: boolean;
        dedupSimilar: boolean;
        stableTokens: number;
        smallBudget: boolean;
        smallEvicted: boolean;
        smallWithin: boolean;
        smallKeepsSystem: boolean;
      };
      rag: {
        autoQuery: boolean;
        store: string;
        storeNote: boolean;
        fused: number;
        reranked: number;
        vectorHits: number;
        keywordHits: number;
        provenanceAll: boolean;
        chapterProvenance: boolean;
        fusedSorted: boolean;
        dualPath: boolean;
        rerankOk: boolean;
        slotStatus: string;
        slotItems: number;
        slotProvenance: boolean;
      };
      snapshot: {
        path: string;
        pathSmall: string;
        fingerprint: string;
        reproducible: boolean;
        bytes: number;
        smallTruncated: number;
        smallTokens: number;
      };
      extract: {
        total: number;
        allCandidate: boolean;
        provenance: boolean;
        newOk: boolean;
        augmentOk: boolean;
        conflictOk: boolean;
        conflictBlocked: boolean;
        adoptPath: string;
        adoptedStatus: boolean;
        adoptedQuote: boolean;
        adoptedSource: boolean;
        downgrade: string;
        attempts: number;
        provider: string;
      };
      ux: {
        multiVaried: boolean;
        multiRecords: string;
        partialOk: boolean;
        feedbackHasShui: boolean;
        feedbackTotal: number;
        channels: string;
        channelNote: string;
        extractUsageChannel: string;
      };
      cost: {
        pricingKept: boolean;
        tokensRecorded: number;
        estimateRecorded: number;
        priced: boolean;
        costText: string;
        promptTokens: number;
        cachedTokens: number;
        aggregateEntries: number;
        tasks: string;
        models: string;
        unpriced: number;
        withoutTokens: number;
        pricingFallback: number;
        deviationText: string;
        cacheOrdered: boolean;
        cacheMisplaced: string;
        cacheBreakpoint: string;
        cacheStableTokens: number;
        cacheDeclared: boolean;
        cacheWarn: string;
        savingText: string;
        notes: number;
        budgetInvalid: string;
        budgetInvalidCode: string;
        budgetKeepsCapNull: boolean;
        capSeverity: string;
        capSpent: string;
        capMonthKey: string;
        capSkippedCount: number;
        noTargetSkipsOverflow: boolean;
        overflowFoundWithTarget: boolean;
      };
      security: {
        backend: boolean;
        ok: boolean;
        storedKeyOk: boolean;
        keyRefWritten: string;
        secretsHavePlain: boolean | null;
        yamlHavePlain: boolean | null;
        secretsFileCreated: boolean;
        backendReject: string;
        plaintextBlocked: string;
        restoredOk: boolean;
        probeError: string;
      };
      proofread: {
        ok: boolean;
        warn: number;
        info: number;
        blocked: number;
        applied: number;
        editCount: number;
        diskUnchanged: boolean;
        spansOk: boolean;
        candidateGuard: string;
        error: string;
      };
      aiOff: {
        ok: boolean;
        blocked: string[];
        blockedAll: boolean;
        localFailed: string[];
        localCount: number;
        offState: boolean;
        error: string;
      };
      routingA2: {
        ok: boolean;
        summarizeOk: boolean;
        firstDone: boolean;
        secondDone: boolean;
        firstProvider: string;
        secondProvider: string;
        fallbackEvents: number;
        cooldownSeen: boolean;
        recordsDelta: number;
        promptTokensDelta: number;
        reasons: string;
        error: string;
      };
    };
    console.log("[e2e] 结果:", JSON.stringify(result));

    // T3-1：v1 → v2 迁移备份（首次覆盖 v1 前自动备份，幂等；探针校验备份文件内容为原 v1 文本）
    const backupText = await readFile(join(dir, "config", "llm.yaml.bak-v1"), "utf8").catch(() => "");
    const migrationBackup = {
      exists: backupText !== "",
      hasLegacyV1: backupText.includes("legacy-model") && backupText.includes("format_version: 1"),
    };
    console.log("[e2e] 配置迁移备份:", JSON.stringify(migrationBackup));

    // T3-9 上下文快照：读回快照文件核验（结构列 / 命中键 / 截断标记 / 指纹与回执一致 / 路径卫生）
    const readSnapshot = async (rel: string) =>
      JSON.parse(await readFile(join(dir, rel), "utf8")) as {
        format: string;
        fingerprint: string;
        totalTokens: number;
        truncatedItems: number;
        dropped: { reason: string }[];
        rag?: { status: string };
        slots: {
          slot: string;
          items: { tokens: number; truncated: boolean; matched_keys: string[]; source?: string }[];
        }[];
      };
    const snapDoc = await readSnapshot(result.snapshot.path);
    const snapSmallDoc = await readSnapshot(result.snapshot.pathSmall);
    const snapshotOk =
      result.snapshot.reproducible &&
      result.snapshot.fingerprint.length === 64 &&
      result.snapshot.bytes > 0 &&
      result.snapshot.path.startsWith(".yushu/context-log/context-") &&
      snapDoc.format === "yushu.context-snapshot/v1" &&
      snapDoc.fingerprint === result.snapshot.fingerprint &&
      snapDoc.slots.length === 8 &&
      snapDoc.slots.every((slot) =>
        slot.items.every(
          (item) =>
            typeof item.tokens === "number" &&
            typeof item.truncated === "boolean" &&
            Array.isArray(item.matched_keys) &&
            typeof item.source === "string",
        ),
      ) &&
      snapDoc.slots.some((slot) => slot.items.some((item) => item.matched_keys.length > 0)) &&
      snapDoc.rag?.status === "ok" &&
      snapSmallDoc.totalTokens <= 40 &&
      snapSmallDoc.truncatedItems >= 1 &&
      snapSmallDoc.dropped.some((entry) => entry.reason === "budget") &&
      snapSmallDoc.slots.find((slot) => slot.slot === "system_prompt")!.items[0]!.truncated === true;
    console.log(
      "[e2e] 上下文快照:",
      JSON.stringify({
        snapshotOk,
        fingerprint: result.snapshot.fingerprint.slice(0, 12),
        bytes: result.snapshot.bytes,
        smallTruncated: result.snapshot.smallTruncated,
      }),
    );

    // T3-2：重试探针——mock 第一次返回 429（RateLimitError 策略 max_retries=2）→ 重试后成功；
    // hits ≥ 2 且 failures = 1 即端到端证明「按错误类别退避重试」真实发生。
    const retryProbe = { hits: mock.stats.hits, failures: mock.stats.failures };
    console.log("[e2e] 重试探针:", JSON.stringify(retryProbe));

    // T3-5 跨项目泄漏探针（A5 红线）：以同款序列化器写入异项目命名空间的事实 →
    // state 应将其放入 rejected 且 findings 出现 error 级 memory-cross-project-leak（拒绝进入本项目记忆）。
    const { serializeFact } = await import("@yushu/memory");
    await mkdir(join(dir, "memory", "facts"), { recursive: true });
    await writeFile(
      join(dir, "memory", "facts", "fact-foreign.md"),
      serializeFact({
        layer: "fact",
        id: "fact-foreign",
        project_id: "world-someone-else",
        keys: ["外来"],
        text: "来自其它项目的事实（跨项目泄漏探针）。\n",
        updated_at: "2026-10-07T00:00:00.000Z",
      }),
      "utf8",
    );
    const crossProject = (await win.webContents.executeJavaScript(`(async () => {
      const state = await window.yushu.memory.state();
      return {
        rejectedIds: state.rejected.map((item) => item.record_id),
        errorCodes: state.findings.filter((item) => item.severity === "error").map((item) => item.code),
        factIds: state.facts.map((item) => item.id),
      };
    })()`)) as { rejectedIds: string[]; errorCodes: string[]; factIds: string[] };
    console.log("[e2e] 记忆跨项目泄漏:", JSON.stringify(crossProject));

    // 会话异常退出检测（T2-8 切片 B）：伪造「上次会话 active + 他进程 pid」→ beginSession 检出异常；
    // 心跳刷新 lastSeenAt；正常关闭（closed）后重开不再检出。探针直接调用主进程会话模块（不依赖 UI）。
    const sessionProbe = await (async () => {
      const { ProjectGateway } = await import("./file-gateway.js");
      const { beginSession, endSession, touchSession } = await import("./session-ops.js");
      const probeGateway = new ProjectGateway(dir);
      const sessionFile = join(dir, ".yushu", "session.json");
      await writeFile(
        sessionFile,
        JSON.stringify({
          schema_version: 1,
          state: "active",
          pid: 1,
          startedAt: "2026-10-05T09:00:00.000Z",
          lastSeenAt: "2026-10-05T09:30:00.000Z",
        }),
        "utf8",
      );
      const detected = await beginSession(probeGateway);
      await touchSession(probeGateway, new Date("2026-10-05T09:40:00.000Z"));
      const touched = JSON.parse(await readFile(sessionFile, "utf8")).lastSeenAt === "2026-10-05T09:40:00.000Z";
      await endSession(probeGateway);
      const clean = await beginSession(probeGateway); // 上次为 closed → 不报异常
      await endSession(probeGateway);
      return {
        ok:
          detected.abnormalExit !== null &&
          detected.abnormalExit.startedAt === "2026-10-05T09:00:00.000Z" &&
          touched &&
          clean.abnormalExit === null,
        abnormalDetected: detected.abnormalExit !== null,
        touchOk: touched,
        cleanReopenDetected: clean.abnormalExit !== null,
      };
    })();
    console.log("[e2e] 会话异常退出检测:", JSON.stringify(sessionProbe));

    // 关闭前 flush（T2-6 完整版）：编辑器内输入（不等自动保存）→ 立即关闭窗口 →
    // 协调器拦截 close 并请求渲染层落盘 → 回执后真正关闭。从「输入」到「窗口 closed」
    // 全程 < 800ms（自动保存防抖窗口）即证明内容由关闭前 flush 落盘，而非自动保存抢先写入。
    // 前置：大脚本创建项目时渲染层仍停在欢迎页（App 挂载早于 createProject）——
    // 先重载渲染层（App 重新挂载时 project:current 返回已挂载项目 → 进入项目页）。
    const reloaded = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
    win.webContents.reload();
    await reloaded;
    // 探针需要编辑器调试句柄（与 UI 预演同一机制；标志需在编辑器视图挂载前设置）
    await win.webContents.executeJavaScript("window.__yushuDebug = true;");

    // 切页落盘（第 12 轮复核修复）：编辑器输入（不等自动保存）→ 立即切页（组件卸载触发 flush）→
    // 磁盘应在 < 800ms（自动保存防抖窗口）内包含新内容——证明落盘由「切页 flush」完成。
    const switchFlushScript = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 12000) => {
        const t0 = Date.now();
        for (;;) {
          let r = null;
          try { r = fn(); } catch { r = null; }
          if (r) return r;
          if (Date.now() - t0 > timeout) return null;
          await sleep(100);
        }
      };
      const clickTab = (label) => {
        const b = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes(label));
        if (!b) return null;
        b.click();
        return b;
      };
      const tabs = await waitFor(() => (document.querySelectorAll('.tab').length > 0 ? true : null), 15000);
      if (!tabs) return { ok: false, note: '项目页标签未出现：' + document.body.innerText.slice(0, 160).split('\\n').join(' | ') };
      if (!clickTab('编辑器')) return { ok: false, note: '找不到编辑器标签页' };
      const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null));
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!view || !ie) return { ok: false, note: '编辑器未就绪（调试句柄未暴露或章节未加载）' };
      await ie.reload();
      const marker = '切页落盘验证：疏影横斜。';
      const dispatchAt = Date.now();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n' + marker } });
      if (!clickTab('项目文件')) return { ok: false, note: '找不到项目文件标签页' };
      return { ok: true, marker, dispatchAt };
    })()`;
    let switchFlush = { ok: false, withinDebounce: false, sinceDispatchMs: -1, note: "未执行" };
    try {
      const probe = (await win.webContents.executeJavaScript(switchFlushScript)) as {
        ok: boolean;
        marker?: string;
        dispatchAt?: number;
        note?: string;
      };
      if (!probe.ok || typeof probe.dispatchAt !== "number" || !probe.marker) {
        switchFlush = { ...switchFlush, note: probe.note ?? "预置脚本失败" };
      } else {
        let hasMarker = false;
        for (let i = 0; i < 40 && !hasMarker; i += 1) {
          const content = await readFile(join(dir, result.chapterPath), "utf8");
          hasMarker = content.includes(probe.marker);
          if (!hasMarker) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const sinceDispatchMs = Date.now() - probe.dispatchAt;
        switchFlush = {
          ok: hasMarker,
          withinDebounce: sinceDispatchMs < 800,
          sinceDispatchMs,
          note: `输入→切页落盘 ${sinceDispatchMs}ms（<800ms 自动保存防抖窗口）；磁盘含标记=${hasMarker}`,
        };
      }
    } catch (err) {
      switchFlush = { ...switchFlush, note: `异常：${err instanceof Error ? err.message : String(err)}` };
    }
    console.log("[e2e] 切页落盘:", JSON.stringify(switchFlush));

    // 崩溃恢复（T2-8 切片 A）：编辑器输入 → 编辑日志（.yushu/recovery）落盘（自动保存防抖未到）→
    // reload 销毁渲染层 JS 上下文（模拟崩溃：自动保存定时器死亡，journal 是唯一幸存者）→
    // 重新进入项目 → 恢复面板出现 → 点「恢复」→ 编辑器载入恢复内容 → 自动保存落盘 → journal 清除。
    const crashRecoveryInputScript = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 12000) => {
        const t0 = Date.now();
        for (;;) {
          let r = null;
          try { r = fn(); } catch { r = null; }
          if (r) return r;
          if (Date.now() - t0 > timeout) return null;
          await sleep(100);
        }
      };
      const tabs = await waitFor(() => (document.querySelectorAll('.tab').length > 0 ? true : null), 15000);
      if (!tabs) return { ok: false, note: '项目页标签未出现' };
      const tab = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('编辑器'));
      if (!tab) return { ok: false, note: '找不到编辑器标签页' };
      tab.click();
      const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null));
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!view || !ie) return { ok: false, note: '编辑器未就绪（调试句柄未暴露或章节未加载）' };
      await ie.reload();
      const marker = '崩溃恢复验证：孤舟蓑笠。';
      const dispatchAt = Date.now();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n' + marker } });
      // 等编辑日志（500ms 快照；自动保存防抖 800ms 未到）——经产品自身恢复检测接口确认，确认即返回（不等自动保存）
      let journalConfirmed = false;
      let confirmedMs = -1;
      let lastCount = -1;
      let lastErr = '';
      for (let i = 0; i < 30 && !journalConfirmed; i += 1) {
        try {
          const entries = await window.yushu.recovery.list();
          lastCount = entries.length;
          if (entries.some((e) => String(e.body).includes(marker))) {
            journalConfirmed = true;
            confirmedMs = Date.now() - dispatchAt;
            break;
          }
        } catch (err) {
          lastErr = String((err && err.message) || err).slice(0, 140);
        }
        await sleep(50);
      }
      return { ok: journalConfirmed, marker, dispatchAt, confirmedMs, lastCount, lastErr };
    })()`;
    const crashRecoveryRestoreScript = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 12000) => {
        const t0 = Date.now();
        for (;;) {
          let r = null;
          try { r = fn(); } catch { r = null; }
          if (r) return r;
          if (Date.now() - t0 > timeout) return null;
          await sleep(100);
        }
      };
      const banner = await waitFor(() => document.querySelector('.recovery-banner'), 20000);
      if (!banner) return { ok: false, note: '恢复面板未出现：' + document.body.innerText.slice(0, 200) };
      const bannerShown = String(banner.textContent).includes('崩溃前的未保存编辑');
      const restoreBtn = [...banner.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复');
      if (!restoreBtn) return { ok: false, note: '找不到「恢复」按钮', bannerShown };
      restoreBtn.click();
      const inEditor = await waitFor(() => {
        const el = document.querySelector('.cm-content');
        return el && el.textContent.includes('崩溃恢复验证：孤舟蓑笠。') ? true : null;
      }, 15000);
      const saved = await waitFor(() => {
        const el = document.querySelector('.autosave-status');
        return el && el.textContent.includes('已自动保存') ? true : null;
      }, 15000);
      return { ok: true, bannerShown, restoredInEditor: inEditor === true, savedShown: saved === true };
    })()`;
    let crashRecovery = {
      journalDetected: false,
      diskNotSavedYet: false,
      bannerShown: false,
      restoredInEditor: false,
      persisted: false,
      journalCleared: false,
      note: "未执行",
    };
    try {
      const marker = "崩溃恢复验证：孤舟蓑笠。";
      const recoveryDir = join(dir, ".yushu", "recovery");
      const probeA = (await win.webContents.executeJavaScript(crashRecoveryInputScript)) as {
        ok: boolean;
        marker?: string;
        confirmedMs?: number;
        lastCount?: number;
        lastErr?: string;
        note?: string;
      };
      if (!probeA.ok || probeA.marker !== marker) {
        crashRecovery = {
          ...crashRecovery,
          note:
            probeA.note ??
            `编辑日志未在 1.5s 内出现（输入脚本失败；list 末次条数=${probeA.lastCount ?? -1}${probeA.lastErr ? `；异常=${probeA.lastErr}` : ""}）`,
        };
      } else {
        // 渲染层已用 recovery:list 确认编辑日志出现（与恢复面板同一检测逻辑）：确认即返回，不等自动保存
        const journalFound = true;
        // 前置确认：章节磁盘尚未包含标记（自动保存防抖 800ms 未到；随后落盘的是"崩溃→恢复"链路）
        const chapterAtCrash = await readFile(join(dir, result.chapterPath), "utf8");
        const diskNotSavedYet = !chapterAtCrash.includes(marker);
        // 3) 模拟崩溃：reload 销毁渲染层（自动保存定时器随之死亡）
        const reloaded2 = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
        win.webContents.reload();
        await reloaded2;
        await win.webContents.executeJavaScript("window.__yushuDebug = true;");
        // 4) 恢复面板 → 恢复 → 编辑器载入 → 自动保存
        const probeB = (await win.webContents.executeJavaScript(crashRecoveryRestoreScript)) as {
          ok: boolean;
          bannerShown?: boolean;
          restoredInEditor?: boolean;
          savedShown?: boolean;
          note?: string;
        };
        const chapterAfter = await readFile(join(dir, result.chapterPath), "utf8");
        const persisted = chapterAfter.includes(marker);
        const remaining = (await readdir(recoveryDir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
        crashRecovery = {
          journalDetected: journalFound,
          diskNotSavedYet,
          bannerShown: probeB.bannerShown === true,
          restoredInEditor: probeB.restoredInEditor === true,
          persisted,
          journalCleared: remaining.length === 0,
          note:
            `编辑日志检出=${journalFound}；崩溃时磁盘未保存=${diskNotSavedYet}；` +
            `恢复面板=${probeB.bannerShown === true}；编辑器载入恢复内容=${probeB.restoredInEditor === true}；` +
            `落盘=${persisted}；journal 已清=${remaining.length === 0}` +
            (probeB.note ? `；脚本：${probeB.note}` : ""),
        };
      }
    } catch (err) {
      crashRecovery = { ...crashRecovery, note: `异常：${err instanceof Error ? err.message : String(err)}` };
    }
    console.log("[e2e] 崩溃恢复:", JSON.stringify(crashRecovery));

    // 恢复边界（第 13 轮复核）：
    // ① 撤销回磁盘态（编辑内容回到与磁盘一致）→ 残留 journal 不应在下一次检测中误报为可恢复条目；
    // ② 恢复面板条目失效（进入项目后该章又被编辑并保存 → journal 已被保存清除）→
    //    点击「恢复」不得把过期内容载入编辑器并自动保存、覆盖更新版本的正文。
    const revertProbeScript = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 8000) => {
        const t0 = Date.now();
        for (;;) {
          let r = null;
          try { r = await fn(); } catch { r = null; }
          if (r) return r;
          if (Date.now() - t0 > timeout) return null;
          await sleep(50);
        }
      };
      const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null));
      if (!view) return { ok: false, note: '编辑器未就绪' };
      const original = view.state.doc.toString();
      const marker = '撤销回退验证：孤帆远影。';
      const dispatchAt = Date.now();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n' + marker } });
      const seen = await waitFor(async () => {
        const entries = await window.yushu.recovery.list();
        return entries.some((e) => String(e.body).includes(marker)) ? true : null;
      }, 5000);
      if (!seen) return { ok: false, marker, note: '编辑日志未在预期时间内检出' };
      const revertAt = Date.now();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
      const cleared = await waitFor(async () => {
        const entries = await window.yushu.recovery.list();
        return entries.length === 0 ? true : null;
      }, 5000);
      return { ok: cleared === true, marker, seenMs: revertAt - dispatchAt, cleared: cleared === true, reverted: view.state.doc.toString() === original };
    })()`;
    let recoveryEdge = { revertCleared: false, revertNote: "未执行", staleBlocked: false, staleNote: "未执行" };
    try {
      const probeA2 = (await win.webContents.executeJavaScript(revertProbeScript)) as {
        ok: boolean;
        marker?: string;
        cleared?: boolean;
        reverted?: boolean;
        seenMs?: number;
        note?: string;
      };
      const chapterAfterRevert = await readFile(join(dir, result.chapterPath), "utf8");
      const markerNotSaved = probeA2.marker ? !chapterAfterRevert.includes(probeA2.marker) : false;
      recoveryEdge = {
        ...recoveryEdge,
        revertCleared: probeA2.cleared === true && probeA2.reverted === true && markerNotSaved,
        revertNote:
          `撤销回退 → journal 清理=${probeA2.cleared === true}；内容已还原=${probeA2.reverted === true}；磁盘未含标记=${markerNotSaved}` +
          `（journal 检出耗时 ${probeA2.seenMs ?? -1}ms）` +
          (probeA2.note ? `；脚本：${probeA2.note}` : ""),
      };

      // ② 失效条目：直接写入 journal（模拟崩溃残留）→ reload 出现恢复面板 → 清除 journal（模拟"该章随后被保存"）→ 点「恢复」
      const { ProjectGateway } = await import("./file-gateway.js");
      const { writeRecoveryJournal, clearRecoveryJournal } = await import("./recovery-ops.js");
      const { readChapterFile } = await import("@yushu/world-engine");
      const gateway = new ProjectGateway(dir);
      const chapterNow = await readFile(join(dir, result.chapterPath), "utf8");
      const staleMarker = "失效条目验证：旧雪故人。";
      const staleBody = `${readChapterFile(chapterNow).body}\n\n${staleMarker}`;
      await writeRecoveryJournal(gateway, { path: result.chapterPath, body: staleBody });
      const reloaded3 = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      win.webContents.reload();
      await reloaded3;
      await win.webContents.executeJavaScript("window.__yushuDebug = true;");
      const listProbe = (await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 200; i += 1) {
          const banner = document.querySelector('.recovery-banner');
          if (banner && banner.querySelectorAll('li').length > 0) return { listed: true, count: banner.querySelectorAll('li').length };
          await sleep(100);
        }
        return { listed: false, count: 0 };
      })()`)) as { listed: boolean; count: number };
      // 模拟：该章随后被编辑并保存（保存成功会清除 journal；面板状态此时已是过期快照）
      await clearRecoveryJournal(gateway, result.chapterPath);
      const clickProbe = (await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const banner = document.querySelector('.recovery-banner');
        const button = banner ? [...banner.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复') : null;
        if (!button) return { clicked: false, entryGone: false };
        button.click();
        for (let i = 0; i < 60; i += 1) {
          const b = document.querySelector('.recovery-banner');
          if (!b || b.querySelectorAll('li').length === 0) return { clicked: true, entryGone: true };
          await sleep(100);
        }
        return { clicked: true, entryGone: false };
      })()`)) as { clicked: boolean; entryGone: boolean };
      // 若有"过期恢复"路径：自动保存（800ms）应已把过期内容写入磁盘——等待其窗口后断言
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const chapterAfterStale = await readFile(join(dir, result.chapterPath), "utf8");
      const staleNotPersisted = !chapterAfterStale.includes(staleMarker);
      recoveryEdge = {
        ...recoveryEdge,
        staleBlocked: listProbe.listed && clickProbe.clicked && clickProbe.entryGone && staleNotPersisted,
        staleNote:
          `失效条目：面板列出=${listProbe.listed}；点击恢复=${clickProbe.clicked}；条目移除=${clickProbe.entryGone}；` +
          `过期内容未落盘=${staleNotPersisted}`,
      };
    } catch (err) {
      recoveryEdge = {
        ...recoveryEdge,
        revertNote: `${recoveryEdge.revertNote}；异常：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    console.log("[e2e] 恢复边界:", JSON.stringify(recoveryEdge));

    // 本地快照（T2-7 切片 A）：手动快照 → 误改 / 误删 / 快照后新增 → 整体回滚 → 文件级取证。
    // 说明：源文件改动经主进程直接写盘（模拟外部工具误操作）；快照与回滚经渲染层 IPC（覆盖 preload/api 链路）。
    let snapshotProbe = {
      takeOk: false,
      restored: false,
      cardRecreated: false,
      extraKept: false,
      preRestore: false,
      note: "未执行",
    };
    try {
      const take = (await win.webContents.executeJavaScript("window.yushu.snapshot.take()")) as {
        outcome: string;
        snapshot?: { id: string; files: number; reason: string };
      };
      const snapId = take.snapshot?.id ?? "";
      const chapterBefore = await readFile(join(dir, result.chapterPath), "utf8");
      // 误改：正文被外部工具追加了不该有的段落
      await writeFile(join(dir, result.chapterPath), `${chapterBefore}\n\n误改段落。`, "utf8");
      // 误删：角色设定卡文件被删除
      await rm(join(dir, result.cardPath), { force: true });
      // 快照后新增：整体回滚时应保守保留
      await writeFile(join(dir, "world", "extra-note.md"), "快照之后新增。", "utf8");
      const restore = (await win.webContents.executeJavaScript(
        `window.yushu.snapshot.restore(${JSON.stringify(snapId)})`,
      )) as {
        id: string;
        preRestoreId: string;
        preRestoreTaken: boolean;
        restoredFiles: number;
        recreatedFiles: number;
        extraFiles: string[];
      };
      const chapterAfter = await readFile(join(dir, result.chapterPath), "utf8");
      const cardBack = await readFile(join(dir, result.cardPath), "utf8")
        .then(() => true)
        .catch(() => false);
      const extraKept = await readFile(join(dir, "world", "extra-note.md"), "utf8")
        .then(() => true)
        .catch(() => false);
      const state = (await win.webContents.executeJavaScript("window.yushu.snapshot.state()")) as {
        snapshots: { id: string; reason: string }[];
      };
      snapshotProbe = {
        takeOk: take.outcome === "taken" && snapId !== "",
        restored: restore.id === snapId && chapterAfter === chapterBefore && !chapterAfter.includes("误改段落。"),
        cardRecreated: cardBack && restore.recreatedFiles >= 1,
        extraKept: extraKept && restore.extraFiles.includes("world/extra-note.md"),
        preRestore:
          restore.preRestoreId !== "" &&
          state.snapshots.some((item) => item.id === restore.preRestoreId && item.reason === "pre_restore"),
        note:
          `快照生成=${take.outcome === "taken"}（${take.snapshot?.files ?? 0} 文件）；回滚命中=${restore.id === snapId}；` +
          `正文写回=${chapterAfter === chapterBefore}；被删卡重建=${cardBack}（重建数 ${restore.recreatedFiles}）；` +
          `快照后新增保守保留=${extraKept}（列出 ${restore.extraFiles.length}）；恢复前快照=${restore.preRestoreId || "(无)"}`,
      };
    } catch (err) {
      snapshotProbe = { ...snapshotProbe, note: `异常：${err instanceof Error ? err.message : String(err)}` };
    }
    console.log("[e2e] 本地快照:", JSON.stringify(snapshotProbe));

    // 三方自动合并（T2-6 完整版）：外部改动（开头）+ 本地续写（结尾，不同区域）→ 自动保存遇
    // baseHash 冲突 → 自动三方合并写回（无需人工）。断言：状态含「已自动合并」、磁盘双方改动
    // 均在、编辑器已同步为合并结果、自动保存未冻结（回到「已自动保存」）、未新增旁路文件。
    let mergeProbe = { ok: false, note: "未执行" };
    try {
      const probe = (await win.webContents.executeJavaScript(`(async () => {
        const api = window.yushu;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, timeout = 12000) => {
          const t0 = Date.now();
          for (;;) {
            let r = null;
            try { r = fn(); } catch { r = null; }
            if (r) return r;
            if (Date.now() - t0 > timeout) return null;
            await sleep(100);
          }
        };
        const tab = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('编辑器'));
        if (!tab) return { ok: false, note: '找不到编辑器标签页' };
        tab.click();
        const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null));
        const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
        if (!view || !ie) return { ok: false, note: '编辑器未就绪（调试句柄未暴露或章节未加载）' };
        await ie.reload();
        const srcBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('源码'));
        if (srcBtn && !srcBtn.disabled) { srcBtn.click(); await sleep(300); }
        const drafts = await api.ai.drafts();
        const path = drafts[0] && drafts[0].chapterPath;
        if (!path) return { ok: false, note: '无草稿章节' };
        const localMarker = '本地续写（自动合并探针）。';
        const remoteMarker = '【外部开头改动】';
        const before = await api.chapter.read(path);
        const sidecarsBefore = (await api.project.tree()).filter((e) => e.path.includes('.conflict-')).length;
        // 外部改动先行（不同区域：开头插入一行），再本地追加 → 自动保存必然撞 baseHash
        await api.chapter.write({ path, body: remoteMarker + '\\n\\n' + before.body, baseHash: before.hash });
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n' + localMarker } });
        const merged = await waitFor(() => {
          const el = document.querySelector('.autosave-status');
          return el && el.textContent.includes('已自动保存') && document.body.innerText.includes('已自动合并外部改动') ? true : null;
        }, 15000);
        const after = await api.chapter.read(path);
        const bothKept = after.body.includes(remoteMarker) && after.body.includes(localMarker);
        const editorText = String(view.state.doc.toString());
        const editorSynced = editorText.includes(remoteMarker) && editorText.includes(localMarker);
        const statusEl = document.querySelector('.autosave-status');
        const notFrozen = statusEl ? !statusEl.textContent.includes('暂停') : false;
        const sidecarsAfter = (await api.project.tree()).filter((e) => e.path.includes('.conflict-')).length;
        return {
          ok: merged === true && bothKept && editorSynced && notFrozen && sidecarsAfter === sidecarsBefore,
          note: '自动合并完成=' + (merged === true) + '；磁盘含双方改动=' + bothKept +
            '；编辑器已同步合并结果=' + editorSynced + '；自动保存未冻结=' + notFrozen +
            '；未新增旁路文件=' + (sidecarsAfter === sidecarsBefore),
        };
      })()`)) as { ok?: boolean; note?: string };
      mergeProbe = { ok: probe?.ok === true, note: String(probe?.note ?? "(无返回)") };
    } catch (err) {
      mergeProbe = { ok: false, note: `执行失败：${err instanceof Error ? err.message : String(err)}` };
    }
    console.log("[e2e] 三方自动合并:", JSON.stringify(mergeProbe));

    const closeProbeScript = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 12000) => {
        const t0 = Date.now();
        for (;;) {
          let r = null;
          try { r = fn(); } catch { r = null; }
          if (r) return r;
          if (Date.now() - t0 > timeout) return null;
          await sleep(100);
        }
      };
      const tabs = await waitFor(() => (document.querySelectorAll('.tab').length > 0 ? [...document.querySelectorAll('.tab')] : null), 15000);
      if (!tabs) return { ok: false, note: '项目页标签未出现：' + document.body.innerText.slice(0, 160).split('\\n').join(' | ') };
      const tab = tabs.find((x) => x.textContent.includes('编辑器'));
      if (!tab) return { ok: false, note: '找不到编辑器标签页' };
      tab.click();
      const view = await waitFor(() => (window.__yushuCmView && window.__yushuCmView.state.doc.length > 0 ? window.__yushuCmView : null));
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!view || !ie) return { ok: false, note: '编辑器未就绪（调试句柄未暴露或章节未加载）' };
      await ie.reload();
      const marker = '关闭前 flush 验证：断桥残雪。';
      const dispatchAt = Date.now();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n\\n' + marker } });
      return { ok: true, marker, dispatchAt };
    })()`;
    let closeFlush = { ok: false, withinDebounce: false, sinceDispatchMs: -1, note: "未执行" };
    try {
      const probe = (await win.webContents.executeJavaScript(closeProbeScript)) as {
        ok: boolean;
        marker?: string;
        dispatchAt?: number;
        note?: string;
      };
      if (!probe.ok || typeof probe.dispatchAt !== "number" || !probe.marker) {
        closeFlush = { ...closeFlush, note: probe.note ?? "预置脚本失败" };
      } else {
        const marker = probe.marker;
        const closed = new Promise<void>((resolve) => win.once("closed", () => resolve()));
        win.close();
        await closed;
        const sinceDispatchMs = Date.now() - probe.dispatchAt;
        const chapterContent = await readFile(join(dir, result.chapterPath), "utf8");
        const hasMarker = chapterContent.includes(marker);
        closeFlush = {
          ok: hasMarker,
          withinDebounce: sinceDispatchMs < 800,
          sinceDispatchMs,
          note: `输入→closed ${sinceDispatchMs}ms（<800ms 自动保存防抖窗口）；重新读盘含标记=${hasMarker}`,
        };
      }
    } catch (err) {
      closeFlush = { ...closeFlush, note: `异常：${err instanceof Error ? err.message : String(err)}` };
    }
    console.log("[e2e] 关闭前 flush:", JSON.stringify(closeFlush));

    // A2 端点计数（脚本跑完后读）：坏端点被试过并全程 503，好端点恰好承接两次动作
    const a2Endpoints = {
      badHits: mockBad.stats.hits,
      badFailures: mockBad.stats.failures,
      goodHits: mockGood.stats.hits,
      goodFailures: mockGood.stats.failures,
    };
    console.log("[e2e] A2 端点计数:", JSON.stringify(a2Endpoints));

    const ok =
      result.ready &&
      result.cards === 2 &&
      result.worldTitle === "天启界" &&
      result.cardPath.startsWith("world/cards/character/") &&
      result.readBack === "林渊" &&
      result.templateId === "xuanhuan-xitong/three-act-upgrade" &&
      result.outlineVolumes === 3 &&
      result.outlineChapters === 6 &&
      result.chapterPath.startsWith("chapters/vol-") &&
      result.chapterOutlineRef &&
      result.outlineExists &&
      result.mapped &&
      result.ai.configReady &&
      result.ai.configMigrated.formatVersion === 2 &&
      result.ai.configMigrated.kind === "local" &&
      result.ai.configMigrated.protocol === "openai_chat" &&
      result.ai.configMigrated.modelName === "legacy-model" &&
      result.ai.configProbe.formatVersion === 2 &&
      result.ai.configProbe.modelName === "mock-model" &&
      result.ai.configProbe.streamCap === true &&
      result.ai.configProbe.toolsCap === false &&
      result.ai.configProbe.contextLimit === 32768 &&
      migrationBackup.exists &&
      migrationBackup.hasLegacyV1 &&
      result.ai.routingProbe.exists &&
      result.ai.routingProbe.source === "config/routing.yaml" &&
      result.ai.routingProbe.draftingPrefer.join(",") === "flagship" &&
      result.ai.routingProbe.draftingRequire.join(",") === "stream" &&
      result.ai.routingProbe.fallbackDrafting.join(",") === "mock" &&
      result.ai.routingProbe.rateLimitRetries === 2 &&
      result.ai.routingProbe.cooldownS === 30 &&
      result.ai.routingProbe.concurrencyGlobal === 4 &&
      result.ai.presetProbe.migrationWarnings >= 1 &&
      result.ai.presetProbe.presetIds.join(",") === "ollama,lmstudio,llamacpp,vllm" &&
      result.ai.downgradeProbe.done &&
      result.ai.downgradeProbe.downgradeEvent &&
      result.ai.downgradeProbe.deltas === 1 &&
      result.ai.downgradeProbe.text === "非流式一次性回复" &&
      retryProbe.failures === 1 &&
      retryProbe.hits >= 2 &&
      result.ai.drafts === 1 &&
      result.ai.slots === 5 &&
      result.ai.stableChars > 0 &&
      result.ai.deltas === 3 &&
      result.ai.doneText === "天启界的夜色" &&
      result.ai.hinted >= 0 &&
      result.ai.adoptPath === result.chapterPath &&
      result.ai.adoptWords === 6 &&
      result.ai.chapterHasText &&
      result.ai.usageGenerate === 1 &&
      result.ai.usageAdopt === 1 &&
      result.exported.missingDrafts === 5 &&
      result.exported.chapters === 1 &&
      result.exported.reconcileMatched &&
      result.exported.errorHits >= 1 &&
      result.exported.hitTotal >= 1 &&
      result.exported.confirmMessage.includes("E_CONFIRM_REQUIRED") &&
      result.exported.path.startsWith("exports/") &&
      result.exported.words > 0 &&
      !result.exported.clean &&
      result.exported.hasToc &&
      result.exported.hasAiText &&
      result.exported.noComments &&
      result.exported.clipboardChapters === 1 &&
      result.exported.clipboardHasSensitiveText &&
      result.indexed.dbPath === ".yushu/index.db" &&
      result.indexed.exists &&
      result.indexed.files > 0 &&
      result.indexed.entities >= 1 &&
      result.indexed.chunks >= 3 &&
      result.indexed.ftsRows === result.indexed.chunks &&
      result.indexed.skipped === 0 &&
      result.indexed.shards >= 1 &&
      result.indexed.parseVia === "utility" &&
      result.indexed.progressOk &&
      result.indexed.progressShardsMatch &&
      result.indexed.searchEntities >= 1 &&
      result.indexed.searchChunks >= 1 &&
      result.indexed.snippetHasHit &&
      result.indexed.statusChunks === result.indexed.chunks &&
      result.naming.rulesId === "xianxia" &&
      result.naming.count === 4 &&
      result.naming.deterministic &&
      result.naming.allValid &&
      result.naming.placeCount === 3 &&
      result.library.chapters >= 6 &&
      result.library.drafted >= 1 &&
      result.library.words > 0 &&
      result.library.draftedPathOk &&
      result.chapter.readWords > 0 &&
      result.chapter.error === "" &&
      result.chapter.grew &&
      result.chapter.writeWords > result.chapter.readWords &&
      result.stats.todayDelta > 0 &&
      result.stats.todaySaves >= 1 &&
      result.stats.dailyDays >= 1 &&
      result.stats.todayEffective > 0 &&
      result.stats.speedPoints === 30 &&
      result.stats.tiers.basic === 4000 &&
      result.stats.tiers.advanced === 6000 &&
      result.statsActivity.sessions >= 1 &&
      result.statsActivity.activeMs >= 85_000 &&
      result.statsActivity.speedCpm !== null &&
      result.statsActivity.speedCpm > 0 &&
      result.pipeline.conflict === "E_DOC_CONFLICT" &&
      result.pipeline.sidecarOk &&
      result.pipeline.mainKeptExternal &&
      result.preDestructive.taken === 3 &&
      result.git.initiallyUninitialized === true &&
      result.git.initialized === true &&
      (result.git.baselineFiles ?? 0) >= 1 &&
      result.git.commit1Files === result.git.baselineFiles &&
      result.git.stagedChapter === true &&
      (result.git.commit2Files ?? 0) >= 1 &&
      (result.git.rollbackRestored ?? 0) >= 1 &&
      result.git.reverted === true &&
      result.git.preRestore === true &&
      result.git.headUnchanged === true &&
      result.git.pendingAfterRollback === true &&
      result.memory.candidateText === "非流式一次性回复" &&
      result.memory.notAutoSaved &&
      result.memory.aiRev === 0 &&
      result.memory.humanRev === 1 &&
      result.memory.rejectBlocked &&
      result.memory.factOk &&
      result.memory.factBroken &&
      result.memory.factDeleted &&
      result.memory.factGone &&
      result.injection.configPersisted &&
      result.injection.gatePersisted &&
      result.injection.hitEntry &&
      result.injection.missExcluded &&
      result.injection.manualExcluded &&
      result.injection.manualIncluded &&
      result.injection.gateOkIncluded &&
      result.injection.gateLaterExcluded &&
      result.injection.summaryAlways &&
      result.injection.chapterOrdinal === 1 &&
      result.injection.tokens > 0 &&
      result.assembly.slotOrder === "system_prompt>world_core>volume_summary>chapter_summary>triggered_cards>facts>rag_chunks>recent_prose" &&
      result.assembly.slots === 8 &&
      result.assembly.budget === 32000 &&
      result.assembly.totalTokens > 0 &&
      result.assembly.systemStable &&
      result.assembly.chapterSummary &&
      result.assembly.factsInjected &&
      result.assembly.recentProse &&
      result.assembly.dedupSimilar &&
      result.assembly.stableTokens > 0 &&
      result.assembly.smallBudget &&
      result.assembly.smallEvicted &&
      result.assembly.smallWithin &&
      result.assembly.smallKeepsSystem &&
      result.rag.autoQuery &&
      result.rag.storeNote &&
      (result.rag.store === "cosine" || result.rag.store === "sqlite-vec") &&
      result.rag.fused >= 1 &&
      result.rag.reranked >= 1 &&
      result.rag.reranked <= 6 &&
      result.rag.vectorHits >= 1 &&
      result.rag.keywordHits >= 1 &&
      result.rag.provenanceAll &&
      result.rag.chapterProvenance &&
      result.rag.fusedSorted &&
      result.rag.dualPath &&
      result.rag.rerankOk &&
      result.rag.slotStatus === "ok" &&
      result.rag.slotItems >= 1 &&
      result.rag.slotProvenance &&
      snapshotOk &&
      result.extract.total >= 3 &&
      result.extract.allCandidate &&
      result.extract.provenance &&
      result.extract.newOk &&
      result.extract.augmentOk &&
      result.extract.conflictOk &&
      result.extract.conflictBlocked &&
      result.extract.adoptPath.startsWith("world/cards/") &&
      result.extract.adoptedStatus &&
      result.extract.adoptedQuote &&
      result.extract.adoptedSource &&
      result.extract.downgrade.includes("prompt_constrained_json") &&
      result.extract.attempts === 1 &&
      result.extract.provider === "mock" &&
      result.ux.multiVaried &&
      result.ux.partialOk &&
      result.ux.feedbackHasShui &&
      result.ux.feedbackTotal >= 1 &&
      result.ux.channels.includes("extract:sync") &&
      result.ux.channelNote.includes("未声明 batch") &&
      result.ux.extractUsageChannel === "sync" &&
      // T3-12 Token 与成本（A3 机制取证：落盘 / 折算 / 分解 / 偏差 / 编排核对）
      result.cost.pricingKept &&
      result.cost.tokensRecorded >= 1 &&
      result.cost.estimateRecorded >= 1 &&
      result.cost.priced &&
      result.cost.costText.startsWith("¥") &&
      result.cost.promptTokens > 0 &&
      result.cost.aggregateEntries >= 2 &&
      result.cost.tasks.includes("summarize") &&
      result.cost.tasks.includes("extract") &&
      result.cost.models.includes("mock-model") &&
      result.cost.deviationText.includes("%") &&
      result.cost.cacheOrdered &&
      result.cost.cacheMisplaced === "" &&
      result.cost.cacheBreakpoint === "world_constraints#2" &&
      result.cost.cacheStableTokens > 0 &&
      result.cost.cacheDeclared === false &&
      result.cost.cacheWarn.includes("未声明 cache") &&
      result.cost.savingText.includes("不估算") &&
      result.cost.notes >= 5 &&
      result.cost.pricingFallback === 0 &&
      // R49 预算护栏与成本体检并入面板：坏配置外显、月度超支升 error、未跑规则进 skipped
      result.cost.budgetInvalid.includes("未知键") &&
      result.cost.budgetInvalidCode === "budget-config-invalid" &&
      result.cost.budgetKeepsCapNull &&
      result.cost.capSeverity === "error" &&
      result.cost.capSpent.startsWith("¥") &&
      result.cost.capMonthKey.length === 7 &&
      result.cost.noTargetSkipsOverflow &&
      result.cost.capSkippedCount >= 1 &&
      // T3-14 密钥安全（后端可用与不可用两条分支都必须诚实通过）
      result.security.ok &&
      result.security.plaintextBlocked.includes("明文") &&
      result.security.restoredOk &&
      // T3-13 中文自查（只读、未确认不改、繁简候选须选定）
      result.proofread.ok &&
      result.proofread.diskUnchanged &&
      result.proofread.spansOk &&
      result.proofread.error === "" &&
      // A2 任务路由（离线那一半）：旗舰端点失败 → 回落小模型端点出文；冷却跳过坏端点；一次动作一条记录
      result.routingA2.ok &&
      result.routingA2.firstProvider === "small-good" &&
      result.routingA2.secondProvider === "small-good" &&
      result.routingA2.cooldownSeen &&
      result.routingA2.recordsDelta === 3 &&
      result.routingA2.promptTokensDelta === 30 &&
      result.routingA2.summarizeOk &&
      result.routingA2.error === "" &&
      // A4：AI 关闭后三个 LLM 入口全被拒、本地能力零失败，且端点计数不增长（未发出任何请求）
      result.aiOff.ok &&
      result.aiOff.localFailed.length === 0 &&
      result.aiOff.error === "" &&
      a2Endpoints.badHits === 3 &&
      a2Endpoints.badFailures === 3 &&
      a2Endpoints.goodHits === 3 &&
      a2Endpoints.goodFailures === 0 &&
      // 端点计数的**最终值**恰好停在 A2 的 3/3：A4 关闸后的三连击与本地能力电池
      // 一个请求都没发出（任一次泄漏都会让 goodHits 涨到 4+ 或 badHits 涨到 4+）
      a2Endpoints.badHits === 3 &&
      a2Endpoints.goodHits === 3 &&
      crossProject.rejectedIds.includes("fact-foreign") &&
      crossProject.errorCodes.includes("memory-cross-project-leak") &&
      !crossProject.factIds.includes("fact-foreign") &&
      sessionProbe.ok &&
      result.incremental.mode === "incremental" &&
      result.incremental.updated === 1 &&
      result.incremental.reused === result.indexed.files - 1 &&
      result.incremental.removed === 0 &&
      result.incremental.issues === 0 &&
      result.incremental.hit >= 1 &&
      result.incremental.parseVia === "utility" &&
      result.incremental.filesKeep &&
      result.autoIndex.hit >= 1 &&
      result.autoIndex.lastRunAt !== null &&
      switchFlush.ok &&
      switchFlush.withinDebounce &&
      crashRecovery.journalDetected &&
      crashRecovery.diskNotSavedYet &&
      crashRecovery.bannerShown &&
      crashRecovery.restoredInEditor &&
      crashRecovery.persisted &&
      crashRecovery.journalCleared &&
      recoveryEdge.revertCleared &&
      recoveryEdge.staleBlocked &&
      snapshotProbe.takeOk &&
      snapshotProbe.restored &&
      snapshotProbe.cardRecreated &&
      snapshotProbe.extraKept &&
      snapshotProbe.preRestore &&
      mergeProbe.ok &&
      closeFlush.ok &&
      closeFlush.withinDebounce;
    console.log(
      ok
        ? "[e2e] 通过：建项目 → 设定卡 → 大纲 → 草稿章节 → AI Provider v2 能力矩阵（v1 迁移 + 备份）→ 任务路由与 429 退避重试（T3-2）→ 能力降级为一次性返回与本地预设（T3-3/T3-4）→ AI 流式生成 → 采纳 → 五层记忆（摘要候选不入库 / AI 入库 rev0 / 人工修订 rev1 后 AI 覆盖被拒 / 事实出处链失效检出 / 跨项目泄漏拒绝，T3-5）→ 注入控制（trigger 命中 / manual 清单 / reveal_gate 门控 / 摘要常驻 + token 估算，T3-6）→ 上下文组装（固定槽位顺序 / 去重 / 小预算逐出 + 稳定前缀保留，T3-7）→ RAG 混合检索（向量 + bm25 双路 / RRF 融合 / 重排 top-6 / 出处 chapter_id + 区间 + hash 进 rag_chunks 槽位，T3-8）→ 上下文预览器（逐条「槽位 / 来源 / Token / 命中键 / 截断」+ 可复现快照导出（指纹一致），T3-9）→ 设定抽取（JSON Schema 契约 + 后校验 + 三分类（新增/补充/冲突）；候选一律 candidate；仅新增可采纳入库、冲突被拒，T3-10）→ 写作 UX（多候选独立生成 / 句级 diff 与局部采纳 / 拒绝原因记录 / 半价通道规划与记账，T3-11）→ Token 与成本（usage 实报与发送前估算双口径落盘、按任务/模型可分解、折算金额与预估vs实付偏差、稳定前缀置头与缓存断点核对，T3-12）→ 密钥安全（加密保存后明文不落盘、真源只记 key_ref、后端不可用即拒存、含明文 llm.yaml 被 error 阻断，T3-14）→ 中文自查（别字与半角标点给候选、未确认不改稿、修复不写盘、繁简歧义须选定候选，T3-13）→ 任务路由回落与冷却（旗舰端点全程 503 时由小模型端点出文、第二次动作跳过冷却端点、一次动作只记一条 usage，A2 离线半）→ 编辑器写正文（字数同步）→ 导出对账 → 敏感词自查 → 干净剪贴板 → 索引重建与检索 → 索引增量与自愈 → 保存即增量（自动刷新）→ 命名生成 → 冲突拒绝与旁路文件 → 切页落盘与关闭前 flush（防丢稿）→ 崩溃恢复（编辑日志 → 恢复面板 → 落盘）→ 恢复边界（撤销回卷 / 失效条目）→ 本地快照（内容寻址 → 整体回滚）→ 三方自动合并（外部改动 + 本地续写，无人工）→ 码字统计（净增 / 有效字数 / 节奏曲线）→ 破坏前快照（删卷 / 删章 / 采纳替换）→ 会话异常退出检测（pid 守卫 / 心跳 / 正常关闭不误报） 全链路成功"
        : "[e2e] 失败：断言未满足",
    );
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    mock.server.close();
    mockBad.server.close();
    mockGood.server.close();
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[e2e] 执行失败:", err);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    mock.server.close();
    mockBad.server.close();
    mockGood.server.close();
    app.exit(1);
  }
}

app.on("window-all-closed", () => {
  if (autoQuitDisabled) return;
  if (process.platform !== "darwin") app.quit();
});