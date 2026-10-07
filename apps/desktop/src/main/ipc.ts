import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { app, clipboard, dialog, ipcMain } from "electron";
import { YushuError } from "@yushu/core";
import {
  CHANNELS,
  type AiAdoptPayload,
  type AiAdoptResult,
  type AiConfigState,
  type AiDraftTarget,
  type AiGeneratePayload,
  type AiSaveConfigPayload,
  type AiStartResult,
  type AiUsageState,
  type AppFlushDonePayload,
  type CardReadResult,
  type CardSummary,
  type CardWritePayload,
  type CardWriteResult,
  type ChapterReadResult,
  type ChapterSidecarPayload,
  type ChapterSidecarResult,
  type ChapterWritePayload,
  type ChapterWriteResult,
  type ClipboardPayload,
  type ClipboardResult,
  type ContextPreviewPayload,
  type CreateProjectPayload,
  type DocSnapshot,
  type ExportPreviewPayload,
  type ExportRunPayload,
  type ExportRunResult,
  type FusionPreview,
  type IndexRebuildPayload,
  type IndexRebuildResultPayload,
  type IndexSearchResultPayload,
  type IndexStatusPayload,
  type LibraryViewPayload,
  type IpcResult,
  type MemoryDeleteFactPayload,
  type MemorySaveFactPayload,
  type MemorySaveFactResult,
  type MemorySaveSummaryPayload,
  type MemorySaveSummaryResult,
  type MemoryStatePayload,
  type MemorySummarizePayload,
  type MemorySummarizeResult,
  type NamingGeneratePayload,
  type NamingResultPayload,
  type OutlineChapterDraftResult,
  type OutlineCreateChapterPayload,
  type OutlineGeneratePayload,
  type OutlineMutateResult,
  type OutlineState,
  type OutlineWritePayload,
  type PackCatalog,
  type ProjectSnapshot,
  type RecoveryEntry,
  type RecoveryWritePayload,
  type SessionStatusPayload,
  type SnapshotRestoreResultPayload,
  type SnapshotStatePayload,
  type SnapshotTakeResultPayload,
  type StatsSetGoalPayload,
  type StatsActivityPayload,
  type StatsStatePayload,
  type GitCommitPayload,
  type GitCommitResultPayload,
  type GitRollbackPayload,
  type GitRollbackResultPayload,
  type GitStatePayload,
  type TreeEntry,
  type WorldSummary,
} from "../shared/ipc.js";
import { PathSafetyError, ProjectGateway } from "./file-gateway.js";
import {
  adoptDraft,
  listDraftTargets,
  readAiConfig,
  readAiContext,
  readAiUsageState,
  runAiGenerate,
  saveAiConfig,
  setSessionKey,
} from "./ai-ops.js";
import { buildClipboardResult, previewExport, runExport } from "./export-ops.js";
import { readIndexStatus, rebuildProjectIndex, searchProjectIndex } from "./index-ops.js";
import { IndexRefreshScheduler } from "./index-scheduler.js";
import { readLibrary } from "./library-ops.js";
import { closeCoordinatorFor } from "./close-coordinator.js";
import { generateNames } from "./naming-ops.js";
import { readChapter, writeChapterBody, writeChapterSidecar } from "./chapter-ops.js";
import {
  clearRecoveryJournal,
  discardRecoveryJournal,
  listRecoverable,
  writeRecoveryJournal,
} from "./recovery-ops.js";
import {
  restoreSnapshot,
  SnapshotLoop,
  snapshotState,
  takeSnapshot,
} from "./snapshot-ops.js";
import {
  beginSession,
  endSession,
  endSessionSync,
  isSnapshotStale,
  touchSession,
  type SessionOpenResult,
} from "./session-ops.js";
import { recordActivity, readStatsState, setStatsGoal } from "./stats-ops.js";
import { gitCommit, gitInit, gitRollback, gitState } from "./git-ops.js";
import {
  deleteMemoryFact,
  loadMemoryState,
  saveMemoryFact,
  saveMemorySummary,
  summarizeMemory,
} from "./memory-ops.js";
import {
  buildFusionPreview,
  buildPackCatalog,
  createOutlineChapter,
  createProject,
  generateOutline,
  getWorldSummary,
  listCards,
  readCardDoc,
  readOutlineState,
  writeCardDoc,
  writeOutline,
} from "./project-ops.js";

