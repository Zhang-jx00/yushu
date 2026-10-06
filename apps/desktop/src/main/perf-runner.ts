import { promises as fs } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { attachProject } from "./ipc.js";
import { comparePerfMetrics } from "./perf-compare.js";
import { ensureSynthFixture } from "./perf-fixture.js";

/**
 * 性能实测探针（M2 / T2-10；`pnpm --filter @yushu/desktop perf-test`）：
 * 在真实 Electron 里对 synth-1m 百万字夹具跑一遍性能预算指标（perf-budget.yaml），
 * 输出 PERF_RESULT JSON（终端 + 夹具目录 `.yushu/perf-report.json`）；
 * 报告内含与「上一次同夹具报告」的逐项回归对比（T2-10 遗留：diff 防退化，超阈值标记 ⚠）。
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

/** 门禁值（与仓库根 perf-budget.yaml 保持一致；T2-10 基线；大章按键门禁为 T2-4 切片 B 纳入） */
const BUDGETS = {
  cold_to_editable_ms: 2000,
  hot_to_editable_ms: 800,
  project_open_ms: 3000,
  keystroke_p95_ms: 16,
  keystroke_mega_p95_ms: 16,
  save_to_indexed_ms: 500,
  query_p95_ms: 80,
  rebuild_cpm_min: 20000,
  idle_rss_mb: 600,
  million_chars_rss_mb: 1200,
} as const;

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
  app.exit(0);
}