/**
 * IPC 契约（docs/03 §3）：一消息一方法；渲染层只能经 preload 白名单调用。
 * 本文件是通道名与载荷类型的唯一事实源（preload.cjs 中的通道名需与之保持一致）。
 * 说明：本文件保持零依赖（不 import 引擎包），仅用结构类型描述跨进程数据。
 */

export const CHANNELS = {
  projectOpen: "project:open",
  projectClose: "project:close",
  projectTree: "project:tree",
  /** 当前已挂载项目的快照（未打开项目时返回 null） */
  projectCurrent: "project:current",
  projectChooseDirectory: "project:chooseDirectory",
  projectCreate: "project:create",
  projectWorld: "project:world",
  packCatalog: "pack:catalog",
  packFuse: "pack:fuse",
  cardList: "card:list",
  cardRead: "card:read",
  cardWrite: "card:write",
  docRead: "doc:read",
  docWrite: "doc:write",
  docRename: "doc:rename",
  outlineRead: "outline:read",
  outlineGenerate: "outline:generate",
  outlineWrite: "outline:write",
  outlineCreateChapter: "outline:createChapter",
  aiConfig: "ai:config",
  aiSaveConfig: "ai:saveConfig",
  aiSetKey: "ai:setKey",
  aiDrafts: "ai:drafts",
  aiContext: "ai:context",
  aiStart: "ai:start",
  aiAbort: "ai:abort",
  aiAdopt: "ai:adopt",
  aiUsage: "ai:usage",
  /** 主进程 → 渲染层的流式事件（单向推送，非 invoke） */
  aiEvent: "ai:event",
  exportPreview: "export:preview",
  exportRun: "export:run",
  exportClipboard: "export:clipboard",
  indexStatus: "index:status",
  indexRebuild: "index:rebuild",
  indexSearch: "index:search",
  indexProgress: "index:progress",
  /** 稿件总览（T2-4 切片 A：全库视图） */
  libraryList: "library:list",
  namingGenerate: "naming:generate",
  /** 通用剪贴板写入（主进程 Electron clipboard；渲染层 file:// 下 navigator.clipboard 不可靠） */
  appWriteClipboard: "app:writeClipboard",
  /** 主进程 → 渲染层：请求关闭窗口前落盘（T2-6 完整版；单向推送，非 invoke） */
  appBeforeClose: "app:beforeClose",
  /** 渲染层 → 主进程：落盘完成回执（单向 send；主进程据此真正关闭窗口，或超时兜底） */
  appFlushDone: "app:flushDone",
  chapterRead: "chapter:read",
  chapterWrite: "chapter:write",
  chapterWriteSidecar: "chapter:writeSidecar",
  /** 编辑日志（T2-8 切片 A·崩溃恢复）：写入 / 清除 / 检测列表 / 丢弃 */
  recoveryWriteJournal: "recovery:writeJournal",
  recoveryClearJournal: "recovery:clearJournal",
  recoveryList: "recovery:list",
  recoveryDiscard: "recovery:discard",
  /** 本地快照（T2-7 切片 A·内容寻址）：状态 / 立即快照 / 整体回滚 */
  snapshotState: "snapshot:state",
  snapshotTake: "snapshot:take",
  snapshotRestore: "snapshot:restore",
  /** 会话异常退出检测（T2-8 切片 B）：打开项目后读取检出结果与快照新鲜度 */
  sessionStatus: "session:status",
  /** 码字统计（T2-9 切片 A）：读取统计 / 设置目标 */
  statsRead: "stats:read",
  statsSetGoal: "stats:setGoal",
  statsActivity: "stats:activity",
  /** Git 版本管理（T2-7 切片 B：状态 / 初始化 / 提交 / 整体回滚） */
  gitState: "git:state",
  gitInit: "git:init",
  gitCommit: "git:commit",
  gitRollback: "git:rollback",
  /** 五层记忆（M3 / T3-5）：状态 / AI 摘要候选 / 摘要入库 / 事实登记 / 事实删除 / 注入预演（T3-6） */
  memoryState: "memory:state",
  memorySummarize: "memory:summarize",
  memorySaveSummary: "memory:saveSummary",
  memorySaveFact: "memory:saveFact",
  memoryDeleteFact: "memory:deleteFact",
  memoryInjectionPreview: "memory:injectionPreview",
  /** 上下文组装（T3-7）：固定槽位顺序 + 预算裁剪 + 去重（决策与证据） */
  memoryAssemble: "memory:assemble",
  /** RAG 检索预演（T3-8）：向量路 + 关键词路并行 → RRF 融合 → 可选重排（只读） */
  memoryRagPreview: "memory:ragPreview",
  /** 上下文快照导出（T3-9）：组装 + 决策证据写入 .yushu/context-log/（可复现指纹） */
  memoryContextSnapshot: "memory:contextSnapshot",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * 关闭前 flush 的渲染层回执（app:flushDone 单向载荷）。
 * 主进程仅记录日志（判定以窗口关闭流程为准：回执到达即放行，否则超时兜底）。
 */
export interface AppFlushDonePayload {
  /** 渲染层存在编辑器视图且已调用落盘（未在编辑时为 false，无内容可落） */
  editorFlushed?: boolean;
  /** 编辑器回传细节（调度器状态等，诊断用） */
  detail?: string;
  /** 落盘失败原因（冻结 / IPC 异常等；不阻塞关闭） */
  error?: string;
}

/** 编辑日志写入载荷（T2-8 切片 A）：编辑器当前正文快照 */
export interface RecoveryWritePayload {
  /** 章节文件相对路径（仅 chapters/ 前缀；journal 只服务章节编辑器） */
  path: string;
  /** 编辑器当前正文（未含 frontmatter） */
  body: string;
}

/** 可恢复条目（journal 与磁盘不一致时才出现在列表中） */
export interface RecoveryEntry {
  path: string;
  body: string;
  /** journal 写入时间（ISO；损坏时为旧值或空） */
  updatedAt: string;
  wordCount: number;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  /** 文件修改时间（ISO；仅文件条目）——索引增量的 mtime+hash 快速判定用 */
  mtime?: string;
}

export interface ProjectSnapshot {
  root: string;
  tree: TreeEntry[];
}

export interface DocSnapshot {
  path: string;
  content: string;
  /** 内容 sha256；写操作必须携带读时的 hash 做并发检测 */
  hash: string;
}

/** 四维派系取值 + 感情线开关（与 @yushu/core GenreAxes 结构兼容） */
export interface AxisValues {
  channel: string[];
  world: string[];
  technique: string[];
  tone: string[];
  romance_mode_default?: string;
}

export interface PackLintSummary {
  ok: boolean;
  errors: number;
  warnings: number;
  messages: string[];
}

export interface PackSummary {
  id: string;
  name: string;
  version: string;
  license: string;
  genreAxes: AxisValues;
  lint: PackLintSummary;
}

export interface PackCatalog {
  wordlist: {
    channel: string[];
    world: string[];
    technique: string[];
    tone: string[];
    romance: string[];
  };
  packs: PackSummary[];
}

export interface FusionAdded {
  piece: string;
  ref: string;
  pack: string;
}

export interface FusionOverridden {
  piece: string;
  name: string;
  refs: { pack: string; ref: string }[];
  winner: string;
}

export interface FusionConflict {
  kind: string;
  severity: "error" | "warn";
  message: string;
  packs: string[];
}

export interface FusionPreview {
  packs: string[];
  genreAxes: AxisValues;
  added: FusionAdded[];
  overridden: FusionOverridden[];
  conflicts: FusionConflict[];
  ready: boolean;
}

export interface CreateProjectPayload {
  dir: string;
  title: string;
  packIds: string[];
  axes: AxisValues;
}

/* ---------- 设定卡（docs/03 §5.2 的结构化子集） ---------- */

export interface CardRelationRef {
  relation: string;
  target: string;
}

export interface CardPayload {
  /** 新建时可省略：由引擎按 type 前缀 + 名称生成稳定 ID */
  id?: string;
  type: string;
  name: string;
  layer?: string;
  aliases?: string[];
  refs?: CardRelationRef[];
  source_chapters?: string[];
  visibility?: string;
  format_version?: number;
  /** 派系包 schema 扩展字段（如境界体系卡的 realms） */
  extensions?: Record<string, unknown>;
}

export interface CardSummary {
  path: string;
  id: string;
  type: string;
  name: string;
  layer: string;
  visibility: string;
  aliases: string[];
  /** 解析失败时携带的错误信息（卡片仍会出现在列表中以便修复） */
  error?: string;
}

export interface CardReadResult {
  path: string;
  card: CardPayload;
  body: string;
  hash: string;
}

export interface CardWritePayload {
  /** 省略时按 card.type + card.id 推导（world/cards/<type>/<id>.md） */
  path?: string;
  card: CardPayload;
  body: string;
  /** 编辑既有卡时必须携带（创建新卡时省略） */
  baseHash?: string;
}

export interface CardWriteResult {
  path: string;
  hash: string;
  /** 扩展字段校验的告警（如未知字段 ignore_with_warning） */
  warnings: string[];
}

export interface WorldSummary {
  id: string;
  title: string;
  layers: Record<string, boolean>;
  genreAxes: AxisValues;
}

/* ---------- 三级大纲（docs/01 §4.4 / I02；结构与 @yushu/world-engine Outline 兼容） ---------- */

export interface OutlineBrief {
  who: string;
  where: string;
  goal: string;
  obstacle: string;
  turn: string;
  result: string;
  hook: string;
}

export interface OutlineChapterPayload {
  /** 新建时可为空：由世界引擎补齐（co-*） */
  id: string;
  idx: number;
  title: string;
  brief: OutlineBrief;
  /** 已一键创建草稿章节时回填（与 Chapter.outline_ref 双向映射） */
  chapter_id?: string;
  scene_ids: string[];
}

export interface OutlineVolumePayload {
  /** 新建时可为空：由世界引擎补齐（vol-*） */
  id: string;
  title: string;
  act: string;
  desc: string;
  climax?: string;
  hook?: string;
  checklist?: string[];
  chapters: OutlineChapterPayload[];
}

export interface OutlineDocPayload {
  apiVersion: string;
  format_version: number;
  id: string;
  source_template?: string;
  master: {
    title: string;
    logline: string;
    theme: string;
    notes: string;
    acts: { name: string; desc: string; chapters_hint?: string }[];
  };
  volumes: OutlineVolumePayload[];
}

/** 派系包大纲模板摘要（一键生成入口） */
export interface OutlineTemplateSummary {
  /** 全局限定 ID：packId/templateId */
  id: string;
  packId: string;
  title: string;
  description?: string;
  acts: { name: string; desc: string; chapters_hint?: string }[];
  /** 模板默认规模（来自 suggested_volumes / chapters_hint 下限） */
  defaultVolumeCount: number;
  defaultChaptersPerVolume: number;
  /** 模板解析失败时携带错误（该模板在 UI 中禁用） */
  error?: string;
}

export interface OutlineState {
  path: string;
  exists: boolean;
  /** 读时的内容 sha256（写操作与重新生成必须携带） */
  hash?: string;
  doc?: OutlineDocPayload;
  templates: OutlineTemplateSummary[];
}

export interface OutlineGeneratePayload {
  /** 模板限定 ID（来自 OutlineState.templates）；空字符串 = 空白创建（不使用模板） */
  templateId: string;
  title: string;
  volumeCount?: number;
  chaptersPerVolume?: number;
  /** 大纲已存在时必须携带（覆盖前先经用户确认） */
  baseHash?: string;
}

export interface OutlineWritePayload {
  doc: OutlineDocPayload;
  baseHash: string;
}

export interface OutlineMutateResult {
  path: string;
  hash: string;
  doc: OutlineDocPayload;
}

export interface OutlineCreateChapterPayload {
  volumeId: string;
  chapterId: string;
  /** 大纲当前 hash（回填 chapter_id 前做并发检测） */
  baseHash: string;
}

export interface OutlineChapterDraftResult extends OutlineMutateResult {
  chapterPath: string;
  chapterId: string;
  /** true = 章节草稿此前已存在，本次仅回填映射 */
  reused: boolean;
}

/* ---------- AI 副驾（S4/S5；T1-13 ~ T1-17；结构与 @yushu/llm 兼容） ---------- */

/** 上下文槽位（稳定前缀置头；上下文预览器的数据源） */
export interface ContextSlotPayload {
  /** system_prompt | world_core | world_constraints | outline_chapter | recent_prose */
  slot: string;
  /** true = 稳定前缀（prompt caching 断点前，内容不随章节变化） */
  stable: boolean;
  source: string;
  chars: number;
  truncated: boolean;
  text: string;
}

/** 生成后轻提示（T1-14 最小版；重型规则校验留待 M4） */
export interface DraftHintPayload {
  /** 输出中命中的设定卡名 */
  referenced: string[];
  hints: string[];
}

export interface ContextPreviewPayload {
  slots: ContextSlotPayload[];
  /** 稳定前缀字符数（M1 粗预算；M3 换 token 预算） */
  stableChars: number;
  totalChars: number;
  /** prompt caching 断点（最后一个 stable 槽位名） */
  cacheBreakpointAfter: string;
  worldTitle: string;
  layers: Record<string, boolean>;
  cardIndex: { id: string; name: string; aliases: string[]; visibility: string; layer: string }[];
  constraints: string[];
  target?: {
    volumeId: string;
    chapterId: string;
    title: string;
    chapterPath: string;
    hasProse: boolean;
  };
}

/** Provider 模型载荷（T3-1：能力矩阵合并保守默认后下发，供 UI 展示） */
export interface AiModelPayload {
  name: string;
  tier: string;
  capabilities: {
    tools: boolean;
    structured_output: boolean;
    stream: boolean;
    usage: boolean;
    reasoning: boolean;
    vision: boolean;
    batch: boolean;
    cache?: { mode: string; min_tokens?: number; read_mult?: number; write_mult?: number };
  };
  limits?: { context?: number; max_output?: number; rpm?: number; tpm?: number };
}

export interface AiProviderPayload {
  id: string;
  /** cloud | local（T3-1） */
  kind: string;
  /** openai_chat | anthropic_messages | gemini_generate */
  protocol: string;
  base_url: string;
  /** ≥1；models[0] 为默认模型 */
  models: AiModelPayload[];
  /** 只记录环境变量名；明文 key 禁止落盘（docs/03 §13） */
  api_key_env?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface AiProviderKeyState {
  provider_id: string;
  api_key_env?: string;
  has_session_key: boolean;
  has_env_key: boolean;
  /** 无需 key 或 key 已就绪 */
  ready: boolean;
}

/** 任务路由与可靠性载荷（T3-2；来自 config/routing.yaml 或内置默认） */
export interface AiRoutingState {
  path: string;
  exists: boolean;
  routes: { task: string; prefer: string[]; require: string[] }[];
  fallback: Record<string, string[]>;
  reliability: {
    num_retries: number;
    retry_policy: {
      kind: string;
      max_retries: number;
      backoff: string;
      base_delay_ms: number;
      max_delay_ms: number;
    }[];
    cooldown: { allowed_fails: number; window_s: number; cooldown_s: number };
    concurrency: { global: number; per_provider: Record<string, number> };
  };
}

/** Provider 配置体检提示（T3-4：能力差异标注；来自 @yushu/llm lintLlmConfig） */
export interface AiConfigWarning {
  provider_id: string;
  model?: string;
  message: string;
}

/** 本地模型预设（T3-4：Ollama / LM Studio / llama.cpp / vLLM；provider 为预构造好的可用载荷） */
export interface AiLocalPreset {
  id: string;
  label: string;
  note: string;
  provider: AiProviderPayload;
}

export interface AiConfigState {
  path: string;
  exists: boolean;
  hash?: string;
  config: { apiVersion: string; format_version: number; providers: AiProviderPayload[] };
  /** 任务路由与可靠性（T3-2） */
  routing: AiRoutingState;
  /** 配置体检提示（T3-4：能力差异标注，非阻断） */
  warnings: AiConfigWarning[];
  /** 本地模型预设（T3-4；由主进程下发，UI 一键添加） */
  localPresets: AiLocalPreset[];
  keyStates: AiProviderKeyState[];
  /** 至少一个 provider 可用；false 时生成按钮禁用（离线时本地功能不受影响） */
  canGenerate: boolean;
}

export interface AiSaveConfigPayload {
  providers: AiProviderPayload[];
  /** 配置已存在时必须携带（覆盖前经确认） */
  baseHash?: string;
}

/** 可生成目标：已创建草稿章节的章纲 */
export interface AiDraftTarget {
  volumeId: string;
  volumeTitle: string;
  volumeAct: string;
  /** 章纲 ID（co-*） */
  chapterId: string;
  title: string;
  idx: number;
  chapterPath: string;
  hasBody: boolean;
  wordCount: number;
}

export interface AiGeneratePayload {
  /** 客户端生成的流 ID（先于 invoke 确定，避免首个增量与返回值的竞态）；缺省由主进程生成 */
  streamId?: string;
  volumeId: string;
  /** 章纲 ID */
  chapterId: string;
  task: "draft-first" | "continue";
  instruction?: string;
  targetWords?: number;
}

export interface AiStartResult {
  streamId: string;
}

/** 流式事件（主进程 → 渲染层，经 ai:event 单向推送） */
export type AiStreamEvent =
  | { streamId: string; type: "delta"; text: string; chars: number }
  | { streamId: string; type: "fallback"; providerId: string; reason: string }
  /** T3-3：能力矩阵驱动的降级提示（如模型未声明 stream → 一次性返回） */
  | { streamId: string; type: "downgrade"; message: string }
  | {
      streamId: string;
      type: "done";
      text: string;
      chars: number;
      aborted: boolean;
      providerId: string;
      model: string;
      usageId: string;
      hints: DraftHintPayload;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }
  | { streamId: string; type: "error"; code: string; message: string };

export interface AiAdoptPayload {
  /** 生成记录 ID（采纳留痕关联） */
  usageId: string;
  volumeId: string;
  chapterId: string;
  text: string;
  mode: "replace" | "append";
}

export interface AiAdoptResult {
  chapterPath: string;
  hash: string;
  wordCount: number;
  chars: number;
}

export interface AiUsageEntryPayload {
  id: string;
  time: string;
  type: "generate" | "adopt";
  task?: string;
  provider_id?: string;
  model?: string;
  status?: "ok" | "aborted" | "error";
  chars?: number;
  chapter_id?: string;
  usage_id?: string;
}

export interface AiUsageState {
  path: string;
  entries: AiUsageEntryPayload[];
}

/* ---------- 导出与敏感词自查（S6；T1-18/19/20；结构与 @yushu/export 兼容） ---------- */

export interface ReconcileRowPayload {
  chapterId: string;
  title: string;
  volumeTitle: string;
  /** frontmatter 记录字数 */
  stated: number;
  /** 正文实际字数 */
  actual: number;
  matched: boolean;
}

export interface SensitiveHitPayload {
  word: string;
  severity: "error" | "warn" | "info";
  suggestion?: string;
  note?: string;
  platforms?: string[];
  wordlistId: string;
  wordlistVersion: string;
  chapterId: string;
  chapterTitle: string;
  volumeTitle: string;
  /** 命中位置（章内正文字符下标） */
  index: number;
  context: string;
}

export interface WordlistInfoPayload {
  id: string;
  version: string;
  source?: string;
  entries: number;
}

/** 写词库失败/被跳过的文件（项目内词库解析失败不阻断内置词库） */
export interface SkippedWordlistPayload {
  path: string;
  error: string;
}

export interface ExportPreviewPayload {
  bookTitle: string;
  volumes: number;
  chapters: number;
  totalWords: number;
  /** 尚未创建草稿章节的章纲数（不计入导出） */
  missingDrafts: number;
  reconcile: ReconcileRowPayload[];
  hits: SensitiveHitPayload[];
  hitTotal: number;
  bySeverity: { error: number; warn: number; info: number };
  wordlists: WordlistInfoPayload[];
  /** 合并后参与扫描的词条数（同词条后者覆盖前者） */
  wordEntryCount: number;
  skippedWordlists: SkippedWordlistPayload[];
  /** 词库扫描目录（外置可更新：仓库内置 + 项目内覆盖） */
  wordlistDirs: string[];
}

export interface ExportRunPayload {
  /** 防手滑（T1-20）：必须显式为 true，服务端同样校验 */
  confirmed: boolean;
  includeToc?: boolean;
  stripMarkers?: boolean;
}

export interface ExportRunResult {
  path: string;
  hash: string;
  chapters: number;
  words: number;
  /** 无错误级敏感词命中（提示级不阻断） */
  clean: boolean;
}

export interface ClipboardPayload {
  stripComments?: boolean;
  stripAiMarks?: boolean;
}

export interface ClipboardResult {
  chapters: number;
  words: number;
  /** 复制内容前 160 字预览（便于确认复制了什么） */
  preview: string;
  /** 复制路径：Electron 系统剪贴板 */
  target: string;
}

/* ---------- 检索索引（S7；T1-21/22；结构与 @yushu/search 兼容） ---------- */

export interface IndexStatsPayload {
  schemaVersion: number;
  builtAt: string;
  files: number;
  entities: number;
  refs: number;
  chunks: number;
  /**
   * FTS5 真实索引行数（影子表 `chunks_fts_docsize`；应与 chunks 一致——不一致即索引滞后/损坏）。
   * 注意：不可用 `count(*) FROM chunks_fts`（external content 会回落到 content 表、恒等于 chunks）。
   */
  ftsRows: number;
}

/** 保存即增量（T2-5 切片 B）：写通道成功后的后台索引刷新状态（随 index:status 一并返回） */
export interface IndexRefreshState {
  /** 已调度待执行（防抖窗口内） */
  pending: boolean;
  /** 正在执行增量刷新 */
  running: boolean;
  /** 最近一次自动刷新完成时间（ISO；从未执行过为 null） */
  lastRunAt: string | null;
  /** 最近一次自动刷新错误（不阻断写通道，下次保存后自动重试） */
  lastError: string | null;
}

export interface IndexStatusPayload {
  /** 相对路径：.yushu/index.db */
  path: string;
  exists: boolean;
  stats: IndexStatsPayload | null;
  schemaVersion: number;
  /** 自动增量刷新状态（readIndexStatus 本身不产生该字段，由 IPC 层合并） */
  refresh?: IndexRefreshState;
}

/** 索引重建进度（T2-5 切片 B：分片写入与 FTS 段合并的可观测性；经 index:progress 单向推送） */
export interface IndexProgressPayload {
  /** parse = 读取/解析真源文件；files = 写入文件/实体/引用表；chunks = 正文块 + FTS 分片写入；merge = FTS 段合并 */
  phase: "parse" | "files" | "chunks" | "merge";
  done: number;
  total: number;
  /** 当前文件 / 批次末条所属文件（展示用） */
  currentPath?: string;
}

export interface IndexRebuildResultPayload extends IndexStatusPayload {
  stats: IndexStatsPayload;
  /** 解析失败被跳过的真源文件 */
  skipped: { path: string; error: string }[];
  /** full = 全量重建；incremental = 增量（复用未变文件） */
  mode: "full" | "incremental";
  /** 增量：未变而直接复用的文件数（含仅 mtime 刷新的文件） */
  reusedFiles: number;
  /** 增量：重新解析的文件数（新增 + 内容变更） */
  updatedFiles: number;
  /** 增量：真源已删除、从索引移除的文件数 */
  removedFiles: number;
  /** 完整性校验失败项（非空表示本次因自愈回退为全量重建） */
  integrityIssues: string[];
  /** 全量重建的正文块分片批次数（T2-5 切片 B；增量路径为 0） */
  shards: number;
  /** 解析执行位置（T2-11 切片 A/B）：utility = utilityProcess 只读解析（全量与增量）；main = 回退主进程 */
  parseVia: "utility" | "main";
}

/** 重建请求（T2-5：默认全量；incremental=true 时增量，索引缺失/损坏自动回退全量） */
export interface IndexRebuildPayload {
  incremental?: boolean;
}

export interface IndexChunkHitPayload {
  chunkId: string;
  path: string;
  kind: string;
  chapterId?: string;
  volume?: string;
  charStart: number;
  charEnd: number;
  textHash: string;
  entities: string[];
  /** 命中片段（【】标记高亮） */
  snippet: string;
}

export interface IndexEntityHitPayload {
  id: string;
  type: string;
  layer: string;
  name: string;
  aliases: string[];
  filePath: string;
}

export interface IndexSearchResultPayload {
  keyword: string;
  chunks: IndexChunkHitPayload[];
  entities: IndexEntityHitPayload[];
}

/* ---------- 稿件总览（T2-4 切片 A：全库视图 + 虚拟滚动） ---------- */

export interface LibraryChapterEntry {
  volumeId: string;
  volumeTitle: string;
  /** 章纲 id（co-*） */
  chapterId: string;
  /** 章序（卷内） */
  idx: number;
  title: string;
  /** 已建草稿的章节文件相对路径；未建草稿为 null */
  chapterPath: string | null;
  /** 字数（frontmatter 记录值；缺失时按正文回算） */
  wordCount: number;
  /** 章节状态（frontmatter status；未建草稿为空串） */
  status: string;
}

export interface LibraryViewPayload {
  bookTitle: string;
  chapters: LibraryChapterEntry[];
  totals: { chapters: number; drafted: number; words: number };
}

/* ---------- 命名生成器（S2；T1-8） ---------- */

export type NamingKindPayload = "character" | "place" | "sect" | "technique";

export interface NamingGeneratePayload {
  kind: NamingKindPayload;
  count?: number;
  /** 显式种子（可复现）；缺省为主进程时间戳 */
  seed?: number | string;
  /** 指定文化规则 id（缺省按世界维度自动推导） */
  culture?: string;
}

export interface NamingResultPayload {
  rulesId: string;
  rulesTitle: string;
  /** 构词模式说明 */
  pattern: string;
  seed: string;
  names: string[];
}

/* ---------- 章节编辑器（M2；T2-1 切片 A：源码形态） ---------- */

export interface ChapterReadResult {
  path: string;
  title: string;
  /** 正文（不含 frontmatter） */
  body: string;
  /** frontmatter 记录字数 */
  wordCount: number;
  hash: string;
}

export interface ChapterWritePayload {
  path: string;
  body: string;
  /** 读时的内容 hash（并发检测，防覆盖） */
  baseHash: string;
}

export interface ChapterWriteResult {
  path: string;
  hash: string;
  /** 保存后同步回 frontmatter 的字数（与导出对账口径一致） */
  wordCount: number;
}

/* ---------- 保存管线（M2 / T2-6 切片：冲突旁路） ---------- */

export interface ChapterSidecarPayload {
  path: string;
  body: string;
}

export interface ChapterSidecarResult {
  /** 旁路文件相对路径：<章节>.conflict-<时间戳>.md（主文件不动） */
  sidecarPath: string;
  hash: string;
  wordCount: number;
}

/* ---------- 本地快照（M2 / T2-7 切片 A：内容寻址快照） ---------- */

/**
 * auto = 自动（60s 最小间隔，非强制）；manual = 手动（强制）；
 * pre_restore = 恢复前自动（强制）；pre_destructive = 破坏性操作前自动（强制，T2-8 切片 B）
 */
export type SnapshotReasonPayload = "auto" | "manual" | "pre_restore" | "pre_destructive";

export interface SnapshotSummaryPayload {
  /** snap-YYYYMMDD-HHMMSS-<rand4>（字典序 = 时间序） */
  id: string;
  createdAt: string;
  reason: SnapshotReasonPayload;
  /** 快照覆盖的源文件数 */
  files: number;
  /** 源文件内容总字节（blob 去重后实际占用通常更小） */
  bytes: number;
}

export interface SnapshotStatePayload {
  /** 最新在前 */
  snapshots: SnapshotSummaryPayload[];
  blobCount: number;
  blobBytes: number;
}

export interface SnapshotTakeResultPayload {
  /** taken = 已生成；unchanged = 与最新快照内容一致；too_soon = 距上一份不足最小间隔（自动策略） */
  outcome: "taken" | "unchanged" | "too_soon";
  snapshot?: SnapshotSummaryPayload;
  /** 当前最新一份（未生成新快照时的参照） */
  latest?: SnapshotSummaryPayload;
}

export interface SnapshotRestoreResultPayload {
  id: string;
  /** 恢复前自动生成的 pre_restore 快照 ID（内容未变时为现有最新一份；可再回滚） */
  preRestoreId: string;
  preRestoreTaken: boolean;
  restoredFiles: number;
  /** 快照中记录、磁盘上已被删除而本次重建的文件 */
  recreatedFiles: number;
  /** 磁盘上存在、但不在该快照中的文件（保守保留，不删除） */
  extraFiles: string[];
}

/* ---------- 会话异常退出检测（M2 / T2-8 切片 B） ---------- */

/** 上次会话异常退出的信息（state=active 且 pid ≠ 当前进程时检出） */
export interface SessionAbnormalExitPayload {
  startedAt: string;
  /** 上次会话的心跳时间（60s 随快照循环刷新） */
  lastSeenAt: string;
}

export interface SessionStatusPayload {
  /** 本次打开项目时检出的上次异常退出（正常退出 / 无历史会话为 null） */
  abnormalExit: SessionAbnormalExitPayload | null;
  /** 当前最新一份快照（无快照为 null） */
  lastSnapshot: SnapshotSummaryPayload | null;
  /** 脏快照提示：最近快照早于上次会话的最后可见时间（或无快照）→ 可能不含崩溃前的最后修改 */
  snapshotStale: boolean;
}

/* ---------- 码字统计（M2 / T2-9 切片 A/B/C） ---------- */

/** 单日聚合（本地时区日期键） */
export interface StatsDailyEntryPayload {
  /** YYYY-MM-DD */
  date: string;
  /** 当日净增字数（删改可为负） */
  delta: number;
  /** 当日计入的保存次数（delta=0 的保存不计） */
  saves: number;
  /** 当日平台口径有效字数净增（去空白换算，T2-9 切片 B；旧数据 / 缺失为 0） */
  effective: number;
  /** 当日活跃时长（毫秒；T2-9 切片 C：输入心跳按空闲阈值累计，旧数据 / 缺失为 0） */
  activeMs: number;
  /** 当日写作会话数（T2-9 切片 C：首次活动 / 跨日 / 超空闲阈值开启新会话；旧数据 / 缺失为 0） */
  sessions: number;
}

/** 速度曲线单点（T2-9 切片 B）：当日净增 + 7 日滑动平均（字/天；缺失日按 0 计入窗口） */
export interface StatsSpeedPointPayload {
  date: string;
  delta: number;
  avg: number;
}

export interface StatsStatePayload {
  /** 每日目标（0 = 未设目标） */
  goal: { daily: number };
  /** 今日（无记录时 delta=0 / saves=0 / effective=0 / activeMs=0 / sessions=0） */
  today: StatsDailyEntryPayload;
  /** 今日真实速度（字/分钟；T2-9 切片 C）：净增 / 活跃分钟；活跃不足 1 分钟或净增非正为 null（UI 显示「—」） */
  todaySpeedCpm: number | null;
  /** 按日期升序（最多 90 天，供柱状图 / 热力图） */
  daily: StatsDailyEntryPayload[];
  /** 最近 30 天连续速度序列（含今日，补零；供速度曲线） */
  speed: StatsSpeedPointPayload[];
  /** 平台档位参考（番茄全勤口径：basic=4,000 / advanced=6,000；I08 §3） */
  tiers: { basic: number; advanced: number };
  summary: {
    /** 最近 7 天（含今日） */
    week: number;
    /** 最近 30 天（含今日） */
    month: number;
    /** 全部历史 */
    total: number;
    /** 最近 30 天有效字数合计（切片 B） */
    monthEffective: number;
    /** 有记录的活跃天数 */
    activeDays: number;
    /** total / activeDays（四舍五入；无记录为 0） */
    avgActiveDay: number;
    bestDay: StatsDailyEntryPayload | null;
  };
  /** 断更：距最后活跃日的天数（今天写过 = 0；从未写过 = null） */
  daysSinceLastWriting: number | null;
  /** 连续写作天数（含最后活跃日向前回推；从未写过 = 0） */
  streakDays: number;
}

export interface StatsSetGoalPayload {
  /** 每日目标字数（0 清除目标；必须为 ≥0 的整数） */
  daily: number;
}

/** 写作活动心跳回执（T2-9 切片 C：编辑器输入期间节流上报） */
export interface StatsActivityPayload {
  /** 今日累计活跃时长（毫秒） */
  activeMs: number;
  /** 今日会话数 */
  sessions: number;
}

/* ---------- Git 版本管理（M2 / T2-7 切片 B） ---------- */

/** 工作区变更（纳入范围 = 内容白名单且排除 .yushu / exports / node_modules） */
export interface GitChangePayload {
  path: string;
  /** new = 新增；modified = 内容变更；deleted = 真源已删除 */
  state: "new" | "modified" | "deleted";
}

/** 最近提交条目 */
export interface GitCommitEntryPayload {
  oid: string;
  shortOid: string;
  message: string;
  author: string;
  /** 毫秒时间戳 */
  timestamp: number;
}

export interface GitStatePayload {
  /** 仓库是否已初始化（`.git/` 存在） */
  initialized: boolean;
  branch: string | null;
  /** HEAD 短 oid（空仓库为 null） */
  head: string | null;
  changes: GitChangePayload[];
  log: GitCommitEntryPayload[];
}

/** 提交请求（一次性提交全部变更：一次批量改动 = 一次提交） */
export interface GitCommitPayload {
  message: string;
}

export interface GitCommitResultPayload {
  oid: string;
  shortOid: string;
  message: string;
  /** 本次提交包含的文件数 */
  files: number;
}

/** 整体回滚请求（工作区语义：不改写历史，HEAD 不动） */
export interface GitRollbackPayload {
  oid: string;
}

export interface GitRollbackResultPayload {
  oid: string;
  shortOid: string;
  /** 写回（提交中存在、内容不同的现有文件） */
  restored: number;
  /** 重建（提交中存在、磁盘缺失） */
  recreated: number;
  /** 磁盘上存在、该提交中不存在的文件（保守保留，列出不删除） */
  kept: string[];
  /** 回滚前强制生成的 pre_restore 快照 id（撤销窗口） */
  preRestoreId: string | null;
}

/* ---------- 五层记忆（M3 / T3-5；T3-6 注入控制；结构与 @yushu/memory 兼容） ---------- */

/** 注入配置（T3-6；docs/03 §10.1 injection） */
export interface InjectionConfigPayload {
  /** always=常驻 / trigger=别名·提及关键词命中才注入 / manual=手动清单显式指定 */
  mode: "always" | "trigger" | "manual";
  /** 预算耗尽时高者先留（0-100） */
  priority: number;
  position: "after_system" | "near_start" | "near_end";
  /** 单项预算（token 估算；超限截断） */
  budget_tokens: number;
  /** 叙事可见性门控：早于该章不注入（章节实体 id） */
  reveal_gate?: string;
}

/** 注入计划条目（决策结果，可解释） */
export interface InjectionPlanEntryPayload {
  id: string;
  layer: "world_core" | "fact" | "volume_summary" | "chapter_summary";
  title: string;
  position: InjectionConfigPayload["position"];
  priority: number;
  mode: InjectionConfigPayload["mode"];
  /** 注入文本（按 budget_tokens 截断后） */
  text: string;
  tokens: number;
  truncated: boolean;
  matched_keys: string[];
  reason: string;
}

/** 排除条目（带原因：门控未到 / 未命中关键词 / 不在手动清单） */
export interface InjectionExclusionPayload {
  id: string;
  layer: InjectionPlanEntryPayload["layer"];
  title: string;
  code: "reveal_gate" | "no_trigger" | "no_manual";
  reason: string;
}

export interface MemoryInjectionPreviewPayload {
  /** 目标章节（章节实体 id） */
  chapterId: string;
  /** 手动清单（mode=manual 的显式指定） */
  manualIds?: string[];
}

export interface MemoryInjectionPreviewResult {
  chapterId: string;
  chapterTitle: string;
  /** 全局章序（1-based） */
  chapterOrdinal: number;
  chapterPath: string;
  mentionChars: number;
  entries: InjectionPlanEntryPayload[];
  excluded: InjectionExclusionPayload[];
  totals: { injected: number; excluded: number; tokens: number };
}

/* ---------- 上下文组装（T3-7；结构与 @yushu/memory assemble 兼容） ---------- */

export interface MemoryAssemblePayload {
  chapterId: string;
  manualIds?: string[];
  /** 总预算（token 估算；缺省 32000） */
  budget_total?: number;
}

export interface AssembledItemPayload {
  id: string;
  title: string;
  text: string;
  tokens: number;
  truncated: boolean;
  priority: number;
  recency: number;
  stable: boolean;
  source?: string;
  /** 触发命中键（T3-9 预览器「命中键」列） */
  matched_keys: string[];
}

export interface AssembledSlotPayload {
  slot: string;
  mode: string;
  cap_tokens: number;
  items: AssembledItemPayload[];
  tokens: number;
  truncated: boolean;
}

export interface AssemblyDropPayload {
  id: string;
  slot: string;
  /** cap=槽位上限；budget=全局预算逐出；recent_n=近 N 条窗口；by_id / by_similarity=去重 */
  reason: "cap" | "budget" | "recent_n" | "by_id" | "by_similarity";
  detail: string;
  tokens: number;
}

export interface MemoryAssemblyResult {
  chapterId: string;
  chapterTitle: string;
  chapterOrdinal: number;
  chapterPath: string;
  slots: AssembledSlotPayload[];
  stableTokens: number;
  totalTokens: number;
  budget_total: number;
  dropped: AssemblyDropPayload[];
  dedup: { by_id: number; by_similarity: number };
  truncatedItems: number;
  /** RAG 检索（T3-8）接入回执：ok=检索命中已进 rag_chunks 槽位；skipped=未构建索引（组装不阻断） */
  rag?: AssemblyRagPayload;
}

/** 组装时 RAG 检索接入回执（T3-8） */
export interface AssemblyRagPayload {
  status: "ok" | "skipped";
  query: string;
  /** 进入 rag_chunks 槽位的条数 */
  hits: number;
  /** 向量实现：sqlite-vec / cosine（本地兜底）/ 空（跳过） */
  store: string;
  note?: string;
}

/* ---------- RAG 检索预演（T3-8；结构与 @yushu/search ragSearch 兼容） ---------- */

export interface MemoryRagPreviewPayload {
  /** 目标章节（章节实体 id） */
  chapterId: string;
  /** 查询词（缺省 = 自动查询：章纲 + 最近正文尾部） */
  query?: string;
  /** 每路召回上限（缺省 50） */
  pathLimit?: number;
  /** 融合输出条数（缺省 20） */
  limit?: number;
  /** >0 启用本地启发式重排（UI 启用时传 6） */
  rerankTopK?: number;
  weights?: { vector?: number; keyword?: number };
}

export interface RagHitPayload {
  chunkId: string;
  path: string;
  kind: string;
  /** 出处：章节实体 id + 字符区间 + 块文本 hash */
  chapterId?: string;
  volume?: string;
  charStart: number;
  charEnd: number;
  textHash: string;
  entities: string[];
  text: string;
  snippet?: string;
  score: number;
  rank: number;
  sources: {
    vector?: { rank: number; score: number };
    keyword?: { rank: number; score: number };
  };
  rerank?: { rank: number; score: number; reason: string };
}

export interface MemoryRagPreviewResult {
  chapterId: string;
  chapterTitle: string;
  chapterOrdinal: number;
  /** 自动查询串（章纲 + 最近正文尾部） */
  autoQuery: string;
  query: string;
  querySource: "custom" | "auto";
  /** 向量实现（sqlite-vec = 扩展可用；cosine = 本地确定性嵌入兜底） */
  store: "sqlite-vec" | "cosine";
  storeNote: string;
  dim: number;
  vectorRows: number;
  repairedVectors: number;
  rrfK: number;
  weights: { vector: number; keyword: number };
  paths: { vector: number; keyword: number };
  fused: RagHitPayload[];
  reranked: RagHitPayload[];
}

/* ---------- 上下文快照（T3-9；结构与 @yushu/memory ContextSnapshot 兼容） ---------- */

export interface MemoryContextSnapshotPayload {
  chapterId: string;
  /** 总预算（token 估算；缺省 32000——小预算用于实证「被截断项」标记） */
  budget_total?: number;
}

export interface MemoryContextSnapshotResult {
  /** 快照文件相对路径（.yushu/context-log/……） */
  path: string;
  /** 决策内容 sha256（除 generated_at 外全部字段；同一输入两次导出一致） */
  fingerprint: string;
  generatedAt: string;
  bytes: number;
  totalTokens: number;
  truncatedItems: number;
}

/**
 * 摘要记录（卷/章）：真源为 memory/<layer>/<id>.md（Markdown + frontmatter）；
 * `summary_rev > 0` = 人工已修订（AI 不得覆盖，只能作为候选展示——红线保护）。
 */
export interface MemorySummaryPayload {
  layer: "volume_summary" | "chapter_summary";
  /** 卷摘要 = 卷纲 id（vol-*）；章摘要 = 章节实体 id（ch-*） */
  id: string;
  volume_id?: string;
  summary_rev: number;
  updated_at: string;
  text: string;
  /** 相对路径（memory/volumes/…… 或 memory/chapters/……） */
  path: string;
  /** 读时内容 sha256（更新时必须携带 baseHash） */
  hash: string;
}

/** 摘要目标（有正文素材的卷 / 章；「记忆」页列表的数据源） */
export interface MemoryTargetPayload {
  layer: "volume_summary" | "chapter_summary";
  /** 卷摘要 = 卷纲 id；章摘要 = 章节实体 id（ch-*） */
  id: string;
  title: string;
  volume_id?: string;
  volume_title?: string;
  /** 摘要素材字符数（章 = 正文长度；卷 = 各章正文之和） */
  sourceChars: number;
  hasSummary: boolean;
  summaryRev: number;
}

/** 事实级记忆：provenance 为出处校验结果（正文改动 → broken，绝不静默沿用） */
export interface MemoryFactPayload {
  id: string;
  keys: string[];
  text: string;
  updated_at: string;
  path: string;
  hash: string;
  source?: { chapter_id: string; start: number; end: number; hash: string };
  provenance: "ok" | "broken" | "none";
  provenance_note?: string;
  /** 注入配置（T3-6；缺省合并默认后下发，供 UI 展示） */
  injection: InjectionConfigPayload;
}

/** 记录体检发现（lintMemory）：跨项目泄漏 = error（红线）；无出处事实 = warn */
export interface MemoryFindingPayload {
  severity: "error" | "warn";
  code: string;
  record_id: string;
  message: string;
}

/** 跨项目记录（被拒绝进入本项目记忆；仅展示，不参与注入） */
export interface MemoryRejectedPayload {
  path: string;
  record_id: string;
  project_id: string;
  reason: string;
}

export interface MemoryStatePayload {
  /** 记忆真源目录（memory/；无记录时目录可能尚未创建） */
  dir: string;
  /** 当前项目命名空间（world.yaml 的 world.id） */
  project_id: string;
  summaries: MemorySummaryPayload[];
  targets: MemoryTargetPayload[];
  facts: MemoryFactPayload[];
  findings: MemoryFindingPayload[];
  rejected: MemoryRejectedPayload[];
}

export interface MemorySummarizePayload {
  layer: "volume_summary" | "chapter_summary";
  /** 目标 id：卷纲 vol-* / 章节实体 ch-* */
  id: string;
  /** 章摘要所属卷（素材定位与入库分组用；缺省时按大纲查找） */
  volumeId?: string;
}

/** 摘要候选（不自动入库——采纳是用户显式动作） */
export interface MemorySummarizeResult {
  layer: "volume_summary" | "chapter_summary";
  id: string;
  text: string;
  chars: number;
  provider_id: string;
  model: string;
}

export interface MemorySaveSummaryPayload {
  layer: "volume_summary" | "chapter_summary";
  id: string;
  volume_id?: string;
  text: string;
  /** ai = AI 候选入库（rev > 0 → 拒绝覆盖 E_MEMORY_REV_PROTECTED）；human = 人工编辑（rev+1） */
  origin: "ai" | "human";
  /** 更新既有摘要时必须携带（读时 hash）；新建省略 */
  baseHash?: string;
}

export interface MemorySaveSummaryResult {
  path: string;
  hash: string;
  summary_rev: number;
  updated_at: string;
}

export interface MemorySaveFactPayload {
  /** 省略时自动生成 fact-* */
  id?: string;
  /** 触发关键词（实体名 / 别名） */
  keys: string[];
  text: string;
  /** 出处（可选）：章节实体 id + 字符区间 [start, end)；提供时服务端读取正文计算摘录 hash */
  provenance?: { chapter_id: string; start: number; end: number };
  /** 注入配置（T3-6；省略时保留既有配置 / 新建用默认） */
  injection?: InjectionConfigPayload;
  /** 更新既有事实时必须携带 */
  baseHash?: string;
}

export interface MemorySaveFactResult {
  path: string;
  hash: string;
  id: string;
  provenance: "ok" | "none";
}

export interface MemoryDeleteFactPayload {
  id: string;
  /** 读时 hash（删除前并发检测，防误删外部修改版） */
  baseHash: string;
}

export interface IpcOk<T> {
  ok: true;
  data: T;
}

export interface IpcError {
  ok: false;
  error: { code: string; message: string };
}

export type IpcResult<T> = IpcOk<T> | IpcError;