/**
 * 主进程 IPC 路由（docs/03 §3）：白名单通道，全部返回 IpcResult 信封。
 * 渲染层错误经 preload 还原为带 code 的 Error；业务逻辑在 project-ops / file-gateway。
 */

let gateway: ProjectGateway | null = null;

/** 进行中的 AI 流式会话（streamId → AbortController），供 ai:abort 停止 */
const aiStreams = new Map<string, AbortController>();

/**
 * 保存即增量（T2-5 切片 B）：写通道成功后的后台增量刷新（防抖 2.5s、单飞、失败不阻断写）。
 * 仅在索引已存在时刷新——首次构建仍由用户显式触发（「索引可控」原则）。
 */
const indexRefresh = new IndexRefreshScheduler(async () => {
  const current = gateway;
  if (!current) return;
  const status = await readIndexStatus(current);
  if (!status.exists) return;
  await rebuildProjectIndex(current, { incremental: true });
});

/**
 * 本地快照（T2-7 切片 A）：打开项目即检查一次（基线），此后每 60s 检查——
 * 距上一份不足最小间隔 / 内容无变化则跳过（快照管理器内部判定）。
 * T2-8 切片 B：同一周期刷新会话心跳（lastSeenAt），供异常退出后的「脏快照」提示判定。
 */
const snapshotLoop = new SnapshotLoop(async () => {
  const current = gateway;
  if (!current) return;
  await takeSnapshot(current, "auto");
  await touchSession(current).catch(() => undefined);
});

/** 最近一次 attachProject 检出的「上次会话异常退出」（供 session:status 与实测脚本读取） */
let lastAbnormalExit: SessionOpenResult["abnormalExit"] = null;

/** 最近一次检出结果（kill-test 二阶段用作崩溃检测证据） */
export function currentSessionAbnormal(): SessionOpenResult["abnormalExit"] {
  return lastAbnormalExit;
}

function requireGateway(): ProjectGateway {
  if (!gateway) {
    throw new YushuError("E_NO_PROJECT", "尚未打开项目");
  }
  return gateway;
}

/**
 * 挂载项目根目录为当前 gateway（project:create 的副作用；UI walkthrough 预演复用）。
 * T2-8 切片 B：同时做会话标记——先检出上次会话是否异常退出（对比 pid），再写入本次 active。
 */
export async function attachProject(root: string): Promise<void> {
  indexRefresh.reset();
  const previous = gateway;
  gateway = new ProjectGateway(root);
  // 切换项目：把上一个项目标记为正常关闭（否则下次打开会被误判为「异常退出」）
  if (previous && previous.root !== gateway.root) {
    await endSession(previous).catch(() => undefined);
  }
  lastAbnormalExit = (await beginSession(gateway)).abnormalExit;
  snapshotLoop.stop();
  snapshotLoop.start();
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      ok: false,
      error: { code: e.code ?? "E_UNKNOWN", message: e.message ?? String(err) },
    };
  }
}

/** 写通道包装（T2-5 保存即增量）：写成功后调度后台索引刷新（刷新失败不改变写结果） */
function wrapWrite<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return wrap(async () => {
    const result = await fn();
    indexRefresh.schedule();
    return result;
  });
}

