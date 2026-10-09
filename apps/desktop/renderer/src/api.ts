import type {
  AiRejectPayload,
  AiFeedbackState,
  AiAdoptPayload,
  AiAdoptResult,
  AiConfigState,
  AiDraftTarget,
  AiGeneratePayload,
  AiSaveConfigPayload,
  AiCostPanelPayload,
  TextFixBodyPayload,
  TextFixBodyResultPayload,
  TextProofreadPanelPayload,
  TextProofreadPayload,
  RuleCatalogPayload,
  RuleDryRunPayload,
  RuleDryRunResult,
  ConsistencyCheckPayload,
  ConsistencyReportPayload,
  AiCostPayload,
  AiStartResult,
  AiStreamEvent,
  AiUsageState,
  AppFlushDonePayload,
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
  IndexProgressPayload,
  IndexRebuildPayload,
  IndexRebuildResultPayload,
  IndexSearchResultPayload,
  IndexStatusPayload,
  LibraryViewPayload,
  MemoryAssemblePayload,
  MemoryAssemblyResult,
  MemoryDeleteFactPayload,
  MemoryInjectionPreviewPayload,
  MemoryInjectionPreviewResult,
  MemoryContextSnapshotPayload,
  MemoryContextSnapshotResult,
  MemoryRagPreviewPayload,
  MemoryRagPreviewResult,
  ExtractAdoptPayload,
  ExtractAdoptResult,
  ExtractPreviewPayload,
  ExtractPreviewResult,
  MemorySaveFactPayload,
  MemorySaveFactResult,
  MemorySaveSummaryPayload,
  MemorySaveSummaryResult,
  MemoryStatePayload,
  MemorySummarizePayload,
  MemorySummarizeResult,
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
  RecoveryEntry,
  RecoveryWritePayload,
  SessionStatusPayload,
  SnapshotRestoreResultPayload,
  SnapshotStatePayload,
  SnapshotTakeResultPayload,
  StatsActivityPayload,
  StatsSetGoalPayload,
  StatsStatePayload,
  GitCommitPayload,
  GitCommitResultPayload,
  GitRollbackPayload,
  GitRollbackResultPayload,
  GitStatePayload,
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
    /** AI 总开关（A4）：true 才允许三个 LLM 入口联网；状态由主进程回传 */
    setEnabled: (enabled: boolean) => Promise<AiConfigState>;
    setKey: (providerId: string, apiKey: string) => Promise<boolean>;
    /** 加密保存 provider Key（T3-14）：密文入 .yushu/secrets.json，真源只写 key_ref；返回值不含密钥本体 */
    saveKey: (providerId: string, apiKey: string) => Promise<AiConfigState>;
    /** 清除凭据（T3-14）：删密文条目 + 去掉真源 key_ref */
    clearKey: (providerId: string) => Promise<AiConfigState>;
    drafts: () => Promise<AiDraftTarget[]>;
    context: (payload?: { volumeId?: string; chapterId?: string }) => Promise<ContextPreviewPayload>;
    start: (payload: AiGeneratePayload) => Promise<AiStartResult>;
    abort: (streamId: string) => Promise<boolean>;
    adopt: (payload: AiAdoptPayload) => Promise<AiAdoptResult>;
    usage: () => Promise<AiUsageState>;
    /** Token 与成本面板（T3-12，J09）：按任务/模型分解 + 预估vs实付偏差 + 缓存编排核对 */
    cost: (payload?: AiCostPayload) => Promise<AiCostPanelPayload>;
    /** 候选拒绝原因记录（T3-11，J15）：写入 .yushu/ai-feedback.jsonl 并回传统计 */
    reject: (payload: AiRejectPayload) => Promise<AiFeedbackState>;
    /** 拒绝原因统计（本机） */
    feedback: () => Promise<AiFeedbackState>;
    /** 订阅流式事件（ai:event 单向推送）；返回取消订阅函数 */
    onEvent: (handler: (event: AiStreamEvent) => void) => () => void;
  };
  /** 中文自查（T3-13，J14）：两个方法都只读——fixBody 只回改后正文，不写盘 */
  text: {
    proofread: (payload: TextProofreadPayload) => Promise<TextProofreadPanelPayload>;
    fixBody: (payload: TextFixBodyPayload) => Promise<TextFixBodyResultPayload>;
  };
  /** 规则 DSL 目录与沙箱试算（M4/T4-1，R51）：两个方法都是只读 */
  rule: {
    catalog: () => Promise<RuleCatalogPayload>;
    dryRun: (payload: RuleDryRunPayload) => Promise<RuleDryRunResult>;
  };
  /** 一致性体检（M4/T4-4 三态时机）：只读，结论不落盘 */
  consistency: {
    check: (payload?: ConsistencyCheckPayload) => Promise<ConsistencyReportPayload>;
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
    /**
     * 订阅重建进度（T2-5 切片 B：解析 / 分片写入 / 段合并；主进程单向推送）；
     * 返回取消订阅函数。
     */
    onProgress: (handler: (progress: IndexProgressPayload) => void) => () => void;
  };
  naming: {
    generate: (payload: NamingGeneratePayload) => Promise<NamingResultPayload>;
  };
  library: {
    /** 稿件总览（T2-4 切片 A：全库视图；全部章节 + 草稿状态 / 字数汇总） */
    list: () => Promise<LibraryViewPayload>;
  };
  app: {
    /** 通用剪贴板写入（走主进程 Electron clipboard，生产 file:// 下更可靠） */
    writeClipboard: (text: string) => Promise<boolean>;
    /**
     * 订阅「关闭窗口前落盘」请求（T2-6 完整版；主进程拦截窗口 close 后推送）；
     * 渲染层 flush 完毕须调用 flushDone() 回执。返回取消订阅函数。
     */
    onBeforeClose: (handler: () => void) => () => void;
    /** 落盘完成回执（单向发送；载荷供主进程记录日志） */
    flushDone: (payload?: AppFlushDonePayload) => void;
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
  recovery: {
    /** 编辑日志（T2-8）：写入当前正文快照（输入期间短防抖调用；保存成功后须 clearJournal） */
    writeJournal: (payload: RecoveryWritePayload) => Promise<boolean>;
    /** 清除某章节的编辑日志 */
    clearJournal: (path: string) => Promise<boolean>;
    /** 进入项目时检测可恢复条目（journal 与磁盘不一致才返回） */
    list: () => Promise<RecoveryEntry[]>;
    /** 丢弃某章节的编辑日志 */
    discard: (path: string) => Promise<boolean>;
  };
  snapshot: {
    /** 快照列表与 blob 占用统计（T2-7 切片 A：内容寻址快照，60s / 环形 20） */
    state: () => Promise<SnapshotStatePayload>;
    /** 立即快照（手动 = 强制生成，不受 60s 最小间隔限制） */
    take: () => Promise<SnapshotTakeResultPayload>;
    /** 整体回滚到指定快照（恢复前自动生成 pre_restore 快照；快照后新增文件保守保留） */
    restore: (id: string) => Promise<SnapshotRestoreResultPayload>;
  };
  session: {
    /** 会话异常退出检测（T2-8 切片 B）：上次会话异常退出信息 + 最近快照（含脏快照提示） */
    status: () => Promise<SessionStatusPayload>;
  };
  stats: {
    /** 码字统计（T2-9 切片 A）：今日 / 日序列 / 周月汇总 / 目标 / 断更与连续天数 */
    read: () => Promise<StatsStatePayload>;
    /** 设置每日目标（0 = 清除目标） */
    setGoal: (payload: StatsSetGoalPayload) => Promise<{ daily: number }>;
    /** 写作活动心跳（T2-9 切片 C）：编辑输入期间节流上报（活跃时长 / 会话）；失败由调用方静默 */
    activity: () => Promise<StatsActivityPayload>;
  };
  git: {
    /** Git 版本管理（T2-7 切片 B）：状态 / 变更 / 最近提交 */
    state: () => Promise<GitStatePayload>;
    /** 初始化仓库（main 分支；幂等） */
    init: () => Promise<GitStatePayload>;
    /** 提交全部变更（一次批量改动 = 一次提交） */
    commit: (payload: GitCommitPayload) => Promise<GitCommitResultPayload>;
    /** 整体回滚到指定提交（工作区语义：不改写历史；回滚前强制 pre_restore 快照） */
    rollback: (payload: GitRollbackPayload) => Promise<GitRollbackResultPayload>;
  };
  memory: {
    /** 五层记忆（T3-5）：摘要 / 事实台账（含出处校验）/ 目标 / 体检发现 / 跨项目拒绝清单 */
    state: () => Promise<MemoryStatePayload>;
    /** AI 摘要候选（生成不入库——采纳是用户显式动作） */
    summarize: (payload: MemorySummarizePayload) => Promise<MemorySummarizeResult>;
    /** 摘要入库：origin=ai（人工已修订 rev>0 时拒绝覆盖）/ origin=human（rev+1，冻结 AI 自动覆盖） */
    saveSummary: (payload: MemorySaveSummaryPayload) => Promise<MemorySaveSummaryResult>;
    /** 事实登记（出处可选：章节实体 id + 字符区间 [start, end)） */
    saveFact: (payload: MemorySaveFactPayload) => Promise<MemorySaveFactResult>;
    /** 删除事实（携带读时 hash 并发检测） */
    deleteFact: (payload: MemoryDeleteFactPayload) => Promise<boolean>;
    /** 注入预演（T3-6）：对指定章节输出注入计划（决策 + 排除原因 + token 估算） */
    injectionPreview: (payload: MemoryInjectionPreviewPayload) => Promise<MemoryInjectionPreviewResult>;
    /** 上下文组装（T3-7）：固定槽位顺序 + 槽位 cap + 全局预算裁剪 + 去重（决策与证据） */
    assemble: (payload: MemoryAssemblePayload) => Promise<MemoryAssemblyResult>;
    /** RAG 检索预演（T3-8）：向量路 + 关键词路并行 → RRF 融合 → 可选重排（只读） */
    ragPreview: (payload: MemoryRagPreviewPayload) => Promise<MemoryRagPreviewResult>;
    /** 上下文快照导出（T3-9）：组装 + 决策证据写入 .yushu/context-log/（可复现指纹） */
    contextSnapshot: (payload: MemoryContextSnapshotPayload) => Promise<MemoryContextSnapshotResult>;
  };
  extract: {
    /** 设定抽取预演（T3-10）：JSON Schema 契约 + 后校验 + 修复回喂；候选一律 status=candidate（不入库） */
    preview: (payload: ExtractPreviewPayload) => Promise<ExtractPreviewResult>;
    /** 采纳抽取候选（写设定卡真源）：仅 new 候选允许（服务端复核——augment/conflict 明确拒绝） */
    adopt: (payload: ExtractAdoptPayload) => Promise<ExtractAdoptResult>;
  };
}

export function api(): YushuApi {
  const w = window as unknown as { yushu?: YushuApi };
  if (!w.yushu) {
    throw new Error("preload 未注入 yushu API（请通过 Electron 启动）");
  }
  return w.yushu;
}