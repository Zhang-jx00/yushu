import type {
  AiAdoptPayload,
  AiAdoptResult,
  AiConfigState,
  AiDraftTarget,
  AiGeneratePayload,
  AiSaveConfigPayload,
  AiStartResult,
  AiStreamEvent,
  AiUsageState,
  CardReadResult,
  CardSummary,
  CardWritePayload,
  CardWriteResult,
  ChapterReadResult,
  ChapterSidecarPayload,
  ChapterSidecarResult,
  ChapterWritePayload,
  ChapterWriteResult,
  ClipboardPayload,
  ClipboardResult,
  ContextPreviewPayload,
  CreateProjectPayload,
  DocSnapshot,
  ExportPreviewPayload,
  ExportRunPayload,
  ExportRunResult,
  FusionPreview,
  IndexRebuildPayload,
  IndexRebuildResultPayload,
  IndexSearchResultPayload,
  IndexStatusPayload,
  NamingGeneratePayload,
  NamingResultPayload,
  OutlineChapterDraftResult,
  OutlineCreateChapterPayload,
  OutlineGeneratePayload,
  OutlineMutateResult,
  OutlineState,
  OutlineWritePayload,
  PackCatalog,
  ProjectSnapshot,
  TreeEntry,
  WorldSummary,
} from "../../src/shared/ipc";

/** preload 注入到 window.yushu 的 API 形状（与 preload.cjs 保持一致） */
export interface YushuApi {
  project: {
    open: (payload?: { path?: string }) => Promise<ProjectSnapshot | null>;
    close: () => Promise<boolean>;
    tree: () => Promise<TreeEntry[]>;
    /** 当前已挂载项目的快照（未打开项目时为 null） */
    current: () => Promise<ProjectSnapshot | null>;
    chooseDirectory: () => Promise<string | null>;
    create: (payload: CreateProjectPayload) => Promise<ProjectSnapshot>;
    world: () => Promise<WorldSummary | null>;
  };
  pack: {
    catalog: () => Promise<PackCatalog>;
    fuse: (packIds: string[]) => Promise<FusionPreview>;
  };
  card: {
    list: () => Promise<CardSummary[]>;
    read: (path: string) => Promise<CardReadResult>;
    write: (payload: CardWritePayload) => Promise<CardWriteResult>;
  };
  doc: {
    read: (path: string) => Promise<DocSnapshot>;
    write: (path: string, content: string, baseHash?: string) => Promise<DocSnapshot>;
    rename: (from: string, to: string) => Promise<void>;
  };
  outline: {
    read: () => Promise<OutlineState>;
    generate: (payload: OutlineGeneratePayload) => Promise<OutlineMutateResult>;
    write: (payload: OutlineWritePayload) => Promise<OutlineMutateResult>;
    createChapter: (payload: OutlineCreateChapterPayload) => Promise<OutlineChapterDraftResult>;
  };
  ai: {
    config: () => Promise<AiConfigState>;
    saveConfig: (payload: AiSaveConfigPayload) => Promise<AiConfigState>;
    setKey: (providerId: string, apiKey: string) => Promise<boolean>;
    drafts: () => Promise<AiDraftTarget[]>;
    context: (payload?: { volumeId?: string; chapterId?: string }) => Promise<ContextPreviewPayload>;
    start: (payload: AiGeneratePayload) => Promise<AiStartResult>;
    abort: (streamId: string) => Promise<boolean>;
    adopt: (payload: AiAdoptPayload) => Promise<AiAdoptResult>;
    usage: () => Promise<AiUsageState>;
    /** 订阅流式事件（ai:event 单向推送）；返回取消订阅函数 */
    onEvent: (handler: (event: AiStreamEvent) => void) => () => void;
  };
  export: {
    preview: () => Promise<ExportPreviewPayload>;
    run: (payload: ExportRunPayload) => Promise<ExportRunResult>;
    clipboard: (payload?: ClipboardPayload) => Promise<ClipboardResult>;
  };
  index: {
    status: () => Promise<IndexStatusPayload>;
    /** 重建索引：默认全量；`{ incremental: true }` 增量（复用未变文件，损坏时自动自愈为全量） */
    rebuild: (payload?: IndexRebuildPayload) => Promise<IndexRebuildResultPayload>;
    search: (keyword: string, limit?: number) => Promise<IndexSearchResultPayload>;
  };
  naming: {
    generate: (payload: NamingGeneratePayload) => Promise<NamingResultPayload>;
  };
  app: {
    /** 通用剪贴板写入（走主进程 Electron clipboard，生产 file:// 下更可靠） */
    writeClipboard: (text: string) => Promise<boolean>;
  };
  chapter: {
    /** 读取章节正文（不含 frontmatter）与记录字数 */
    read: (path: string) => Promise<ChapterReadResult>;
    /** 保存正文（自动同步 word_count；携带 baseHash 并发检测） */
    write: (payload: ChapterWritePayload) => Promise<ChapterWriteResult>;
    /**
     * 冲突旁路（T2-6）：把当前编辑内容写入 <章节>.conflict-<时间戳>.md（同目录，主文件不动）。
     * 自动保存因 baseHash 冲突冻结时，由用户显式触发，绝不静默覆盖。
     */
    writeSidecar: (payload: ChapterSidecarPayload) => Promise<ChapterSidecarResult>;
  };
}

export function api(): YushuApi {
  const w = window as unknown as { yushu?: YushuApi };
  if (!w.yushu) {
    throw new Error("preload 未注入 yushu API（请通过 Electron 启动）");
  }
  return w.yushu;
}