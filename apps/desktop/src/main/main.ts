import { BrowserWindow, app } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc.js";
import { appRoot } from "./paths.js";
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
    },
  });

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
    const win = createWindow();
    win.webContents.on("did-finish-load", () => {
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
        void runWalkthrough(win, context);
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function runE2E(win: BrowserWindow): Promise<void> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "yushu-e2e-"));
  const mock = await startMockOpenAI();
  const payload = JSON.stringify({ dir, baseUrl: mock.baseUrl });
  const script = `(async () => {
    const api = window.yushu;
    const { dir, baseUrl } = ${payload};
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

    // AI 副驾全链路：配置 → 上下文预览 → 流式生成（含中止能力）→ 采纳 → 使用记录
    const savedConfig = await api.ai.saveConfig({ providers: [{ id: "mock", kind: "openai-compatible", base_url: baseUrl, model: "mock-model" }] });
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

    // 检索索引全链路：重建（.yushu/index.db）→ 中文全文检索 + 实体检索 → 状态回读
    const indexRebuild = await api.index.rebuild();
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
    };

    // 命名生成器（T1-8）：本地离线 + 种子可复现
    const naming = await api.naming.generate({ kind: "character", seed: "e2e", count: 4 });
    const namingAgain = await api.naming.generate({ kind: "character", seed: "e2e", count: 4 });
    const namingPlace = await api.naming.generate({ kind: "place", count: 3 });

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
    return {
      packs: catalog.packs.length, ready: preview.ready, root: snap.root, cards: list.length,
      worldTitle: world && world.title, cardPath: card.path, readBack: doc.card.name,
      templateId: template.id, outlineVolumes: generated.doc.volumes.length,
      outlineChapters: generated.doc.volumes.reduce((n, v) => n + v.chapters.length, 0),
      chapterPath: draft.chapterPath, chapterOutlineRef: chapterDoc.content.includes("outline_ref: " + co.id),
      outlineExists: reread.exists, mapped: reread.doc.volumes[0].chapters[0].chapter_id === draft.chapterId,
      ai: {
        configReady: savedConfig.canGenerate,
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
      },
      naming: {
        rulesId: naming.rulesId,
        count: naming.names.length,
        deterministic: JSON.stringify(naming.names) === JSON.stringify(namingAgain.names),
        allValid: naming.names.every((name) => name.length >= 2),
        placeCount: namingPlace.names.length,
      },
      chapter: {
        readWords: chapterInfo.readWords,
        writeWords: chapterInfo.writeWords,
        grew: chapterInfo.grew,
        error: chapterInfo.error,
      },
      incremental,
      pipeline,
    };
  })()`;
  try {
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
      };
      naming: {
        rulesId: string;
        count: number;
        deterministic: boolean;
        allValid: boolean;
        placeCount: number;
      };
      chapter: {
        readWords: number;
        writeWords: number;
        grew: boolean;
        error: string;
      };
      incremental: {
        mode: string;
        reused: number;
        updated: number;
        removed: number;
        issues: number;
        hit: number;
        filesKeep: boolean;
      };
      pipeline: {
        conflict: string;
        sidecarOk: boolean;
        mainKeptExternal: boolean;
      };
    };
    console.log("[e2e] 结果:", JSON.stringify(result));
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
      result.indexed.searchEntities >= 1 &&
      result.indexed.searchChunks >= 1 &&
      result.indexed.snippetHasHit &&
      result.indexed.statusChunks === result.indexed.chunks &&
      result.naming.rulesId === "xianxia" &&
      result.naming.count === 4 &&
      result.naming.deterministic &&
      result.naming.allValid &&
      result.naming.placeCount === 3 &&
      result.chapter.readWords > 0 &&
      result.chapter.error === "" &&
      result.chapter.grew &&
      result.chapter.writeWords > result.chapter.readWords &&
      result.pipeline.conflict === "E_DOC_CONFLICT" &&
      result.pipeline.sidecarOk &&
      result.pipeline.mainKeptExternal &&
      result.incremental.mode === "incremental" &&
      result.incremental.updated === 1 &&
      result.incremental.reused === result.indexed.files - 1 &&
      result.incremental.removed === 0 &&
      result.incremental.issues === 0 &&
      result.incremental.hit >= 1 &&
      result.incremental.filesKeep;
    console.log(
      ok
        ? "[e2e] 通过：建项目 → 设定卡 → 大纲 → 草稿章节 → AI 流式生成 → 采纳 → 编辑器写正文（字数同步）→ 导出对账 → 敏感词自查 → 干净剪贴板 → 索引重建与检索 → 索引增量与自愈 → 命名生成 → 冲突拒绝与旁路文件 全链路成功"
        : "[e2e] 失败：断言未满足",
    );
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    mock.server.close();
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[e2e] 执行失败:", err);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    mock.server.close();
    app.exit(1);
  }
}

app.on("window-all-closed", () => {
  if (autoQuitDisabled) return;
  if (process.platform !== "darwin") app.quit();
});