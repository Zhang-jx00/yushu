/* SPDX-License-Identifier: Apache-2.0 */
import { promises as fs } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { attachProject } from "./ipc.js";
import { comparePerfMetrics, summarizePerfGate } from "./perf-compare.js";
import { summarizeRendererBoot, type RendererTimingRaw } from "./perf-boot.js";
import { BUDGETS } from "./perf-budgets.js";
import { ensureSynthFixture } from "./perf-fixture.js";

/**
 * 性能实测探针（M2 / T2-10；`pnpm --filter @yushu/desktop perf-test`）：
 * 在真实 Electron 里对 synth-1m 百万字夹具跑一遍性能预算指标（perf-budget.yaml），
 * 输出 PERF_RESULT JSON（终端 + 夹具目录 `.yushu/perf-report.json`）；
 * 报告内含与「上一次同夹具报告」的逐项回归对比（T2-10 遗留：diff 防退化，超阈值标记 ⚠）。
 *
 * **退出码即门禁（R83 补）**：预算全部达标且无超阈回退 ⇒ 0；否则 1 并在终端点名
 * `未达预算=[…] 超阈回退=[…]`。此前这里恒 `exit(0)`——`checks` 算得出 false、❌ 也打得出来，
 * 但调用方拿到的仍是"跑通了"，等于一条不会红的门禁（同族教训见 docs/06 §八 第 59、81 轮）。
 *
 * 口径（首版基线，如实标注）：
 * - cold_to_editable_ms：探针进程入口（模块加载时间戳）→ 编辑器可输入（首章挂载完成）；
 *   Electron 自身 bootstrap（约百 ms 级）不在内——相对进程 spawn 略保守，后续可校准；
 * - hot_to_editable_ms：渲染层 reload → 编辑器可输入（**热重载口径**，非二次进程启动）；
 * - project_open_ms：reload → 项目页可见（含 listTree 遍历百万字项目文件）；
 * - keystroke_p95_ms：常规单章连续 200 次「输入 → 下一帧」p95（含一帧调度，如实口径）；
 *   另附 sync p95（仅事务处理）与大章口径（T2-4 靶子，非门禁）；
 * - save_to_indexed_ms：改一章 → 增量重建耗时（不含自动刷新 2.5s 防抖排队；另记写入耗时）；
 * - query_p95_ms：10 个关键词共 50 次查询 p95；rebuild_cpm：全量重建吞吐（字/分钟，下限）；
 * - *_rss_mb：Electron 全部进程 working set 合计（项目空闲 / 打开大章）。
 */

/** 进程内最早时间戳（模块加载即记录；冷启动口径起点） */
export const PERF_PROCESS_T0 = Date.now();

export interface PerfProbeDeps {
  dirArg: string;
  createWindow: () => BrowserWindow;
}

/**
 * 渲染层首屏计时（R83）：在页面里读 Performance API 的 navigation / paint 条目。
 * 口径起点是**渲染进程自己的导航起点**（不是探针进程入口），所以它和 cold_to_editable_ms
 * 不能相加、也不能互相替换——两条轴各自独立看。
 */
const BOOT_TIMING_SCRIPT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  const findPaint = (name) => {
    const hit = paints.find((entry) => entry.name === name);
    return hit ? hit.startTime : null;
  };
  return {
    hasNavigation: Boolean(nav),
    responseEnd: nav ? nav.responseEnd : 0,
    domContentLoadedStart: nav ? nav.domContentLoadedEventStart : 0,
    firstPaint: findPaint('first-paint'),
    firstContentfulPaint: findPaint('first-contentful-paint')
  };
})()`;

/** 门禁值：住在 `perf-budgets.ts`（R83 搬出，配 perf-budget-sync.test.ts 与 perf-budget.yaml 双向对账） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询渲染层布尔条件（页面 reload 期间 executeJavaScript 会抛，吞掉继续等） */
async function waitForJs(win: BrowserWindow, expression: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await win.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false);
    if (ok === true) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待渲染层条件超时（${timeoutMs}ms）：${expression}`);
    }
    await sleep(50);
  }
}

