import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { clipboard, dialog, ipcMain } from "electron";
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
  type IpcResult,
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
import { generateNames } from "./naming-ops.js";
import { readChapter, writeChapterBody, writeChapterSidecar } from "./chapter-ops.js";
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

function requireGateway(): ProjectGateway {
  if (!gateway) {
    throw new YushuError("E_NO_PROJECT", "尚未打开项目");
  }
  return gateway;
}

/** 挂载项目根目录为当前 gateway（project:create 的副作用；UI walkthrough 预演复用） */
export function attachProject(root: string): void {
  gateway = new ProjectGateway(root);
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
      gateway = new ProjectGateway(root);
      return { root: gateway.root, tree: await gateway.listTree() };
    }),
  );

  ipcMain.handle(CHANNELS.projectClose, () =>
    wrap<boolean>(() => {
      gateway = null;
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
      attachProject(snapshot.root);
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
    wrap<CardWriteResult>(() => writeCardDoc(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.docRead, (_event, payload: { path: string }) =>
    wrap<DocSnapshot>(() => requireGateway().readDoc(payload.path)),
  );

  ipcMain.handle(
    CHANNELS.docWrite,
    (_event, payload: { path: string; content: string; baseHash?: string }) =>
      wrap<DocSnapshot>(() => requireGateway().writeDoc(payload.path, payload.content, payload.baseHash)),
  );

  ipcMain.handle(CHANNELS.docRename, (_event, payload: { from: string; to: string }) =>
    wrap<boolean>(async () => {
      await requireGateway().renameDoc(payload.from, payload.to);
      return true;
    }),
  );

  ipcMain.handle(CHANNELS.outlineRead, () =>
    wrap<OutlineState>(() => readOutlineState(requireGateway())),
  );

  ipcMain.handle(CHANNELS.outlineGenerate, (_event, payload: OutlineGeneratePayload) =>
    wrap<OutlineMutateResult>(() => generateOutline(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.outlineWrite, (_event, payload: OutlineWritePayload) =>
    wrap<OutlineMutateResult>(() => writeOutline(requireGateway(), payload)),
  );

  ipcMain.handle(CHANNELS.outlineCreateChapter, (_event, payload: OutlineCreateChapterPayload) =>
    wrap<OutlineChapterDraftResult>(() => createOutlineChapter(requireGateway(), payload)),
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
    wrap<AiAdoptResult>(() => adoptDraft(requireGateway(), payload)),
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
    wrap<IndexStatusPayload>(() => readIndexStatus(requireGateway())),
  );

  ipcMain.handle(CHANNELS.indexRebuild, (_event, payload?: IndexRebuildPayload) =>
    wrap<IndexRebuildResultPayload>(() => rebuildProjectIndex(requireGateway(), payload ?? {})),
  );

  ipcMain.handle(CHANNELS.indexSearch, (_event, payload: { keyword: string; limit?: number }) =>
    wrap<IndexSearchResultPayload>(() =>
      searchProjectIndex(requireGateway(), payload.keyword, payload.limit ?? 20),
    ),
  );

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

  /* ---------- 章节编辑器（M2 / T2-1 切片 A） ---------- */

  ipcMain.handle(CHANNELS.chapterRead, (_event, payload: { path: string }) =>
    wrap<ChapterReadResult>(() => readChapter(requireGateway(), payload.path)),
  );

  ipcMain.handle(CHANNELS.chapterWrite, (_event, payload: ChapterWritePayload) =>
    wrap<ChapterWriteResult>(() => writeChapterBody(requireGateway(), payload)),
  );

  // 冲突旁路（T2-6 切片）：把当前编辑内容写入 <章节>.conflict-<时间戳>.md，主文件不动
  ipcMain.handle(CHANNELS.chapterWriteSidecar, (_event, payload: ChapterSidecarPayload) =>
    wrap<ChapterSidecarResult>(() => writeChapterSidecar(requireGateway(), payload)),
  );
}