export function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.projectOpen, (_event, payload?: { path?: string }) =>
    wrap<ProjectSnapshot | null>(async () => {
      let root = payload?.path;
      if (!root) {
        const result = await dialog.showOpenDialog({
          title: "打开御书项目",
          properties: ["openDirectory", "createDirectory"],
        });
        const picked = result.filePaths[0];
        if (result.canceled || !picked) return null;
        root = picked;
      }
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new PathSafetyError(`目录不存在或不是文件夹：${root}`);
      }
      await attachProject(root);
      return { root: gateway!.root, tree: await gateway!.listTree() };
    }),
  );

  ipcMain.handle(CHANNELS.projectClose, () =>
    wrap<boolean>(async () => {
      const current = gateway;
      if (current) await endSession(current).catch(() => undefined);
      indexRefresh.reset();
      snapshotLoop.stop();
      gateway = null;
      lastAbnormalExit = null;
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.projectTree, () => wrap<TreeEntry[]>(() => requireGateway().listTree()));

  // 当前项目快照：未打开项目时返回 null（渲染层据此决定是否直接进入项目页）
  ipcMain.handle(CHANNELS.projectCurrent, () =>
    wrap<ProjectSnapshot | null>(async () => {
      const current = gateway;
      if (!current) return null;
      return { root: current.root, tree: await current.listTree() };
    }),
  );

  ipcMain.handle(CHANNELS.projectChooseDirectory, () =>
    wrap<string | null>(async () => {
      const result = await dialog.showOpenDialog({
        title: "选择项目存放目录",
        properties: ["openDirectory", "createDirectory"],
      });
      const picked = result.filePaths[0];
      return result.canceled || !picked ? null : picked;
    }),
  );

  ipcMain.handle(CHANNELS.projectCreate, (_event, payload: CreateProjectPayload) =>
    wrap<ProjectSnapshot>(async () => {
      const snapshot = await createProject(payload);
      await attachProject(snapshot.root);
      return snapshot;
    }),
  );

  ipcMain.handle(CHANNELS.packCatalog, () => wrap<PackCatalog>(() => buildPackCatalog()));

  ipcMain.handle(CHANNELS.packFuse, (_event, payload: { packIds: string[] }) =>
    wrap<FusionPreview>(() => buildFusionPreview(payload.packIds)),
  );

  ipcMain.handle(CHANNELS.projectWorld, () =>
    wrap<WorldSummary | null>(() => getWorldSummary(requireGateway())),
  );

  ipcMain.handle(CHANNELS.cardList, () => wrap<CardSummary[]>(() => listCards(requireGateway())));

  ipcMain.handle(CHANNELS.cardRead, (_event, payload: { path: string }) =>
    wrap<CardReadResult>(() => readCardDoc(requireGateway(), payload.path)),
  );

  ipcMain.handle(CHANNELS.cardWrite, (_event, payload: CardWritePayload) =>
    wrapWrite<CardWriteResult>(() => writeCardDoc(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.docRead, (_event, payload: { path: string }) =>
    wrap<DocSnapshot>(() => requireGateway().readDoc(payload.path)),
  );

  ipcMain.handle(
    CHANNELS.docWrite,
    (_event, payload: { path: string; content: string; baseHash?: string }) =>
      wrapWrite<DocSnapshot>(() => requireGateway().writeDoc(payload.path, payload.content, payload.baseHash)),
  );

  ipcMain.handle(CHANNELS.docRename, (_event, payload: { from: string; to: string }) =>
    wrapWrite<boolean>(async () => {
      await requireGateway().renameDoc(payload.from, payload.to);
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.outlineRead, () =>
    wrap<OutlineState>(() => readOutlineState(requireGateway())),
  );

  ipcMain.handle(CHANNELS.outlineGenerate, (_event, payload: OutlineGeneratePayload) =>
    wrapWrite<OutlineMutateResult>(() => generateOutline(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.outlineWrite, (_event, payload: OutlineWritePayload) =>
    wrapWrite<OutlineMutateResult>(() => writeOutline(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.outlineCreateChapter, (_event, payload: OutlineCreateChapterPayload) =>
    wrapWrite<OutlineChapterDraftResult>(() => createOutlineChapter(requireGateway(), payload)),
  );

  /* ---------- AI 副驾（S4/S5） ---------- */

  ipcMain.handle(CHANNELS.aiConfig, () => wrap<AiConfigState>(() => readAiConfig(requireGateway())));

  ipcMain.handle(CHANNELS.aiSaveConfig, (_event, payload: AiSaveConfigPayload) =>
    wrap<AiConfigState>(() => saveAiConfig(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.aiSetKey, (_event, payload: { providerId: string; apiKey: string }) =>
    wrap<boolean>(() => {
      setSessionKey(payload.providerId, payload.apiKey);
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.aiDrafts, () =>
    wrap<AiDraftTarget[]>(() => listDraftTargets(requireGateway())),
  );

  ipcMain.handle(
    CHANNELS.aiContext,
    (_event, payload?: { volumeId?: string; chapterId?: string }) =>
      wrap<ContextPreviewPayload>(() =>
        readAiContext(
          requireGateway(),
          payload?.volumeId && payload.chapterId
            ? { volumeId: payload.volumeId, chapterId: payload.chapterId }
            : undefined,
        ),
      ),
  );

  // ai:start 立即返回 streamId；增量经 ai:event 单向推送（流式 + AbortController）
  ipcMain.handle(CHANNELS.aiStart, (event, payload: AiGeneratePayload) =>
    wrap<AiStartResult>(() => {
      const gatewayRef = requireGateway();
      const streamId = payload.streamId?.trim() ? payload.streamId : `ai-${randomUUID().slice(0, 8)}`;
      const controller = new AbortController();
      aiStreams.set(streamId, controller);
      void runAiGenerate(gatewayRef, {
        streamId,
        payload,
        signal: controller.signal,
        sink: (streamEvent) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.aiEvent, streamEvent);
        },
      }).finally(() => aiStreams.delete(streamId));
      return { streamId };
    }),
  );

  ipcMain.handle(CHANNELS.aiAbort, (_event, payload: { streamId: string }) =>
    wrap<boolean>(() => {
      const controller = aiStreams.get(payload.streamId);
      if (!controller) return false;
      controller.abort();
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.aiAdopt, (_event, payload: AiAdoptPayload) =>
    wrapWrite<AiAdoptResult>(() => adoptDraft(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.aiUsage, () => wrap<AiUsageState>(() => readAiUsageState(requireGateway())));

  /* ---------- 导出与敏感词自查（S6） ---------- */

  ipcMain.handle(CHANNELS.exportPreview, () =>
    wrap<ExportPreviewPayload>(() => previewExport(requireGateway())),
  );

  ipcMain.handle(CHANNELS.exportRun, (_event, payload: ExportRunPayload) =>
    wrap<ExportRunResult>(() => runExport(requireGateway(), payload)),
  );

  // 干净剪贴板：文本在主进程生成并写入系统剪贴板（渲染层只拿统计与预览）
  ipcMain.handle(CHANNELS.exportClipboard, (_event, payload?: ClipboardPayload) =>
    wrap<ClipboardResult>(async () => {
      const { result, text } = await buildClipboardResult(requireGateway(), payload ?? {});
      clipboard.writeText(text);
      return result;
    }),
  );

  /* ---------- 检索索引（S7） ---------- */

  ipcMain.handle(CHANNELS.indexStatus, () =>
    wrap<IndexStatusPayload>(async () => ({
      ...(await readIndexStatus(requireGateway())),
      refresh: indexRefresh.state(),
    })),
  );

  ipcMain.handle(CHANNELS.indexRebuild, (event, payload?: IndexRebuildPayload) =>
    wrap<IndexRebuildResultPayload>(() =>
      rebuildProjectIndex(requireGateway(), {
        ...(payload ?? {}),
        // 进度流（T2-5 切片 B）：分片写入 / 段合并阶段实时推送给发起窗口（窗口销毁则静默停止）
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.indexProgress, progress);
        },
      }),
    ),
  );

  ipcMain.handle(CHANNELS.indexSearch, (_event, payload: { keyword: string; limit?: number }) =>
    wrap<IndexSearchResultPayload>(() =>
      searchProjectIndex(requireGateway(), payload.keyword, payload.limit ?? 20),
    ),
  );

  // 稿件总览（T2-4 切片 A：全库视图）
  ipcMain.handle(CHANNELS.libraryList, () => wrap<LibraryViewPayload>(() => readLibrary(requireGateway())));

  /* ---------- 命名生成器（S2） ---------- */

  ipcMain.handle(CHANNELS.namingGenerate, (_event, payload: NamingGeneratePayload) =>
    wrap<NamingResultPayload>(() => generateNames(requireGateway(), payload)),
  );

  /* ---------- 通用剪贴板 ---------- */

  ipcMain.handle(CHANNELS.appWriteClipboard, (_event, payload: { text: string }) =>
    wrap<boolean>(() => {
      clipboard.writeText(String(payload.text ?? ""));
      return true;
    }),
  );

  // 关闭前 flush（T2-6 完整版）：渲染层落盘完成回执（单向消息）→ 记录结果并放行对应窗口的关闭
  ipcMain.on(CHANNELS.appFlushDone, (event, payload?: AppFlushDonePayload) => {
    console.log(`[close-flush] 渲染层回执：${JSON.stringify(payload ?? {})}`);
    closeCoordinatorFor(event.sender.id)?.handleFlushDone();
  });

  /* ---------- 章节编辑器（M2 / T2-1 切片 A） ---------- */

  ipcMain.handle(CHANNELS.chapterRead, (_event, payload: { path: string }) =>
    wrap<ChapterReadResult>(() => readChapter(requireGateway(), payload.path)),
  );

  ipcMain.handle(CHANNELS.chapterWrite, (_event, payload: ChapterWritePayload) =>
    wrapWrite<ChapterWriteResult>(() => writeChapterBody(requireGateway(), payload)),
  );

  // 冲突旁路（T2-6 切片）：把当前编辑内容写入 <章节>.conflict-<时间戳>.md，主文件不动
  ipcMain.handle(CHANNELS.chapterWriteSidecar, (_event, payload: ChapterSidecarPayload) =>
    wrap<ChapterSidecarResult>(() => writeChapterSidecar(requireGateway(), payload)),
  );

  /* ---------- 编辑日志与崩溃恢复（M2 / T2-8 切片 A） ---------- */

  ipcMain.handle(CHANNELS.recoveryWriteJournal, (_event, payload: RecoveryWritePayload) =>
    wrap<boolean>(() => writeRecoveryJournal(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.recoveryClearJournal, (_event, payload: { path: string }) =>
    wrap<boolean>(() => clearRecoveryJournal(requireGateway(), payload.path)),
  );

  ipcMain.handle(CHANNELS.recoveryList, () =>
    wrap<RecoveryEntry[]>(() => listRecoverable(requireGateway())),
  );

  ipcMain.handle(CHANNELS.recoveryDiscard, (_event, payload: { path: string }) =>
    wrap<boolean>(() => discardRecoveryJournal(requireGateway(), payload.path)),
  );

  /* ---------- 本地快照（M2 / T2-7 切片 A：内容寻址快照） ---------- */

  ipcMain.handle(CHANNELS.snapshotState, () =>
    wrap<SnapshotStatePayload>(() => snapshotState(requireGateway())),
  );

  // 手动快照 = 强制（不受 60s 最小间隔限制）
  ipcMain.handle(CHANNELS.snapshotTake, () =>
    wrap<SnapshotTakeResultPayload>(() => takeSnapshot(requireGateway(), "manual", { force: true })),
  );

  // 整体回滚：恢复前由 restoreSnapshot 强制生成 pre_restore 快照；恢复改写真源 → 触发后台增量索引
  ipcMain.handle(CHANNELS.snapshotRestore, (_event, payload: { id: string }) =>
    wrapWrite<SnapshotRestoreResultPayload>(() => restoreSnapshot(requireGateway(), payload.id)),
  );

  /* ---------- 会话异常退出检测（M2 / T2-8 切片 B） ---------- */

  // 本次打开项目时检出的上次异常退出（含 pid 守卫，同进程 reload 不误报）+ 快照新鲜度（脏快照提示）
  ipcMain.handle(CHANNELS.sessionStatus, () =>
    wrap<SessionStatusPayload>(async () => {
      const current = requireGateway();
      const latest = await snapshotState(current)
        .then((state) => state.snapshots[0] ?? null)
        .catch(() => null);
      return {
        abnormalExit: lastAbnormalExit,
        lastSnapshot: latest,
        snapshotStale: isSnapshotStale(lastAbnormalExit, latest),
      };
    }),
  );

  /* ---------- 码字统计（M2 / T2-9 切片 A） ---------- */

  ipcMain.handle(CHANNELS.statsRead, () => wrap<StatsStatePayload>(() => readStatsState(requireGateway())));

  ipcMain.handle(CHANNELS.statsSetGoal, (_event, payload: StatsSetGoalPayload) =>
    wrap<{ daily: number }>(() => setStatsGoal(requireGateway(), payload.daily)),
  );

  // 写作活动心跳（T2-9 切片 C）：编辑器输入期间节流上报；失败由渲染层静默（统计非真源）
  ipcMain.handle(CHANNELS.statsActivity, () =>
    wrap<StatsActivityPayload>(() => recordActivity(requireGateway())),
  );

  /* ---------- Git 版本管理（M2 / T2-7 切片 B） ---------- */

  ipcMain.handle(CHANNELS.gitState, () => wrap<GitStatePayload>(() => gitState(requireGateway())));

  ipcMain.handle(CHANNELS.gitInit, () => wrap<GitStatePayload>(() => gitInit(requireGateway())));

  ipcMain.handle(CHANNELS.gitCommit, (_event, payload: GitCommitPayload) =>
    wrap<GitCommitResultPayload>(() => gitCommit(requireGateway(), payload.message)),
  );

  ipcMain.handle(CHANNELS.gitRollback, (_event, payload: GitRollbackPayload) =>
    wrap<GitRollbackResultPayload>(() => gitRollback(requireGateway(), payload.oid)),
  );

  /* ---------- 五层记忆（M3 / T3-5） ---------- */

  ipcMain.handle(CHANNELS.memoryState, () => wrap<MemoryStatePayload>(() => loadMemoryState(requireGateway())));

  // 摘要候选：生成不入库（候选化原则）；入库走 memory:saveSummary 的显式动作
  ipcMain.handle(CHANNELS.memorySummarize, (_event, payload: MemorySummarizePayload) =>
    wrap<MemorySummarizeResult>(() => summarizeMemory(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.memorySaveSummary, (_event, payload: MemorySaveSummaryPayload) =>
    wrapWrite<MemorySaveSummaryResult>(() => saveMemorySummary(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.memorySaveFact, (_event, payload: MemorySaveFactPayload) =>
    wrapWrite<MemorySaveFactResult>(() => saveMemoryFact(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.memoryDeleteFact, (_event, payload: MemoryDeleteFactPayload) =>
    wrapWrite<boolean>(() => deleteMemoryFact(requireGateway(), payload)),
  );

  // 正常退出（窗口关闭 → app.quit）：before-quit 不能等待异步——同步原子写把会话标记为 closed，
  // 确保下次打开不误报「异常退出」（崩溃 / taskkill 到不了这里，标记保持 active 供检出）。
  app.on("before-quit", () => {
    if (gateway) endSessionSync(gateway);
  });
}