async function clickTab(win: BrowserWindow, label: string): Promise<void> {
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.tab')].find((node) => node.textContent.includes(${JSON.stringify(label)}));
    if (!button) throw new Error('找不到标签页：' + ${JSON.stringify(label)});
    button.click();
  })()`);
}

/** Electron 全部进程 working set 合计（MB） */
function rssMb(): number {
  const kb = app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
  return Math.round(kb / 1024);
}

/** 按键延迟测量脚本（真实 CodeMirror 事务；sync = 事务处理，frame = 到下一帧） */
function keystrokeScript(rounds: number): string {
  return `(async () => {
    const view = window.__yushuCmView;
    if (!view) return { ok: false };
    const sync = [];
    const frames = [];
    for (let i = 0; i < ${rounds}; i += 1) {
      const t0 = performance.now();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '的' } });
      const t1 = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const t2 = performance.now();
      sync.push(t1 - t0);
      frames.push(t2 - t0);
    }
    const p95 = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    };
    return { ok: true, docLen: view.state.doc.length, syncP95: p95(sync), frameP95: p95(frames) };
  })()`;
}

/** 索引 / 检索测量脚本（全量重建吞吐 → 改一章 → 增量 → 检索 p95） */
function indexScript(chapterPath: string): string {
  return `(async () => {
    const api = window.yushu;
    const now = () => performance.now();
    const full = { ms: 0, files: 0, chunks: 0 };
    {
      const t0 = now();
      const result = await api.index.rebuild();
      full.ms = now() - t0;
      full.files = result.stats.files;
      full.chunks = result.stats.chunks;
    }
    const before = await api.chapter.read(${JSON.stringify(chapterPath)});
    const t1 = now();
    await api.chapter.write({ path: before.path, body: before.body + "\\n\\n性能探针标记。", baseHash: before.hash });
    const writeMs = now() - t1;
    let incMs = 0;
    let incUpdated = -1;
    {
      const t2 = now();
      const result = await api.index.rebuild({ incremental: true });
      incMs = now() - t2;
      incUpdated = result.updatedFiles;
    }
    const keywords = ["性能", "样本", "大章", "法则", "主角", "第 1 章", "卷", "章", "夹具", "测试"];
    const queries = [];
    for (let i = 0; i < 50; i += 1) {
      const t3 = now();
      await api.index.search(keywords[i % keywords.length]);
      queries.push(now() - t3);
    }
    queries.sort((a, b) => a - b);
    const queryP95 = queries[Math.min(queries.length - 1, Math.ceil(queries.length * 0.95) - 1)];
    return { fullMs: full.ms, files: full.files, chunks: full.chunks, writeMs, incMs, incUpdated, queryP95 };
  })()`;
}

export async function runPerfProbe(deps: PerfProbeDeps): Promise<void> {
  const dir = deps.dirArg.trim() || join(tmpdir(), "yushu-perf-synth1m");
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);

  // ① 夹具（synth-1m；含 10 万字大章靶子）
  const fixture = await ensureSynthFixture({ dir, megaChars: 100_000 });
  console.log(
    `[perf] 夹具${fixture.reused ? "已复用" : "已生成"}：${fixture.volumes} 卷 / ${fixture.chapters} 章 / ` +
      `${fixture.totalChars.toLocaleString("zh-CN")} 字（生成/扫描 ${fixture.elapsedMs}ms）；目录 ${dir}`,
  );
  if (fixture.megaPath) console.log(`[perf] 大章靶子：${fixture.megaPath}`);

  // ② 冷启动：挂载 → 窗口 → 编辑器可输入
  await attachProject(dir);
  const win = deps.createWindow();
  await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  await win.webContents.executeJavaScript("window.__yushuDebug = true;");
  await waitForJs(win, "document.querySelectorAll('.tab').length > 0", 30_000);
  // R83：首屏的"脚本执行"与"首次内容绘制"单独取出来——这是判断"要不要按标签页拆包"的依据，
  // 必须在**点进编辑器之前**读（否则量到的是切页后的重绘，不是首屏）。
  const bootRaw = (await win.webContents
    .executeJavaScript(BOOT_TIMING_SCRIPT)
    .catch(() => null)) as RendererTimingRaw | null;
  const boot = summarizeRendererBoot(
    bootRaw ?? {
      hasNavigation: false,
      responseEnd: 0,
      domContentLoadedStart: 0,
      firstPaint: null,
      firstContentfulPaint: null,
    },
  );
  await clickTab(win, "编辑器");
  await waitForJs(win, "window.__yushuCmView && window.__yushuCmView.state.doc.length > 0", 30_000);
  const coldToEditableMs = Date.now() - PERF_PROCESS_T0;
  const idleRssMb = rssMb();

  // ③ 热重载：reload → 项目页可见 → 编辑器可输入（project_open / hot 口径）
  const tReload = Date.now();
  const reloaded = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  win.webContents.reload();
  await reloaded;
  await win.webContents.executeJavaScript("window.__yushuDebug = true;");
  await waitForJs(win, "document.querySelectorAll('.tab').length > 0", 30_000);
  const projectOpenMs = Date.now() - tReload;
  await clickTab(win, "编辑器");
  await waitForJs(win, "window.__yushuCmView && window.__yushuCmView.state.doc.length > 0", 30_000);
  const hotToEditableMs = Date.now() - tReload;

  // ④ 索引与检索（全量吞吐 / 改一章增量 / 查询 p95）
  await sleep(300); // 等 reload 后的异步加载（项目树 / 草稿列表）稳定
  const index = (await win.webContents.executeJavaScript(indexScript(fixture.firstChapterPath))) as {
    fullMs: number;
    files: number;
    chunks: number;
    writeMs: number;
    incMs: number;
    incUpdated: number;
    queryP95: number;
  };
  const rebuildCpm = Math.round(fixture.totalChars / (index.fullMs / 60_000));
  // 探针卫生：步骤④经渲染层 API 直接改写了「当前打开章节」的磁盘内容 → 编辑器 baseHash 已过期
  // （真实产品行为：外部改动 → 自动保存冻结 → 切章需用户确认）。这里强制重载编辑器刷新基线，
  // 避免后续按键 / 切章踩在"冲突冻结"路径上（那是 T2-6 的设计行为，不属于本探针的测量目标）。
  await win.webContents.executeJavaScript("window.__yushuEditorDebug && window.__yushuEditorDebug.reload()");
  await sleep(200);

  // ⑤ 按键延迟：常规单章（当前已载入首章）
  type KeystrokeResult = { ok: boolean; docLen: number; syncP95: number; frameP95: number };
  const normal = (await win.webContents.executeJavaScript(keystrokeScript(200))) as KeystrokeResult;
  if (!normal.ok) throw new Error("按键测量失败：编辑器视图未就绪");

  // ⑥ 按键延迟：大章（T2-4 靶子，非门禁）
  let mega: KeystrokeResult | null = null;
  if (fixture.megaPath) {
    const clicked = (await win.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.draft-list li')];
      const item = items.find((node) => node.textContent.includes('大章靶子'));
      if (!item) return { found: false, count: items.length };
      item.click();
      return { found: true, count: items.length };
    })()`)) as { found: boolean; count: number };
    if (!clicked.found) throw new Error(`草稿列表找不到大章（共 ${clicked.count} 项）`);
    try {
      await waitForJs(win, "window.__yushuCmView && window.__yushuCmView.state.doc.length > 20000", 30_000);
    } catch (err) {
      // 诊断快照（切章失败时定位：自动保存状态 / 当前选中 / 错误文本）
      const diag = (await win.webContents
        .executeJavaScript(`(() => ({
          docLen: window.__yushuCmView ? window.__yushuCmView.state.doc.length : -1,
          selected: document.querySelector('.draft-list li.on')?.textContent ?? '(无选中)',
          autosave: document.querySelector('.autosave-status')?.textContent ?? '',
          error: document.querySelector('.error-text')?.textContent ?? '',
        }))()`)
        .catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        `大章载入超时：${JSON.stringify(diag)}（原错误：${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    mega = (await win.webContents.executeJavaScript(keystrokeScript(200))) as KeystrokeResult;
  }
  const millionCharsRssMb = rssMb();

  // ⑦ 结果组装（对照预算）
  const metrics = {
    cold_to_editable_ms: coldToEditableMs,
    // R83 新增（**先记录、暂不进门禁**）：首屏脚本执行与首次内容绘制。
    // 本轮就是要用这两个数回答"1.5 MB 单包要不要拆"，所以它们进报告、进台账；
    // 预算值等这两个数在多台机器上有几个样本之后再定——现在就定，等于拿一次实测当契约。
    module_exec_ms: boot.module_exec_ms,
    fcp_ms: boot.fcp_ms,
    hot_to_editable_ms: hotToEditableMs,
    project_open_ms: projectOpenMs,
    // 门禁口径 = 输入处理延迟（sync，不含 vsync 帧调度；60Hz 下 frame 口径本底即 ~16.7ms）
    keystroke_p95_ms: Math.round(normal.syncP95 * 10) / 10,
    keystroke_frame_p95_ms: Math.round(normal.frameP95 * 10) / 10,
    keystroke_mega_p95_ms: mega ? Math.round(mega.syncP95 * 10) / 10 : null,
    keystroke_mega_frame_p95_ms: mega ? Math.round(mega.frameP95 * 10) / 10 : null,
    save_to_indexed_ms: Math.round(index.incMs),
    chapter_write_ms: Math.round(index.writeMs),
    query_p95_ms: Math.round(index.queryP95 * 10) / 10,
    index_rebuild_ms: Math.round(index.fullMs),
    rebuild_cpm: rebuildCpm,
    idle_rss_mb: idleRssMb,
    million_chars_rss_mb: millionCharsRssMb,
  };
  const checks = {
    cold_to_editable: coldToEditableMs <= BUDGETS.cold_to_editable_ms,
    hot_to_editable: hotToEditableMs <= BUDGETS.hot_to_editable_ms,
    project_open: projectOpenMs <= BUDGETS.project_open_ms,
    keystroke_p95: normal.syncP95 <= BUDGETS.keystroke_p95_ms,
    // 大章（~100k 字靶子）按键门禁（T2-4 切片 B 纳入）：超限视为大章性能回退
    keystroke_mega_p95: mega ? mega.syncP95 <= BUDGETS.keystroke_mega_p95_ms : false,
    save_to_indexed: index.incMs <= BUDGETS.save_to_indexed_ms,
    query_p95: index.queryP95 <= BUDGETS.query_p95_ms,
    rebuild_cpm: rebuildCpm >= BUDGETS.rebuild_cpm_min,
    idle_rss: idleRssMb <= BUDGETS.idle_rss_mb,
    million_chars_rss: millionCharsRssMb <= BUDGETS.million_chars_rss_mb,
  };
  // T2-10 遗留：回归对比基线 = 夹具目录中的上一次报告（同夹具同机同口径）；首次运行无基线则如实跳过
  const reportPath = join(dir, ".yushu", "perf-report.json");
  let previousReport: { date?: string; metrics?: Record<string, unknown> } | null = null;
  try {
    previousReport = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
      date?: string;
      metrics?: Record<string, unknown>;
    };
  } catch {
    /* 首次运行：无基线 */
  }
  const comparison = comparePerfMetrics(previousReport, { metrics });
  // R83：门禁结论必须在**这一处**被消费掉——此前 checks 算出来了、❌ 也打了，探针仍 exit(0)，
  // 于是"这轮跑过 perf 了"这句话并不保证性能没回退。现在绝对预算未达标 ⇒ 退出码 1。
  // 唯一排除项：夹具本轮刚生成时（冷盘首跑）的 cold_to_editable——同一份构建两遍实测
  // 3160ms（刚生成）vs 1434ms（已就位），冷读盘让这一项不可比；理由随报告外显，不静默跳过。
  const gate = summarizePerfGate(checks, comparison, {
    excluded: fixture.reused
      ? []
      : [{ name: "cold_to_editable", reason: "夹具本轮刚生成（冷盘首跑），该指标与就位后的运行不可比" }],
  });
  const report = {
    kind: "yushu-perf-probe/v1",
    date: new Date().toISOString(),
    fixture: {
      dir,
      reused: fixture.reused,
      volumes: fixture.volumes,
      chapters: fixture.chapters,
      totalChars: fixture.totalChars,
      megaPath: fixture.megaPath,
    },
    env: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      totalMemMb: Math.round(totalmem() / (1024 * 1024)),
    },
    metrics,
    budgets: BUDGETS,
    checks,
    // R83：首屏两项"只记录不门禁"，取不到时的原因必须随报告一起留档
    boot_notes: boot.notes,
    // R83：门禁结论随报告一起留档（退出码是它的搬运，留档里没有结论就等于"当时红过但没人知道"）
    gate,
    // T2-10 遗留：与「上一次同夹具报告」逐项对比（>阈值标记回退；无基线如实标注）
    comparison,
    indexFiles: index.files,
    indexChunks: index.chunks,
    incrementalUpdatedFiles: index.incUpdated,
  };

  await fs.mkdir(join(dir, ".yushu"), { recursive: true }).catch(() => undefined);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8").catch(() => undefined);

  console.log(`PERF_RESULT ${JSON.stringify(report)}`);
  console.log(`[perf] 报告已写入：${reportPath}`);
  console.log(`[perf] 达标情况：${Object.entries(checks).map(([k, v]) => `${k}=${v ? "✅" : "❌"}`).join("  ")}`);
  console.log(
    `[perf] 首屏（只记录，暂不进门禁）：module_exec=${String(boot.module_exec_ms ?? "未测")}ms ` +
      `fcp=${String(boot.fcp_ms ?? "未测")}ms${boot.notes.length > 0 ? `（${boot.notes.join("；")}）` : ""}`,
  );
  if (comparison.baselineDate) {
    const summary = comparison.rows
      .map(
        (row) =>
          `${row.metric}=${row.deltaPct > 0 ? "+" : ""}${row.deltaPct}%` +
          (row.status === "regression" ? "⚠" : row.status === "improved" ? "↑" : ""),
      )
      .join("  ");
    console.log(
      `[perf] 回归对比（基线 ${comparison.baselineDate} / 阈值 ${Math.round(comparison.thresholdRatio * 100)}%）：${summary}`,
    );
    if (!comparison.ok) {
      console.log(
        `[perf] ⚠ 性能回退：${comparison.regressions.map((row) => `${row.metric}(+${row.deltaPct}%)`).join(" / ")}`,
      );
    }
  } else {
    console.log("[perf] 回归对比：无基线报告（首次运行），跳过");
  }
  // 退出码 = 绝对预算结论（R83）。此前恒为 0：预算超了、回退标了，调用方（脚本 / 将来的 CI /
  // 每轮四连的记账）看到的仍是"跑通了"。
  for (const item of gate.excluded) {
    console.log(`[perf] 本轮不参与门禁：${item.name} —— ${item.reason}`);
  }
  if (gate.regressions.length > 0) {
    console.log(
      `[perf] ⚠ 相对基线回退（不翻退出码：同机两遍可差 2 倍，见 perf-compare.ts 口径）：${gate.regressions.join(", ")}`,
    );
  }
  if (gate.ok) {
    console.log("[perf] 门禁：✅ 参与门禁的绝对预算全部达标 ⇒ 退出码 0");
    app.exit(0);
    return;
  }
  console.log(`[perf] 门禁：❌ 未达预算=[${gate.failedBudgets.join(", ")}] ⇒ 退出码 1`);
  app.exit(1);
}