/* SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { app, clipboard, dialog, ipcMain, safeStorage } from "electron";
import { YushuError } from "@yushu/core";
import {
  CHANNELS,
  type AiAdoptPayload,
  type AiAdoptResult,
  type AiClearKeyPayload,
  type AiConfigState,
  type AiDraftTarget,
  type AiGeneratePayload,
  type AiSaveConfigPayload,
  type AiSaveKeyPayload,
  type AiSetEnabledPayload,
  type AiStartResult,
  type AiUsageState,
  type AiCostPanelPayload,
  type AiCostPayload,
  type TextFixBodyPayload,
  type TextFixBodyResultPayload,
  type TextProofreadPanelPayload,
  type RuleCatalogPayload,
  type RuleDryRunPayload,
  type RuleDryRunResult,
  type ConsistencyCheckPayload,
  type PropagatePreviewPayload,
  type ProposalDecidePayload,
  type ForeshadowBoardPayload,
  type TimelineViewPayload,
  type TimelineViewRequestPayload,
  type GraphViewPayload,
  type GraphViewRequestPayload,
  type WorldMapBasePayload,
  type WorldMapUploadBaseResult,
  type WorldMapViewPayload,
  type ChronicleBookPayload,
  type ChronicleBookRequestPayload,
  type SatisfactionBoardPayload,
  type SatisfactionBoardRequestPayload,
  type ProposalPayload,
  type ConsistencyReportPayload,
  type TextProofreadPayload,
  type AiRejectPayload,
  type AiFeedbackState,
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
  type ProjectExportPickPayload,
  type ProjectExportPreviewPayload,
  type ProjectExportRunPayload,
  type ProjectExportRunResult,
  type PovPreviewPayload,
  type PovPreviewRequest,
  type PovSetChapterPayload,
  type PovSetChapterResult,
  type PovWriteConfigPayload,
  type PovWriteResult,
  type BiblePreviewPayload,
  type BiblePreviewRequest,
  type BibleRunPayload,
  type BibleRunResult,
  type ExportPreviewPayload,
  type ExportPreviewRequest,
  type ExportRunPayload,
  type ExportRunResult,
  type FusionPreview,
  type IndexRebuildPayload,
  type IndexRebuildResultPayload,
  type IndexSearchResultPayload,
  type IndexStatusPayload,
  type ImportApplyPayload,
  type ImportApplyResultPayload,
type ImportAiSplitRequestPayload,
type ImportCancelRequestPayload,
type ImportCancelResultPayload,
type ImportCorrectRequestPayload,
type ImportJobSummaryPayload,
type ImportPlanResultPayload,
  type ImportPickPayload,
  type ImportPreviewPayload,
  type ImportPreviewRequestPayload,
  type LibraryViewPayload,
  type IpcResult,
  type MemoryDeleteFactPayload,
  type MemoryAssemblePayload,
  type MemoryAssemblyResult,
  type MemoryInjectionPreviewPayload,
  type MemoryInjectionPreviewResult,
  type MemoryContextSnapshotPayload,
  type MemoryContextSnapshotResult,
  type MemoryRagPreviewPayload,
  type MemoryRagPreviewResult,
  type ExtractAdoptPayload,
  type ExtractAdoptResult,
  type ExtractPreviewPayload,
  type ExtractPreviewResult,
  type MemorySaveFactPayload,
  type MemorySaveFactResult,
  type MemorySaveSummaryPayload,
  type MemorySaveSummaryResult,
  type MemoryStatePayload,
  type MemorySummarizePayload,
  type MemorySummarizeResult,
  type MemorySummarizeBatchPayload,
  type MemorySummarizeBatchResult,
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
  type PublishBoardPayload,
  type PublishSchedulePayload,
  type PublishScheduleResult,
  type PublishSetStatusPayload,
  type PublishSetStatusResult,
} from "../shared/ipc.js";
import { PathSafetyError, ProjectGateway } from "./file-gateway.js";
import {
  adoptDraft,
  assertAiEnabled,
  clearProviderKey,
  listDraftTargets,
  readAiConfig,
  readAiContext,
  readAiUsageState,
  runAiGenerate,
  saveAiConfig,
  saveProviderKey,
  setAiEnabled,
  setSessionKey,
} from "./ai-ops.js";
import { appendAiFeedback, readAiFeedbackState } from "./ai-feedback.js";
import { createSafeStorageCipher } from "./secrets-ops.js";
import { installKeyCipher } from "./ai-ops.js";
import { readCostPanel } from "./cost-ops.js";
import { dryRunRule, readRuleCatalog } from "./rule-ops.js";
import { markConsistencyStale, runConsistencyCheck } from "./consistency-ops.js";
import { applyProposal, decideProposal, listProposals, previewPropagation, proposalPathOf } from "./propagation-ops.js";
import { foreshadowBoard } from "./foreshadow-ops.js";
import { timelineView } from "./timeline-ops.js";
import { relationGraphView } from "./graph-ops.js";
import { uploadMapBase, worldMapBase, worldMapView } from "./map-ops.js";
import { chronicleBook } from "./chronicle-ops.js";
import { satisfactionBoard } from "./satisfaction-ops.js";
import {
  applyImport,
  decideImportCancel,
  listResumableImportJobs,
  pickImportSource,
  previewImport,
} from "./import-ops.js";
import { correctImportSplit, filterImportSplitByAi } from "./import-split-ops.js";
import type { ProposalFile } from "@yushu/world-engine";

/** 提案文件 → IPC 载荷：未决策条数在这里算，面板只负责显示（不在渲染层长出第二套判断） */
function toProposalPayload(path: string, file: ProposalFile): ProposalPayload {
  return {
    proposalId: file.proposal.proposalId,
    change: { ...(file.proposal.change as { entity: string; field: string; to?: string }) },
    status: file.proposal.status,
    impact: file.proposal.impact.map((row) => ({ ...row, path: [...row.path] })),
    truncated: file.proposal.truncated === null ? null : { frontier: [...file.proposal.truncated.frontier], count: file.proposal.truncated.count },
    cycle: file.proposal.cycle === null ? null : [...file.proposal.cycle],
    assumedRelations: [...file.proposal.assumedRelations],
    maxDepth: file.proposal.maxDepth,
    decisions: { ...file.decisions },
    applied: [...file.applied],
    undecidedCount: file.proposal.impact.filter((_, index) => file.decisions[String(index)] === undefined).length,
    path,
  };
}
import { buildFixedBody, readProofreadPanel } from "./text-ops.js";
import { buildClipboardResult, previewExport, runExport } from "./export-ops.js";
import { previewBible, runBibleExport } from "./bible-ops.js";
import { previewPov, setChapterPov, writePovConfig } from "./pov-ops.js";
import { readPublishBoard, scheduleChapterPublish, setChapterPublishStatus } from "./publish-ops.js";
import { previewProjectExport, runProjectExport } from "./project-export.js";
import { exportTargets } from "./export-gate.js";
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
  assembleForChapter,
  deleteMemoryFact,
  exportContextSnapshot,
  loadMemoryState,
  previewInjection,
  previewRag,
  saveMemoryFact,
  saveMemorySummary,
  summarizeMemory,
  summarizeMemoryBatch,
} from "./memory-ops.js";
import { adoptSettingCandidate, previewSettingExtraction } from "./extract-ops.js";
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
    // 真源一变，一致性结论就过期（异步全量态：不在写路径上算，等面板下次读取时重算）
    markConsistencyStale();
    return result;
  });
}

export function registerIpcHandlers(): void {
  // T3-14：把 Electron safeStorage 注入凭据库后端（ai-ops 自身不 import electron，便于单测）
  installKeyCipher(createSafeStorageCipher(safeStorage));

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
    // 覆盖 config/llm.yaml 是真源写（与 ai:saveKey / ai:clearKey 同一口径，那两个注释里就写着"会连带改真源"）
    wrapWrite<AiConfigState>(() => saveAiConfig(requireGateway(), payload)),
  );

  // AI 总开关（A4）：翻转后回读配置——状态由主进程持有，渲染层只显示事实、不当事实源
  ipcMain.handle(CHANNELS.aiSetEnabled, (_event, payload: AiSetEnabledPayload) =>
    wrap<AiConfigState>(() => {
      setAiEnabled(payload?.enabled === true);
      return readAiConfig(requireGateway());
    }),
  );

  ipcMain.handle(CHANNELS.aiSetKey, (_event, payload: { providerId: string; apiKey: string }) =>
    wrap<boolean>(() => {
      setSessionKey(payload.providerId, payload.apiKey);
      return true;
    }),
  );

  // T3-14：写 `.yushu/secrets.json` 本身是派生物，但会连带改真源 config/llm.yaml → 走 wrapWrite 调度索引刷新
  ipcMain.handle(CHANNELS.aiSaveKey, (_event, payload: AiSaveKeyPayload) =>
    wrapWrite<AiConfigState>(() =>
      saveProviderKey(requireGateway(), payload.providerId, payload.apiKey),
    ),
  );

  ipcMain.handle(CHANNELS.aiClearKey, (_event, payload: AiClearKeyPayload) =>
    wrapWrite<AiConfigState>(() => clearProviderKey(requireGateway(), payload.providerId)),
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
      // A4：AI 关闭时**不建流、不发请求**（错误直接回渲染层，按钮保持禁用提示语）
      assertAiEnabled();
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

  // Token 与成本面板（T3-12，J09）：usage 实报 + 本地估算双口径聚合、按任务/模型分解、
  // 稳定前缀与缓存断点编排核对（只读——派生日志与配置，不改真源）
  ipcMain.handle(CHANNELS.aiCost, (_event, payload?: AiCostPayload) =>
    wrap<AiCostPanelPayload>(() => readCostPanel(requireGateway(), payload ?? {})),
  );

  // 中文自查（T3-13，J14）：两个通道都是**只读**——检测不改稿，"采纳"也只回改后正文，
  // 落盘仍由编辑器既有的 chapter:write（baseHash 冲突检测 + 编辑日志 + 字数增量 + 索引刷新）负责。
  ipcMain.handle(CHANNELS.textProofread, (_event, payload: TextProofreadPayload) =>
    wrap<TextProofreadPanelPayload>(() => readProofreadPanel(requireGateway(), payload)),
  );
  ipcMain.handle(CHANNELS.textFixBody, (_event, payload: TextFixBodyPayload) =>
    wrap<TextFixBodyResultPayload>(() => buildFixedBody(requireGateway(), payload)),
  );

  // 规则 DSL（M4/T4-1，R51）：目录与试算都是**只读**——规则本体来自内置派系包目录，御书不改派系包，
  // 试算只吃调用方给的 JSON 夹具（不读正文、不写盘）。真数据比对属 T4-2。
  ipcMain.handle(CHANNELS.ruleCatalog, () => wrap<RuleCatalogPayload>(() => readRuleCatalog(requireGateway())));
  ipcMain.handle(CHANNELS.ruleDryRun, (_event, payload: RuleDryRunPayload) =>
    wrap<RuleDryRunResult>(() => dryRunRule(requireGateway(), payload)),
  );

  // 一致性体检（M4/T4-4）：**只读**——结论只算不落盘（派生报告该落哪儿待 T4-5 一并裁决）。
  ipcMain.handle(CHANNELS.consistencyCheck, (_event, payload?: ConsistencyCheckPayload) =>
    wrap<ConsistencyReportPayload>(() => runConsistencyCheck(requireGateway(), payload ?? {})),
  );

  // 影响传播（M4/T4-5，R61）：真源**只读**，提案写进派生区 `.yushu/proposals/`。
  // 因此走 `wrap` 而不是 `wrapWrite` 是有意的——它不改真源，索引与一致性结论都不该因此过期；
  // 这条判断本身被 `ipc-write-wrappers.test.ts` 的"看着像写、其实写派生物"对照表钉住。
  ipcMain.handle(CHANNELS.propagatePreview, (_event, payload: PropagatePreviewPayload) =>
    wrap<ProposalPayload>(() => previewPropagation(requireGateway(), payload).then((r) => toProposalPayload(r.path, r.file))),
  );
  ipcMain.handle(CHANNELS.proposalList, () =>
    wrap<ProposalPayload[]>(() => listProposals(requireGateway()).then((items) => items.map((item) => toProposalPayload(item.path, item)))),
  );
  // 写回真源（R62）：这条**必须**走 wrapWrite——它逐张改写引用卡的 refs.target；
  // 索引刷新与一致性置脏都由 wrapWrite 负责，写通道源码锁的写清单里也有它。
  ipcMain.handle(CHANNELS.proposalApply, (_event, payload: { proposalId: string }) =>
    wrapWrite<ProposalPayload>(() =>
      applyProposal(requireGateway(), payload.proposalId).then((file) => toProposalPayload(proposalPathOf(payload.proposalId), file)),
    ),
  );
  ipcMain.handle(CHANNELS.proposalDecide, (_event, payload: ProposalDecidePayload) =>
    wrap<ProposalPayload>(() =>
      decideProposal(requireGateway(), payload.proposalId, payload.index, payload.decision).then((file) =>
        toProposalPayload(proposalPathOf(payload.proposalId), file),
      ),
    ),
  );
  // 伏笔台账看板（T4-6）：判定在引擎，这里只读真源算表 ⇒ 走 wrap（不改真源，不该刷索引、不该置脏结论）
  ipcMain.handle(CHANNELS.foreshadowBoard, () =>
    wrap<ForeshadowBoardPayload>(() => foreshadowBoard(requireGateway())),
  );
  // 时间线视图（T4-7）：历法切换只是显示参数，不产生任何写操作 ⇒ 同样走 wrap
  ipcMain.handle(CHANNELS.timelineView, (_event, payload: TimelineViewRequestPayload) =>
    wrap<TimelineViewPayload>(() => timelineView(requireGateway(), payload ?? {})),
  );
  // 关系图谱（T4-9）：由真源行表投影，不写盘也不读索引 ⇒ wrap
  ipcMain.handle(CHANNELS.graphRelation, (_event, payload: GraphViewRequestPayload) =>
    wrap<GraphViewPayload>(() => relationGraphView(requireGateway(), payload ?? {})),
  );
  // 世界地图（T5-1，R120）：真源直算的只读投影，**不写盘** ⇒ wrap
  ipcMain.handle(CHANNELS.worldMapView, (_event) =>
    wrap<WorldMapViewPayload>(() => worldMapView(requireGateway())),
  );
  // 世界地图底图（R123）：只读（路径防护走 gateway，K12）⇒ wrap
  ipcMain.handle(CHANNELS.worldMapBase, (_event) =>
    wrap<WorldMapBasePayload>(() => worldMapBase(requireGateway())),
  );
  // 世界地图底图·**作者侧登记**（R135）：**写盘**（拷进项目 + 改 map.yaml）⇒ wrapWrite
  // 原生对话框在**主进程**开：渲染层拿不到、也不需要本地路径（只回项目内的相对路径与尺寸）。
  ipcMain.handle(CHANNELS.worldMapUploadBase, (_event) =>
    wrapWrite<WorldMapUploadBaseResult>(() =>
      uploadMapBase(requireGateway(), async () => {
        const picked = await dialog.showOpenDialog({
          title: "选一张世界地图底图",
          properties: ["openFile"],
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
        });
        return { canceled: picked.canceled, filePaths: picked.filePaths };
      }),
    ),
  );
  // 编年史（T4-8）：复用时间线刻度，只读 ⇒ wrap
  ipcMain.handle(CHANNELS.chronicleBook, (_event, payload: ChronicleBookRequestPayload) =>
    wrap<ChronicleBookPayload>(() => chronicleBook(requireGateway(), payload ?? {})),
  );
  // 爽点与期待感看板（T4-10）：判定在引擎，阈值不传就不跑 ⇒ 只读 wrap
  ipcMain.handle(CHANNELS.satisfactionBoard, (_event, payload: SatisfactionBoardRequestPayload) =>
    wrap<SatisfactionBoardPayload>(() => satisfactionBoard(requireGateway(), payload ?? {})),
  );

  /* ---------- 存量导入（M5 / T5-7，R77：挑文件 + 预演） ---------- */

  /**
   * 全仓库**唯一**让外部绝对路径进入程序的地方：原生对话框的用户点击。
   * 结果交给闸门登记，返回渲染层的只有票据与文件名——因此这条通道不接受任何路径参数，
   * 渲染层也没有"传路径"这个能力（护栏见 `import-gate.ts` 与 test/import-gate.test.ts）。
   */
  ipcMain.handle(CHANNELS.importPick, () =>
    wrap<ImportPickPayload | null>(() =>
      pickImportSource(() =>
        dialog.showOpenDialog({
          title: "选择要导入的稿件（单个文本文件）",
          properties: ["openFile"],
          filters: [{ name: "文本稿件", extensions: ["txt", "md", "markdown"] }],
        }),
      ),
    ),
  );

  // 预演：凭票读字节算编码 / 清洗 / 分章三份报告，**零写入** ⇒ 只读 wrap
  // （`ipc-write-wrappers.test.ts` 的 NON_WRITE 清单点名了这两条；会写盘的是下面这条 import:apply）
  ipcMain.handle(CHANNELS.importPreview, (_event, payload: ImportPreviewRequestPayload) =>
    wrap<ImportPreviewPayload>(() =>
      previewImport(
        payload.ticket,
        payload.rules ? { rules: payload.rules, gateway: requireGateway() } : { gateway: requireGateway() },
      ),
    ),
  );

  /**
   * 入库（R79）：建一卷 + 建章纲 + 写章节草稿，**真源写** ⇒ 必须走 wrapWrite（索引刷新与一致性置脏都挂在它上面）。
   * 载荷里没有正文：主进程凭同一张票重新算一遍，所以"渲染层改改正文再提交"在数据结构上就不成立；
   * 失败时票据不作废（作者可原地重试），成功即作废（同一部稿子不能被导两遍）。
   */
  ipcMain.handle(CHANNELS.importApply, (_event, payload: ImportApplyPayload) =>
    wrapWrite<ImportApplyResultPayload>(() => applyImport(requireGateway(), payload)),
  );

  // AI 二次筛选切章（R107，I09 §3.4）：**只改计划、不写盘**（真源写仍是上面那条 import:apply），
  // 所以与 preview 同一类——只读 wrap，并登记进写通道锁的 NON_WRITE 清单
  ipcMain.handle(CHANNELS.importAiSplit, (_event, payload: ImportAiSplitRequestPayload) =>
    wrap<ImportPlanResultPayload>(() => filterImportSplitByAi(requireGateway(), payload.ticket, payload)),
  );
  // 人工校正切分（R107，I09 §3.5）：同样**只改计划**（合并 / 拆分 / 重排），零写入
  ipcMain.handle(CHANNELS.importCorrect, (_event, payload: ImportCorrectRequestPayload) =>
    wrap<ImportPlanResultPayload>(() => correctImportSplit(requireGateway(), payload.ticket, payload)),
  );

  // 取消这次导入（R108，I09 §2.7 的"可中断"那半边）：作废票据 + 记一次取消。
  // 正在入库的话，写盘循环会在**章的边界**上停 ⇒ 断点落盘，剩下的可续跑。
  // 这条通道不碰真源（作废的是票据、记的是运行期标记），所以走只读包装器。
  ipcMain.handle(CHANNELS.importCancel, (_event, payload: ImportCancelRequestPayload) =>
    wrap<ImportCancelResultPayload>(() => decideImportCancel(payload.ticket)),
  );

  // 可续跑的导入任务（R108）：**只读**——任务记录在 .yushu/imports/ 下，不是项目内容
  ipcMain.handle(CHANNELS.importJobs, () =>
    wrap<ImportJobSummaryPayload[]>(async () => {
      const jobs = await listResumableImportJobs(requireGateway());
      return jobs.map((job) => ({
        id: job.id,
        source_name: job.source.name,
        status: job.status,
        last_chapter: job.checkpoint.last_chapter,
        total_chapters: job.chapters.length,
      }));
    }),
  );

  // 候选拒绝原因（T3-11，J15）：记录到 .yushu/ai-feedback.jsonl 并回传统计（记录失败不阻断）
  ipcMain.handle(CHANNELS.aiReject, (_event, payload: AiRejectPayload) =>
    wrap<AiFeedbackState>(async () => {
      const gateway = requireGateway();
      await appendAiFeedback(gateway.root, payload);
      return readAiFeedbackState(gateway.root);
    }),
  );
  ipcMain.handle(CHANNELS.aiFeedback, () => wrap<AiFeedbackState>(() => readAiFeedbackState(requireGateway().root)));

  /* ---------- 导出与敏感词自查（S6） ---------- */

  ipcMain.handle(CHANNELS.exportPreview, (_event, payload: ExportPreviewRequest) =>
    wrap<ExportPreviewPayload>(() =>
      previewExport(requireGateway(), {
        refreshTooling: payload?.refresh === true,
        // 平台格式（R94 / K11）：整条链只传 id，参数一律由主进程去包里读
        platform: payload?.platform,
      }),
    ),
  );

  ipcMain.handle(CHANNELS.exportRun, (_event, payload: ExportRunPayload) =>
    wrap<ExportRunResult>(() => runExport(requireGateway(), payload)),
  );

  /* ---------- 项目迁移包导出（M3 T3-14 后半，R101） ---------- */

  // 目标目录只能由原生对话框结果登记成票据：渲染层从头到尾拿不到、也不该拿到绝对路径
  ipcMain.handle(CHANNELS.projectExportPick, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择迁移包的导出位置",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { name: "", entries: 0, canceled: true } satisfies ProjectExportPickPayload;
    }
    const picked = await exportTargets.register(result.filePaths[0]!);
    return { name: picked.name, entries: picked.entries, canceled: false, ticket: picked.ticket } satisfies ProjectExportPickPayload;
  });

  ipcMain.handle(CHANNELS.projectExportPreview, (_event, payload?: { includeExports?: boolean }) =>
    wrap<ProjectExportPreviewPayload>(() => previewProjectExport(requireGateway(), payload ?? {})),
  );

  // 写的是**项目外**的目录，本项目真源一个字节不动 ⇒ 与 export:run 同类，走只读包装器（分类见写通道锁）
  ipcMain.handle(CHANNELS.projectExportRun, (_event, payload: ProjectExportRunPayload) =>
    wrap<ProjectExportRunResult>(() => runProjectExport(requireGateway(), payload)),
  );

  // 世界圣经 / 设定集（M5 T5-5，R98）：预览只读，导出只写 exports/ 派生物（与 export:run 同一类，不写真源）
  ipcMain.handle(CHANNELS.biblePreview, (_event, payload: BiblePreviewRequest) =>
    wrap<BiblePreviewPayload>(() => previewBible(requireGateway(), payload ?? {})),
  );
  ipcMain.handle(CHANNELS.bibleRun, (_event, payload: BibleRunPayload) =>
    wrap<BibleRunResult>(() => runBibleExport(requireGateway(), payload)),
  );

  /* ---------- 视角看板（M4 T4-2 第三批，R102） ---------- */

  // 只读：读 config/pov.yaml 与章 frontmatter，不碰索引也不写盘
  ipcMain.handle(CHANNELS.povPreview, (_event, payload?: PovPreviewRequest) =>
    wrap<PovPreviewPayload>(() => previewPov(requireGateway(), payload ?? {})),
  );
  // 保存策略：写真源 YAML（config/pov.yaml），所以与卡/章同级走 wrapWrite
  ipcMain.handle(CHANNELS.povWriteConfig, (_event, payload: PovWriteConfigPayload) =>
    wrapWrite<PovWriteResult>(() => writePovConfig(requireGateway(), payload)),
  );
  // 绑本章视角：只重写章 frontmatter 的 pov —— 正文的唯一写入口仍是 chapter:write
  ipcMain.handle(CHANNELS.povSetChapter, (_event, payload: PovSetChapterPayload) =>
    wrapWrite<PovSetChapterResult>(() => setChapterPov(requireGateway(), payload)),
  );

  // 发布状态机（M5/T5-6，R105）：看板**只读**——判定全在引擎，桌面端只负责读真源与画表
  ipcMain.handle(CHANNELS.publishBoard, () =>
    wrap<PublishBoardPayload>(() => readPublishBoard(requireGateway())),
  );
  // 改发布状态：**真源写**（章 frontmatter 的 status + config/publish.yaml 的留痕），走 wrapWrite
  ipcMain.handle(CHANNELS.publishSetStatus, (_event, payload: PublishSetStatusPayload) =>
    wrapWrite<PublishSetStatusResult>(() => setChapterPublishStatus(requireGateway(), payload)),
  );
  // 设定 / 清除定时发布：**真源写**（章 frontmatter 的 publish_at），走 wrapWrite
  ipcMain.handle(CHANNELS.publishSchedule, (_event, payload: PublishSchedulePayload) =>
    wrapWrite<PublishScheduleResult>(() => scheduleChapterPublish(requireGateway(), payload)),
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
    // 回滚会把工作区的 md/yaml 整体落回旧提交——这是**真源改写**，与 snapshot:restore 同一类，
    // 必须走 wrapWrite 让索引刷新、一致性结论置脏（挂在只读 wrap 上会让面板继续显示回滚前的世界）
    wrapWrite<GitRollbackResultPayload>(() => gitRollback(requireGateway(), payload.oid)),
  );

  /* ---------- 五层记忆（M3 / T3-5） ---------- */

  ipcMain.handle(CHANNELS.memoryState, () => wrap<MemoryStatePayload>(() => loadMemoryState(requireGateway())));

  // 摘要候选：生成不入库（候选化原则）；入库走 memory:saveSummary 的显式动作
  ipcMain.handle(CHANNELS.memorySummarize, (_event, payload: MemorySummarizePayload) =>
    wrap<MemorySummarizeResult>(() => summarizeMemory(requireGateway(), payload)),
  );

  // 批量补摘要候选（T5-9 第二段，R106）：**只发请求、不写库**（候选化不变）；
  // 与预算护栏联动——超预算或有条目算不出金额时，未确认就不跑（E_MEMORY_BATCH_CONFIRM）
  ipcMain.handle(CHANNELS.memorySummarizeBatch, (_event, payload: MemorySummarizeBatchPayload) =>
    wrap<MemorySummarizeBatchResult>(() => summarizeMemoryBatch(requireGateway(), payload)),
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

  // 注入预演（T3-6）：对指定章节输出注入计划（决策 + 排除原因 + token 估算；只读）
  ipcMain.handle(CHANNELS.memoryInjectionPreview, (_event, payload: MemoryInjectionPreviewPayload) =>
    wrap<MemoryInjectionPreviewResult>(() => previewInjection(requireGateway(), payload)),
  );

  // 上下文组装（T3-7）：固定槽位顺序 + 槽位 cap + 全局预算裁剪 + 去重（只读）
  ipcMain.handle(CHANNELS.memoryAssemble, (_event, payload: MemoryAssemblePayload) =>
    wrap<MemoryAssemblyResult>(() => assembleForChapter(requireGateway(), payload)),
  );

  // RAG 检索预演（T3-8）：向量路 + 关键词路并行 → RRF 融合 → 可选重排（只读）
  ipcMain.handle(CHANNELS.memoryRagPreview, (_event, payload: MemoryRagPreviewPayload) =>
    wrap<MemoryRagPreviewResult>(() => previewRag(requireGateway(), payload)),
  );

  // 上下文快照导出（T3-9）：写入 .yushu/context-log/（派生日志，不入索引；不走 wrapWrite 避免无谓索引刷新）
  ipcMain.handle(CHANNELS.memoryContextSnapshot, (_event, payload: MemoryContextSnapshotPayload) =>
    wrap<MemoryContextSnapshotResult>(() => exportContextSnapshot(requireGateway(), payload)),
  );

  // 设定抽取预演（T3-10，只读：候选不入库——采纳是用户显式动作；ai-usage 记录为派生日志）
  ipcMain.handle(CHANNELS.extractPreview, (_event, payload: ExtractPreviewPayload) =>
    wrap<ExtractPreviewResult>(() => previewSettingExtraction(requireGateway(), payload)),
  );

  // 采纳抽取候选（写设定卡真源：仅 new 候选允许——服务端复核分类，AI 不得重复建卡 / 覆盖）
  ipcMain.handle(CHANNELS.extractAdopt, (_event, payload: ExtractAdoptPayload) =>
    wrapWrite<ExtractAdoptResult>(() => adoptSettingCandidate(requireGateway(), payload)),
  );

  // 正常退出（窗口关闭 → app.quit）：before-quit 不能等待异步——同步原子写把会话标记为 closed，
  // 确保下次打开不误报「异常退出」（崩溃 / taskkill 到不了这里，标记保持 active 供检出）。
  app.on("before-quit", () => {
    if (gateway) endSessionSync(gateway);
  });
}