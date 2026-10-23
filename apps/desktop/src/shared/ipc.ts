/* SPDX-License-Identifier: Apache-2.0 */
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
  /** AI 总开关（A4）：主进程侧唯一事实源，**默认关闭**；关闭时任何 LLM 入口一律 E_AI_DISABLED */
  aiSetEnabled: "ai:setEnabled",
  /** 加密保存 provider Key（T3-14）：密文落 .yushu/secrets.json，真源只写 key_ref */
  aiSaveKey: "ai:saveKey",
  /** 清除 provider 凭据（T3-14）：删密文条目并去掉真源 key_ref */
  aiClearKey: "ai:clearKey",
  aiDrafts: "ai:drafts",
  aiContext: "ai:context",
  aiStart: "ai:start",
  aiAbort: "ai:abort",
  aiAdopt: "ai:adopt",
  /** 写作 UX（T3-11）：候选拒绝原因记录 / 统计（J15） */
  aiReject: "ai:reject",
  aiFeedback: "ai:feedback",
  aiUsage: "ai:usage",
  /** Token 与成本面板（T3-12，J09）：双口径聚合 + 稳定前缀编排核对（只读） */
  aiCost: "ai:cost",
  /** 中文自查（T3-13，J14）：只读检测（不改稿） */
  textProofread: "text:proofread",
  /** 中文自查（T3-13）：按用户已确认的条目返回**改后正文**（写盘仍走编辑器既有保存路径） */
  textFixBody: "text:fixBody",
  /** 规则目录（M4/T4-1，R51）：项目所选派系包携带的全部规则；**只读** */
  ruleCatalog: "rule:catalog",
  /** 规则沙箱试算：**只读**，只吃调用方给的 JSON 夹具，不读正文、不写盘 */
  ruleDryRun: "rule:dryRun",
  /** 一致性体检（M4/T4-4 三态时机）：**只读**，结论只算不落盘 */
  consistencyCheck: "consistency:check",
  /** 影响传播预览（M4/T4-5）：真源只读，提案写进派生区 `.yushu/proposals/` */
  propagatePreview: "propagate:preview",
  /** 提案清单（派生区读） */
  proposalList: "proposal:list",
  /** 逐条决策：accept/reject/pending 只改派生提案文件，真源不动 */
  proposalDecide: "proposal:decide",
  /** 写回真源（R62）：**真源写操作**，走 wrapWrite；只应用已 accept 的条目 */
  proposalApply: "proposal:apply",
  /** 伏笔台账看板（M4/T4-6，R66）：**只读**——判定层纯函数，桌面端只负责读真源并画表 */
  foreshadowBoard: "foreshadow:board",
  /** 时间线视图与冲突（M4/T4-7，R68）：**只读**；历法切换只影响显示，不写任何文件 */
  timelineView: "timeline:view",
  /** 关系图谱（M4/T4-9，R69）：**只读真源**（entities/refs 直算，不碰 SQLite） */
  graphRelation: "graph:relation",
  /** 世界地图（M5/T5-1，R120）：**只读**（图片底图 + bounds + 分层 + 标注，K08 §3） */
  worldMapView: "map:view",
  /** 世界地图底图（R123）：**只读**（把作者登记的底图读成 data URL，路径防护同一切片） */
  worldMapBase: "map:base",
  /** 世界地图底图·**作者侧登记**（R135）：**写盘**（挑一张图 ⇒ 拷进项目 ⇒ bounds 按量出来的像素尺寸自动填） */
  worldMapUploadBase: "map:uploadBase",
  /**
   * 世界地图·**框定边界**（R138）：**写盘**（作者在底图上**拖出**一块 ⇒ 写 map.yaml 的 `bounds`）。
   * 口径回源 K08 §3.6「地图 = 图片底图 + bounds → 用户上传底图并**框定 bounds**」。
   */
  worldMapSetBounds: "map:setBounds",
  /**
   * 世界地图·**挪标注**（R139）：**写盘**（作者在图上把标注拖到新位置 ⇒ 改 map.yaml 里**那一个**标注的 x / y）。
   * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」。
   */
  worldMapSetMarker: "map:setMarker",
  /**
   * 世界地图·**放标注**（R140）：**写盘**（作者选一个地点实体 ⇒ 在图上点一下 ⇒ 落一个标注）。
   * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」。
   */
  worldMapCreateMarker: "map:createMarker",
  /**
   * 世界地图·**挪事件锚点**（R141）：**写盘**（作者在图上把锚点拖到新位置 ⇒ 改 map.yaml 里**那一个**锚点的 x / y）。
   */
  worldMapSetAnchor: "map:setAnchor",
  /**
   * 世界地图·**放事件锚点**（R142）：**写盘**（作者选一个事件 ⇒ 在图上点一下 ⇒ 落一个锚点）。
   * 口径回源 K08 §3.8：事件可挂坐标 ⇒ 选事件能定位到地图上。
   */
  worldMapCreateAnchor: "map:createAnchor",
  /** 编年史（M4/T4-8，R71）：**只读**；复用时间线的刻度与历法，不另建年表 */
  chronicleBook: "chronicle:book",
  /** 爽点与期待感看板（M4/T4-10，R73）：**只读**；阈值不传就不判定，判定全在引擎 */
  satisfactionBoard: "satisfaction:board",
  /** 存量导入·挑文件（M5/T5-7，R77）：主进程原生对话框结果登记进闸门，**只回票据不回路径** */
  importPick: "import:pick",
  /** 存量导入·预演（M5/T5-7，R77）：**只读**——凭票读字节算编码/清洗/分章报告，零写入 */
  importPreview: "import:preview",
  /** 存量导入·入库（M5/T5-7，R79）：**真源写操作**，走 wrapWrite；建卷 + 建章纲 + 写草稿 + 逐章对账 */
  importApply: "import:apply",
  /** 存量导入·AI 二次筛选切章（M5/T5-7 第二段，R107）：**只读**——只改计划，不写盘 */
  importAiSplit: "import:aiSplit",
  /** 存量导入·人工校正切分（M5/T5-7 第二段，R107）：**只读**——只改计划，不写盘 */
  importCorrect: "import:correct",
  /** 存量导入·取消（M5/T5-7 第三段，R108）：作废票据 + 记一次取消（正在入库的话在章的边界上停） */
  importCancel: "import:cancel",
  /** 存量导入·任务清单（M5/T5-7 第三段，R108）：**只读**——可续跑的任务记录 */
  importJobs: "import:jobs",
  /** 主进程 → 渲染层的流式事件（单向推送，非 invoke） */
  aiEvent: "ai:event",
  exportPreview: "export:preview",
  exportRun: "export:run",
  exportClipboard: "export:clipboard",
  /** 世界圣经（设定集）预览（M5/T5-5，R98）：只读，不落盘 */
  biblePreview: "bible:preview",
  /** 世界圣经（设定集）导出（M5/T5-5，R98）：写 exports/ 派生物，与 export:run 同一类 */
  bibleRun: "bible:run",
  /** 项目迁移包·挑目标目录（M3/T3-14 后半，R101）：原生对话框结果只登记成票据，路径不出主进程 */
  projectExportPick: "project:exportPick",
  /** 项目迁移包·预览（R101）：只读，报清单 / 跳过理由 / 要剥几条明文密钥 */
  projectExportPreview: "project:exportPreview",
  /** 项目迁移包·导出（R101）：写到**项目外**的目录，凭票据解析；本项目真源一个字节不动 */
  projectExportRun: "project:exportRun",
  /** 视角看板·预览（M4/T4-2 第三批，R102）：只读，读 config/pov.yaml + 章 frontmatter */
  povPreview: "pov:preview",
  /** 视角看板·保存策略（R102）：先解析后落盘，写的是真源 config/pov.yaml ⇒ 走 wrapWrite */
  povWriteConfig: "pov:writeConfig",
  /** 视角看板·绑定本章视角（R102）：只改章 frontmatter 的 pov，正文与字数不动 */
  povSetChapter: "pov:setChapter",
  indexStatus: "index:status",
  indexRebuild: "index:rebuild",
  indexSearch: "index:search",
  indexProgress: "index:progress",
  /** 稿件总览（T2-4 切片 A：全库视图） */
  libraryList: "library:list",
  /** 发布状态看板（M5/T5-6，R105）：**只读**——状态分组 / 定时提醒 / 字数闸，判定层在引擎 */
  publishBoard: "publish:board",
  /** 改发布状态（M5/T5-6）：**真源写**（章 frontmatter 的 status + 发布台账留痕） */
  publishSetStatus: "publish:setStatus",
  /** 设定 / 清除定时发布（M5/T5-6）：**真源写**（章 frontmatter 的 publish_at） */
  publishSchedule: "publish:schedule",
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
  /** 批量补摘要候选（T5-9 第二段，R106）：与预算护栏联动、分批推进；产出的也只是候选 */
  memorySummarizeBatch: "memory:summarizeBatch",
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
  /** 设定抽取预演 / 采纳（T3-10）：候选一律 status=candidate，用户确认后入库 */
  extractPreview: "extract:preview",
  extractAdopt: "extract:adopt",
} as const;

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
  /**
   * 定价（T3-12，J09）：**每 1M tokens 单价**；缺省 = 未配置价格，
   * 成本面板只报 token、金额标注「未配置价格」，绝不按市场价猜。
   * 载荷原样回传才能保住手工写在 llm.yaml 里的价格（saveConfig 是全量替换 providers）。
   */
  pricing?: {
    currency?: string;
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
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
  /** 凭据库引用（T3-14）：指向 `.yushu/secrets.json` 里的密文条目；真源仍不含密钥字面值 */
  key_ref?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface AiProviderKeyState {
  provider_id: string;
  api_key_env?: string;
  /** 该 provider 声明的凭据库引用（T3-14；未声明为 undefined） */
  key_ref?: string;
  has_session_key: boolean;
  has_env_key: boolean;
  /** 凭据库里存在该 key_ref 的密文条目（不代表能解密成功） */
  has_stored_key: boolean;
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
  /**
   * 加密后端（Electron safeStorage）当前是否可用（T3-14）：
   * false 时 UI 禁用「加密保存」并如实说明原因——宁可禁用也不降级把明文写进文件。
   */
  keyBackendAvailable: boolean;
  /** **AI 总开关的当前状态**（A4）：由主进程持有、默认 false——「可整体关闭」必须是进程事实而非按钮状态 */
  aiEnabled: boolean;
  /** 至少一个 provider 可用；false 时生成按钮禁用（离线时本地功能不受影响） */
  canGenerate: boolean;
  /** 批量任务的半价通道规划（T3-11，J08/J09）：batch_eligible 任务 → batch / sync（含原因） */
  channels: { task: string; channel: string; eligible: boolean; note: string }[];
}

export interface AiSaveConfigPayload {
  providers: AiProviderPayload[];
  /** 配置已存在时必须携带（覆盖前经确认） */
  baseHash?: string;
}

/**
 * 加密保存 API Key（T3-14，ai:saveKey）。
 * `apiKey` 是**单向** renderer→main 载荷：任何返回值（AiConfigState）只含 key_ref 与三态布尔，
 * 密钥本体绝不回流渲染层。
 */
export interface AiSaveKeyPayload {
  providerId: string;
  apiKey: string;
}

/** AI 总开关（A4，ai:setEnabled）：true 才允许 LLM 入口发起请求 */
export interface AiSetEnabledPayload {
  enabled: boolean;
}

/** 清除凭据（T3-14，ai:clearKey）：删凭据库密文条目 + 去掉真源的 key_ref */
export interface AiClearKeyPayload {
  providerId: string;
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
  /** 多候选生成（T3-11，J15）：第 i 个（1 起）与总数（≥2 时主进程注入「独立生成」标记） */
  candidateIndex?: number;
  candidateTotal?: number;
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
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        /** 命中缓存的输入（T3-12 归一口径：与 prompt_tokens 不重叠） */
        cached_tokens?: number;
        /** 写入缓存的输入（Anthropic cache_creation） */
        cache_write_tokens?: number;
      };
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
  /**
   * 采纳后即时轻校验（M4 / T4-4 的 post-generate）。**总是带上**：
   * 跑成了给结论，没跑成给 `ran:false + error`——采纳已经落盘，这时抛错会让作者重复采纳。
   */
  audit: AiAdoptAuditPayload;
}

/** 轻校验回执（范围来自刚采纳的正文，其余计数沿用体检报告口径） */
export interface AiAdoptAuditPayload {
  ran: boolean;
  /** 未跑成的原因（跑成时为空串） */
  error: string;
  scopeIds: string[];
  entries: ConsistencyEntryPayload[];
  /** 因不在本次范围内而未展示的条数 */
  filteredOut: number;
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
  /** 通道归属（T3-11，J08/J09）：batch = 半价通道；sync = 标准通道 */
  channel?: "batch" | "sync";
  /** usage 实报 token（T3-12；缺省 = provider 未回传 usage → 只有估算口径） */
  tokens?: CostTokensPayload;
  /** 本地估算 token（T3-12）：prompt = 发送前按消息体估算；completion = 已生成部分估算 */
  estimate?: CostTokensPayload;
}

/** Token 四段（互不重叠；与 @yushu/llm 的 CostTokens 同形） */
export interface CostTokensPayload {
  prompt?: number;
  completion?: number;
  cached?: number;
  cache_write?: number;
}

/* ---------- 候选拒绝原因（T3-11，J15 实践 6） ---------- */

/** 预置拒绝原因标签（J15：太水/跑偏/人设不符/OOC/风格不符/战力崩 + 自由文本） */
export const REJECT_REASON_PRESETS = ["太水", "跑偏", "人设不符", "OOC", "风格不符", "战力崩", "其他"] as const;

export interface AiRejectPayload {
  /** 关联生成记录（usage_id） */
  usageId?: string;
  task?: string;
  /** 预置标签或自由文本 */
  reason: string;
  note?: string;
  /** 被拒候选摘录（建议 ≤200 字） */
  excerpt: string;
}

export interface AiFeedbackEntryPayload {
  time: string;
  task?: string;
  reason: string;
  note?: string;
  excerpt: string;
  usage_id?: string;
}

export interface AiFeedbackState {
  path: string;
  total: number;
  counts: { reason: string; count: number }[];
  /** 最近条目（倒序，展示用） */
  entries: AiFeedbackEntryPayload[];
}

export interface AiUsageState {
  path: string;
  entries: AiUsageEntryPayload[];
}

/* ---------- Token 与成本面板（T3-12，J09；只读聚合，不改真源） ---------- */

/** 请求体：按哪个章节的组装做缓存编排核对（未提供则只聚合，不核对编排） */
export interface AiCostPayload {
  volumeId?: string;
  chapterId?: string;
}

/** 聚合行（与 @yushu/llm 的 CostAggregateRow 同形，跨 IPC 传递） */
export interface CostRowPayload {
  key: string;
  entries: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** 单一币种时的金额；全部未配置价格或币种混合时为 null（绝不强行合计） */
  cost: number | null;
  currency: string | null;
  costByCurrency: Record<string, number>;
  cacheSavedByCurrency: Record<string, number>;
  unpricedEntries: number;
  /** (估算 − 实报) / 实报 的中位数（A3 偏差可核对）；无可对账条目时 null */
  promptDeviationMedian: number | null;
  /** 展示文本（主进程统一用 @yushu/llm 的 formatCost 生成——渲染层不再自造格式化口径） */
  costText: string;
  /** 偏差展示（如「+12.3%」；无可对账记录时为「无可对账记录」） */
  deviationText: string;
  /** 缓存节省展示（单一币种；混合币种为「多币种（见分列）」） */
  cacheSavedText: string;
}

/** 定价表逐模型状态（面板据此说明「未配置价格」的来源） */
export interface CostPricingRowPayload {
  provider_id: string;
  model: string;
  configured: boolean;
  currency?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

/** 稳定前缀与缓存断点的编排核对（只读） */
export interface CostCacheAuditPayload {
  /** 核对目标章节（未选择章纲时为 null） */
  chapter_id: string | null;
  breakpointAfter: string;
  breakpointIndex: number;
  ordered: boolean;
  misplaced: string[];
  stableTokens: number;
  unstableTokens: number;
  cacheDeclared: boolean;
  cacheMode: string | null;
  belowMinTokens: boolean;
  /** 单次调用的节省投影（假设稳定前缀命中）；无价格或无折扣声明时 null */
  saving: { perCall: number; currency: string } | null;
  /** 节省额展示文本（不提供累计金额——同前缀复用次数无实测来源） */
  savingText: string;
  warnings: string[];
  /** 核对所用的槽位与 token 估算（估算口径：CJK≈1/字、ASCII≈1/4） */
  slots: { slot: string; stable: boolean; tokens: number }[];
  /** 实际核对使用的 provider · 模型（drafting 路由首选） */
  target: string;
}

/** 成本体检发现（J09 lint；severity 与记忆体检同为 `error | warn`） */
export interface CostLintFindingPayload {
  severity: "error" | "warn";
  code: string;
  /** 涉及主体（provider/模型、章节、月度、组装），便于面板定位 */
  subject_id: string;
  message: string;
}

/** 预算护栏状态（config/budget.yaml）——面板要能说清"哪些规则跑了、哪些为何没跑" */
export interface BudgetStatePayload {
  path: string;
  exists: boolean;
  /** 解析失败原文；非空时护栏按内置默认继续，但**必须外显**（不得静默回落成"没配置"） */
  error: string | null;
  /** 生效的月度上限（null = 未配置 = 不设限；文本另给，金额格式化只在主进程一处） */
  monthlyCap: number | null;
  monthlyCapText: string;
  currency: string | null;
  warnRatio: number;
  chapterMultiple: number;
  /** 归月口径：UTC ISO 前 7 位（与记录写入侧 toISOString 同源） */
  monthKey: string;
  /** 本月已用（按币种分列；未定价与无 token 的记录不进分子） */
  spentRows: Array<{ currency: string; totalText: string; usageText: string; estimateText: string }>;
  /** 本月内「有 token 但未配价」的条数——与「花了 0」是两件事 */
  unpriced: number;
  /** 本月内「usage 与估算都缺」的条数 */
  uncounted: number;
  /** 归入本月的记录总数 */
  records: number;
  lint: CostLintFindingPayload[];
  /** 因缺输入而**没跑**的规则与原因（不把"没跑"显示成"没问题"） */
  skipped: string[];
}

export interface AiCostPanelPayload {
  path: string;
  /** 读到并参与统计的记录条数（受主进程扫描上限约束，上限值见 notes） */
  entries: number;
  byTask: CostRowPayload[];
  byModel: CostRowPayload[];
  /** 按章节分解（J09 四维的最后一维）；未标注章节的记录归入「（未标注章节）」一行，不静默丢弃 */
  byChapter: CostRowPayload[];
  totals: CostRowPayload;
  /** 无 token 的记录数（旧记录 / provider 未回传 usage）——J09 的 cost-usage-missing 线索 */
  entriesWithoutTokens: number;
  currencies: string[];
  /** 按 provider 唯一单价回落后折算的记录数（端点回显名 ≠ 配置名；0 = 无回落） */
  pricingFallback: number;
  pricing: CostPricingRowPayload[];
  cache: CostCacheAuditPayload | null;
  /** 预算护栏与成本体检（J09 §5：月度上限 / 组装溢出 / 单章异常 / usage 缺失） */
  budget: BudgetStatePayload;
  /** 口径说明（面板如实展示，避免把估算当账单） */
  notes: string[];
}

/* ---------- 规则 DSL（M4 / T4-1，R51；结构与 @yushu/genre-engine 的 rule-dsl 同形——本文件零依赖） ---------- */

export interface RuleRowPayload {
  id: string;
  /** 三级严重度（与 T3-13 / lint 同为 error | warn | info，不是 warning） */
  severity: "error" | "warn" | "info";
  /** scene | chapter | cross_chapter | project */
  scope: string;
  message: string;
  priority?: number;
  /** 出处（规则件信封的集 id / 标题 / 调研来源） */
  origin_set?: string;
  origin_title?: string;
  origin_source?: string;
  /** 表达式静态问题（空数组＝结构没问题，不代表一定会命中） */
  issues: string[];
}

export interface RuleFilePayload {
  packId: string;
  /** 包内相对路径 */
  file: string;
  /** 解析失败原因；非空即「这个文件一条规则都没跑成」 */
  error: string | null;
  rules: RuleRowPayload[];
}

export interface RuleCatalogPayload {
  /** 项目所选派系包 id（来自 project.yaml 的 genre.packs） */
  packIds: string[];
  files: RuleFilePayload[];
  total: number;
  /** 解析失败的文件数 */
  brokenFiles: number;
  /** 有静态问题的规则条数 */
  problemRules: number;
  /** 同包跨文件撞 id（要带文件名才能说清算的是哪一条） */
  duplicateIds: Array<{ id: string; files: string[] }>;
  /** 包本身加载失败的原因（非空时目录为空也不等于"这些包没有规则"） */
  loadError: string | null;
}

export interface RuleDryRunPayload {
  ruleId: string;
  /** 同名规则跨文件存在时用于消歧 */
  file?: string;
  /** JSON 文本形式的比对夹具 */
  data: string;
}

export interface RuleDryRunResult {
  ok: boolean;
  ruleId: string;
  matched: boolean;
  message: string;
  evidence: Record<string, string>;
  /** 失败原因（包/规则找不到、夹具非法 JSON、被沙箱拒绝）；ok=false 时非空 */
  error: string;
}

/* ---------- 一致性体检（M4 / T4-3 + T4-4，R54；结构与 @yushu/world-engine 的 consistency-report 同形） ---------- */

export type ConsistencyTimingPayload = "post-generate" | "post-save" | "manual";

export interface ConsistencyEntryPayload {
  rule: string;
  severity: "error" | "warn" | "info";
  subject: string;
  related?: string;
  path?: string[];
  evidence: string;
  fix: string;
  /** 原文区间（UTF-16 下标，与中文自查同口径）；找不到原文时为 null，不给假区间 */
  span: { file: string; start: number; end: number; text: string } | null;
  /** 结论出处：派系包规则带「派系包 x（文件）」，内置结构规则没有这一项（作者要分得清是谁说的） */
  origin?: string;
  /** 仅 suppressed 条目有：豁免理由与决策时间（审计入口） */
  reason?: string;
  decidedAt?: string;
}

export interface ConsistencyCheckPayload {
  /** 缺省 manual（手动全书体检，永远重算） */
  timing?: ConsistencyTimingPayload;
  /** 生成后即时轻校验的范围：只报这些实体发起的结论 */
  entityIds?: string[];
  /**
   * 轻校验的另一条定范围的路：给**本次刚写进正文的文本**，范围由实体提及自己算出来。
   * 与 entityIds 同时给出时以 entityIds 为准（调用方明确知道的比猜的可靠）。
   */
  scopeText?: string;
  /**
   * 是否顺带跑一次 AI 采样核验（M4/T4-4 的"重规则 + AI 采样"，R58）。
   * 只有 `manual`（全书体检）会执行：采样要烧 token，不能让一次保存或一次采纳悄悄花钱。
   */
  aiAudit?: boolean;
}

export interface ConsistencyReportPayload {
  timing: ConsistencyTimingPayload;
  /** 这次是真的算了一遍，还是复用了未失效的缓存 */
  ranAgain: boolean;
  allowPath: string;
  allowExists: boolean;
  /** 豁免清单读不了的原因；非空时**不应用任何豁免**，结论照旧报出 */
  allowError: string | null;
  /** world.yaml 缺失 / 不合式时按全部层启用的说明 */
  worldNote: string | null;
  entities: number;
  refs: number;
  /** 本次轻校验实际生效的实体范围（由 entityIds 或 scopeText 的提及解析得出） */
  scopeIds: string[];
  /** AI 采样核验这次跑了没有（未跑也要给原因——静默省略会被读成"跑了且没问题"） */
  aiAudit: {
    ran: boolean;
    reason: string;
    provider: string;
    model: string;
    sampled: number;
    rejected: number;
  };
  entries: ConsistencyEntryPayload[];
  suppressed: ConsistencyEntryPayload[];
  unusedAllow: string[];
  outOfScope: Array<{ referrer: string; relation: string; target: string; reason: string }>;
  skipped: { disabledLayerEntities: number; cycleDepthCapped: number };
  /**
   * 派系包规则本轮的求值情况（R57）。
   *
   * `notEvaluated` 与 `errors` 都必须外显：一条悄悄没跑的规则，作者看到的是"没发现问题"，
   * 真相是"这条没数据可比"——沉默的校验器比没有校验器更坏。
   */
  pack: {
    evaluated: string[];
    notEvaluated: Array<{ id: string; reason: string }>;
    errors: string[];
    /**
     * 跨包同 id 的合并情况（T4-12 / R85）。
     *
     * `overrides` 是"高版本盖掉了谁"，`ambiguous` 是"版本并列、引擎只按确定性次序取一个，
     * 裁定权在你"。两者都必须外显——docs/03 §8.3 的底线是禁止静默覆盖，
     * 而"合并后只报一条结论"看起来与"本来就只有一条规则"完全一样。
     */
    merge: {
      overrides: Array<{
        id: string;
        winner: string;
        winnerVersion: string | null;
        loser: string;
        loserVersion: string | null;
        reason: string;
      }>;
      ambiguous: Array<{ id: string; versions: Array<string | null>; packs: string[]; note: string }>;
      /** 生效期到底判没判：skipped 时不能看起来像"所有规则都在有效期内" */
      dateCheck: "applied" | "skipped";
    };
  };
  /**
   * `findings` = 本轮**送进报告的全部结论**（结构 + 包规则 + AI 采样 + 伏笔 + 视角 + 可见性，R103 起）。
   * 它此前只数结构类那一份，而 `entries` / `suppressed` 是全源口径——
   * 三个字段并排却不同口径，`entries + suppressed === findings` 这条不变量在多源之后必然不成立
   * （e2e 的 `invariantHolds` 就是这条，R103 把它撞红之后才对正）。
   */
  counted: { findings: number; entries: number; suppressed: number; filteredOut: number };
  /**
   * 阈值配置的实际状态（R84 / T4-11「误报率纳入可校准阈值」）。
   *
   * `exists=false` 与 `error≠null` 是两种不同的"没在判"，都必须看得见：
   * 前者是作者还没配（给默认），后者是**配了但读不懂**（不判，且把原因摊开）——
   * 静默按默认走会让护栏以为"阈值生效了"。
   */
  thresholds: {
    path: string;
    exists: boolean;
    error: string | null;
    /** 实际生效的豁免率上限；null = 未配置（只给数据不下结论） */
    rate: number | null;
    /** 实际生效的最小样本数 */
    minSamples: number;
  };
  /**
   * 逐条规则的**豁免率**（= 被豁免条数 / 本次该规则条数）。
   *
   * 名字要诚实：这不是误报率。产品拿得到的是"作者豁免了哪些结论"（A6 审计入口），
   * 而豁免既可能是"报错了"也可能是"确有问题但选择留白"。等真有标注语料再谈误报率。
   */
  noise: Array<{
    rule: string;
    reported: number;
    suppressed: number;
    /** 分母为 0 时为 null（不编造 0%） */
    rate: number | null;
    verdict: "noisy" | "ok" | "insufficient-sample" | "not-configured";
  }>;
}

/* ---------- 中文自查（T3-13，J14；结构与 @yushu/text 同形——本文件保持零依赖，故用结构类型镜像） ---------- */

/** J14 三级严重度（注意是 `warn` 而非 `warning`） */
export type ProofreadSeverityPayload = "error" | "warn" | "info";

/** T3-13 初版规则 id（`proofread-address-drift` 需联动 E07，留 M4） */
export type ProofreadRuleIdPayload =
  | "proofread-typo"
  | "proofread-conversion-ambiguous"
  | "proofread-punctuation-gb"
  | "proofread-repetition-high"
  | "proofread-demiscue"
  | "proofread-long-sentence"
  | "proofread-autofix-unconfirmed";

/** 单条检测结果（span 为章内正文字符下标，**UTF-16 口径**，与导出敏感词命中同轴） */
export interface ProofreadFindingPayload {
  rule: ProofreadRuleIdPayload;
  severity: ProofreadSeverityPayload;
  span: { chapter?: string; start: number; end: number; text: string };
  suggestion?: string;
  /** 该条目登记的候选文本（如繁简歧义）；作者只能从中选一个，任意文本会被主进程拒绝 */
  candidates?: string[];
  /** 为什么命中（面板原样展示，不做黑箱结论） */
  evidence: string;
  /** 可否自动修：false 的规则必须由作者显式选定候选 */
  autofix: boolean;
  source: { engine: string; conf?: number };
}

export interface TextProofreadPayload {
  /** 章节文件相对路径（chapters/…／.md） */
  path: string;
}

export interface TextProofreadPanelPayload {
  path: string;
  chapterId: string;
  /** 被检正文长度（与 span 同口径） */
  chars: number;
  findings: ProofreadFindingPayload[];
  counts: Record<ProofreadSeverityPayload, number>;
  checkedRules: ProofreadRuleIdPayload[];
  /** 被关掉的规则如实回传——面板不得把"没跑"显示成"没问题" */
  skippedRules: ProofreadRuleIdPayload[];
}

/** 一条采纳请求：按「起始下标 + 规则」在主进程重新匹配检测条目（渲染层无权指定改法之外的字段） */
export interface TextFixEditPayload {
  start: number;
  rule: ProofreadRuleIdPayload;
  /** 作者显式选定的候选文本（繁简歧义等 `autofix:false` 的条目必须给） */
  replacement?: string;
}

export interface TextFixBodyPayload {
  path: string;
  edits: TextFixEditPayload[];
  /** **用户是否已确认**——false 时主进程原样返回正文，一个字符都不改（J14 安全底线） */
  confirmed: boolean;
}

export interface TextFixBodyResultPayload {
  path: string;
  /** 改后正文（**未写盘**：写仍由编辑器的保存路径负责，保持单一写入口与冲突检测） */
  body: string;
  /** 改前正文：渲染层据此判断"期间作者又改过稿"→ 放弃替换而不是覆盖 */
  beforeBody: string;
  applied: Array<{ start: number; from: string; to: string }>;
  rejected: Array<{ start: number; reason: string }>;
  /** 被闸门拦下的条数（未确认的批量请求） */
  blocked: number;
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

/** 平台导出包的摘要（R94 / K11）：字段全部来自包，代码里一个平台参数都没有 */
export interface PlatformPackSummary {
  /** 包 id = 目录名，与包里的 platform 字段可以不同；代码只把它当标识，不认得任何平台 */
  id: string;
  platform: string;
  version: string;
  chapterTitleFormat: string;
  encoding: string;
  /** 平台"有效字数"口径原文（研究里没给量化上限，所以这里只转述口径，不判超没超） */
  validWordRule: string;
  submissionMaterials: string[];
  sourceUrls: string[];
  effectiveDate: string;
  checkedAt: string;
  /** 包在目录里但解析不过 ⇒ 这里放原因原文（坏包不许静默从清单里消失） */
  parseError: string | null;
}

/** 平台格式核对行（与引擎 `PlatformFormatRow` 同形；载荷在这里自描述，不让渲染层去依赖引擎包） */
export interface PlatformFormatRowPayload {
  rule: string;
  severity: "error" | "warn" | "info";
  subject: string;
  detail: string;
}

/** 套上平台格式后的章头样例：作者标题 → 导出会写出的那一行 */
export interface PlatformTitleSample {
  chapterId: string;
  title: string;
  head: string;
}

/** 选中平台包后的预览面板数据 */
export interface PlatformPreviewPayload {
  pack: PlatformPackSummary;
  rows: PlatformFormatRowPayload[];
  /** 只给前几章的样例（全书章头都按同一条模板，列完没意义） */
  titles: PlatformTitleSample[];
  checkedChapters: number;
  /** 有多少章的标题自带"第N章"前缀，在导出副本里让位给了平台格式（真源不动） */
  strippedPrefixes: number;
}

/** 预览的请求：只有两件事可要求——要不要重探工具链（R92）、按哪个平台格式核对（R94） */
export interface ExportPreviewRequest {
  /** true ⇒ 清掉进程内探测缓存重新下发；作者装完 PDF 引擎后备好 EPUBCheck jar 后不必重启应用 */
  refresh?: boolean;
  /** 平台包 id；不传 = 不按任何平台格式核对 */
  platform?: string;
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
  /**
   * 本机导出能力矩阵（R87 / T5-4）。**现场探测 + 判定**，不是写死的清单：
   * pandoc 认得 pdf 与"这台机器能出 PDF"是两件事（后者还要外部引擎）。
   * 每一项都带原因——可用要说靠什么产出，不可用要点名缺什么，
   * 这样作者点下去之前就知道结果，也不会收到一个"改了名的 TXT"。
   */
  capabilities: Array<{
    format: "txt" | "epub" | "docx" | "pdf";
    available: boolean;
    reason: string;
  }>;
  /**
   * 探测本身失败时的实话（比如外部命令抛错）。null = 探测成功。
   * 此时 `capabilities` 是空数组——空着比编一份"看起来合理"的矩阵诚实。
   */
  capabilitiesNote: string | null;
  /** 词库扫描目录（外置可更新：仓库内置 + 项目内覆盖） */
  wordlistDirs: string[];
  /**
   * 本机可用的平台导出包清单（R94 / K11）：扫 `packs/platforms/` 得到，
   * 一项都没有就是没有——界面据此决定平台选择区是否出现，不预设任何平台。
   */
  platforms: PlatformPackSummary[];
  /** 选中的平台包核对结果；未选 / 出问题时为 null */
  platform: PlatformPreviewPayload | null;
  /** 选中了平台包但没能给出结论时的实话（找不到包、包不合规）。null = 正常 */
  platformNote: string | null;
}

export interface ExportRunPayload {
  /** 防手滑（T1-20）：必须显式为 true，服务端同样校验 */
  confirmed: boolean;
  includeToc?: boolean;
  stripMarkers?: boolean;
  /** 导出格式（T5-4）；缺省 = `txt`，与 R90 之前的行为逐字一致 */
  format?: "txt" | "epub" | "docx" | "pdf";
  /** 平台包 id（R94 / K11）：章头按包的 `chapter_title_format` 写；不传 = 照作者原文 */
  platform?: string;
}

/** EPUB 质量门禁的结论（T5-4）；`ran:false` 时 `passed` 必为 false——没检查过就不算通过 */
export interface ExportGatePayload {
  ran: boolean;
  passed: boolean;
  reason: string;
  /** 跑过时才有：EPUBCheck 的计数与原文行 */
  detail?: { fatalErrors: number; errors: number; warnings: number; messages: string[] };
}

export interface ExportRunResult {
  path: string;
  hash: string;
  chapters: number;
  words: number;
  /** 无错误级敏感词命中（提示级不阻断） */
  clean: boolean;
  /** 实际产出的格式（回执要说清楚，不许"点了 EPUB 结果拿到 TXT"） */
  format: "txt" | "epub" | "docx" | "pdf";
  /** 喂给 pandoc 的 Markdown 源（仅非 TXT 格式有）；pandoc 失败时会被清掉 */
  sourcePath?: string;
  /** EPUB 才有：EPUBCheck 门禁结论 */
  gate?: ExportGatePayload;
  /**
   * 按平台格式导出时才有（R94）：回执要说清用的是哪个包、哪条模板，
   * 以及有多少章的自带前缀在导出副本里让位给了平台格式——作者不必去数，但必须能看见。
   */
  platform?: {
    id: string;
    chapterTitleFormat: string;
    errors: number;
    warnings: number;
    infos: number;
    strippedPrefixes: number;
  };
}

/* ---------- 世界圣经 / 设定集一键导出（M5 T5-5，R98） ---------- */

/** 设定集里的一条设定（预览与回执共用；`words` 是正文字数，不含标题与元信息行） */
export interface BibleEntryPayload {
  id: string;
  name: string;
  type: string;
  path: string;
  visibility: string;
  words: number;
}

/** 设定集的一章（一个层级一节） */
export interface BibleSectionPayload {
  layer: string;
  heading: string;
  entries: BibleEntryPayload[];
}

/** 汇编结论（K11 规则 `export-bible-visibility-leak`） */
export interface BibleFindingPayload {
  rule: string;
  severity: "warn";
  message: string;
  related: string;
}

/** 读不了的设定卡：留在面板上点名，不当它不存在（同 R94 的坏派系包） */
export interface BibleUnreadablePayload {
  path: string;
  error: string;
}

/** 层级一行的状态：有几张卡、世界里开没开、这次选没选 */
export interface BibleLayerPayload {
  key: string;
  title: string;
  cards: number;
  enabled: boolean;
  selected: boolean;
}

export interface BiblePreviewRequest {
  /** 设定集标题；省略则用「书名 设定集」 */
  title?: string;
  /** 层级选取；省略 = 世界里开着的层 */
  layers?: string[];
  /** 按叙事可见性脱敏 */
  maskUnrevealed?: boolean;
}

/** 预览结果（不 extends 请求体：那边的 `layers` 是"选哪些层"，这边是"每层什么状态"，同名不同义） */
export interface BiblePreviewPayload {
  /** 实际会写进产物第一行的标题（面板显示的就是产物里的） */
  title: string;
  bookTitle: string;
  sections: BibleSectionPayload[];
  layers: BibleLayerPayload[];
  included: number;
  excludedByLayer: number;
  masked: BibleEntryPayload[];
  findings: BibleFindingPayload[];
  wordCount: number;
  /** 项目里的设定卡总数（含读不了的） */
  cardTotal: number;
  unreadable: BibleUnreadablePayload[];
  /** 预览可能被截断（整本只落盘才完整） */
  markdown: string;
  truncated: boolean;
  /** 这次预览用没用脱敏（回执要能自证是哪一种） */
  maskUnrevealed: boolean;
  error: string | null;
}

/* ---------- 项目迁移包导出（M3 T3-14 后半，R101） ---------- */

/** 进包的一个真源文件 */
export interface ProjectExportFilePayload {
  path: string;
  bytes: number;
}

/** 被跳过的一条 + 为什么跳（静默少文件与静默多文件一样坏） */
export interface ProjectExportExcludedPayload {
  path: string;
  reason: string;
}

/** 某个文本文件里按 K12 检出的疑似明文密钥条数（写出前会被剥离） */
export interface ProjectExportRedactionPayload {
  path: string;
  count: number;
}

export interface ProjectExportPreviewPayload {
  bookTitle: string;
  files: ProjectExportFilePayload[];
  totalBytes: number;
  excluded: ProjectExportExcludedPayload[];
  /** 读不出文本内容的文件（二进制 / 超大）：不假装带上了 */
  unreadable: ProjectExportExcludedPayload[];
  redactions: ProjectExportRedactionPayload[];
  note: string;
}

export interface ProjectExportPickPayload {
  /** 只显示用的目录名与条目数：绝对路径不外传 */
  name: string;
  entries: number;
  canceled: boolean;
  /** 取消时没有票；成功时只有票号（路径留在主进程） */
  ticket?: string;
}

export interface ProjectExportRunPayload {
  /** 目标目录票据（由 project:exportPick 发；渲染层拿不到也不该拿路径） */
  ticket: string;
  /** 防手滑：必须显式 true */
  confirmed?: boolean;
  /** 是否把 exports/ 也装进包里（默认不装） */
  includeExports?: boolean;
}

export interface ProjectExportRunResult {
  /** 目标目录下新建的子目录名（不含父路径） */
  subdir: string;
  bookTitle: string;
  createdAt: string;
  files: number;
  bytes: number;
  /** 写出前剥离掉的明文密钥处数 */
  redacted: number;
  /** 落盘后复扫仍检出的条数：>0 时整包已被删除并抛错，成功回执恒为 0 */
  plaintextRemaining: number;
  skippedDerived: number;
  unreadableSkipped: number;
}

export interface BibleRunPayload extends BiblePreviewRequest {
  /** 防手滑：必须显式为 true（与章节导出同一口径） */
  confirmed?: boolean;
}

export interface BibleRunResult {
  path: string;
  hash: string;
  title: string;
  included: number;
  wordCount: number;
  /** 被脱敏剔除的条数（只报数，报不了名字——名字本身就是剧透） */
  maskedCount: number;
  /** 未揭示却仍进了产物的条数（warn 不阻断，但必须看得见） */
  leakCount: number;
  /** 读不了、因此没进设定集的卡数 */
  unreadableCount: number;
  maskUnrevealed: boolean;
  layers: string[];
}

/* ---------- 视角策略与看板（M4 / T4-2 第三批，R102；判据 docs/research/F-叙事与故事构建/F04） ---------- */

/**
 * 看板上的一行章：`drafted=false` 表示章纲里有条目但还没建草稿——
 * 那样的章**不参与视角核对**（没有 frontmatter 可谈），但必须计数点名，
 * 否则"未建章"会被读成"全书视角没问题"。
 */
export interface PovChapterRowPayload {
  /** 已建草稿 = 章节实体 id（ch-*）；未建草稿 = 章纲 id（co-*） */
  chapterId: string;
  /** 章节文件路径；未建草稿为 null */
  path: string | null;
  volumeTitle: string;
  title: string;
  /** 全书章序（跨卷连续编号）：切换预算按它算间隔 */
  idx: number;
  /** 章 frontmatter 里的 pov，未填为空串 */
  pov: string;
  drafted: boolean;
  /** 该章文件的当前哈希（写入时作 baseHash 用）；未建草稿为 null */
  hash: string | null;
}

/** 引擎结论的原样投影（字段与 `pov-check.ts` 同源，面板按 message/evidence/fix 三件套渲染） */
export interface PovFindingPayload {
  rule: string;
  severity: "warn" | "info";
  subject: string;
  related?: string;
  message: string;
  evidence: string;
  fix: string;
  origin: string;
}

export interface PovPreviewPayload {
  configPath: string;
  /**
   * `undeclared` = 没有这个文件（或文件为空）；`unreadable` = 有文件但解析不过。
   * 后者**一条结论都不发**：把读不了的策略当"没问题"，等于用假绿灯骗作者。
   */
  state: "declared" | "undeclared" | "unreadable";
  configText: string;
  /** 策略文件当前哈希（保存时回传作 baseHash；文件不存在为 null） */
  configHash: string | null;
  /** 解析失败原因（state=unreadable 时非空） */
  configError: string | null;
  mode: string;
  distance: string;
  defaultPov: string;
  allowedPovs: string[];
  granularity: string;
  minGapChapters: number | null;
  signalRequired: boolean | null;
  exemptions: Array<{ scope: string; id: string; reason: string }>;
  /** 视角下拉的候选：只来自角色卡 */
  characters: Array<{ id: string; name: string }>;
  chapters: PovChapterRowPayload[];
  findings: PovFindingPayload[];
  counted: {
    outlineChapters: number;
    drafted: number;
    notDrafted: number;
    withPov: number;
    characters: number;
    findings: number;
  };
}

export interface PovPreviewRequest {
  /** 严格档（默认 true）：切换预算按 warn 报；宽松档降一级为 info */
  strict?: boolean;
}

export interface PovWriteConfigPayload {
  content: string;
  /** 预览给回的哈希；文件此前不存在时传 null（= 新建，不许盲写已存在的文件） */
  baseHash: string | null;
}

export interface PovWriteResult {
  path: string;
  hash: string;
}

export interface PovSetChapterPayload {
  /** 章节文件路径（chapters/ 前缀，仍经 FileGateway 的路径防护） */
  path: string;
  /** 角色 id；空串 = 清除本章视角 */
  pov: string;
  baseHash: string;
}

export interface PovSetChapterResult {
  path: string;
  hash: string;
  pov: string;
}

/** 读不动的设定卡（可见性核对用：坏卡不许消失在"零结论"里） */
export interface VisibilityUnreadablePayload {
  path: string;
  error: string;
}

/** 开局窗口那几章里读不动的章文件（或坏大纲）——与上面那条同形，点名对象不同 */
export interface OpeningUnreadablePayload {
  path: string;
  error: string;
}

/** 门控核对扫过的事实 / 设定卡里读不动的那些（同上两条同形） */
export interface GateUnreadablePayload {
  path: string;
  error: string;
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

/* ---------------- 发布状态机（M5 / T5-6，R105） ---------------- */

/**
 * 发布状态（**本文件保持零依赖**，所以这里本地写一份结构类型）。
 *
 * 它必须与三处逐字一致：`@yushu/world-engine` 的 `PUBLISH_STATUSES`、
 * `@yushu/schema` 的 chapterSchema 枚举、docs/03 §5.3 的 `Chapter.status`。
 * 漂移由 `apps/desktop/test/publish-status-ids.test.ts` 盯住（少一处对账就红）。
 */
export type PublishStatus = "draft" | "revised" | "published";

/** 看板里的一章（只读面板用） */
export interface PublishChapterRow {
  id: string;
  title: string;
  /** 项目内相对路径（写入点要靠它定位文件） */
  path: string;
  status: PublishStatus;
  wordCount: number;
  /** 文件当前 hash（写入点做 baseHash 并发检测要用） */
  hash: string;
  /** 计划发布时刻（空串 = 未设） */
  publishAt: string;
  /** 已到点但还没处理（本地提醒队列） */
  due: boolean;
}

/** 一条到期待处理（本地提醒队列；I01 §3.7：**只是提醒，不代替平台发布**） */
export interface PublishReminderRow {
  id: string;
  title: string;
  publishAt: string;
  /** 到期时长（毫秒） */
  dueMs: number;
  wordCount: number;
}

/** 发布看板（只读通道的载荷） */
export interface PublishBoardPayload {
  /** 当前口径包（番茄等）；没有可用包时为空串 */
  platform: string;
  platformVersion: string;
  effectiveDate: string;
  sourceUrls: string[];
  /** 平台"有效字数"的口径名（本地算不了后台口径时如实报出口径） */
  validWordRule: string;
  /**
   * 三条判定的出处（状态机 / 定时提醒 / 字数闸各一条）。
   *
   * 面板把它们写出来，作者才能核"这是按哪条规则判的"——与体检表的 `origin` 同一口径。
   */
  origins: { status: string; reminder: string; word: string };
  /** 口径包读不了时的原因（空串 = 没问题）；读不了就不判，不降级成"没问题" */
  rulesError: string;
  chapters: PublishChapterRow[];
  reminders: PublishReminderRow[];
  groups: { draft: number; revised: number; published: number };
  word: {
    count: number;
    total: number;
    min: number;
    max: number;
    median: number;
    /** 平台有没有声明单章下限（没声明 = 不判，不静默） */
    perChapterFloorDeclared: boolean;
    belowFloor: { id: string; title: string; wordCount: number }[];
    daily?: {
      date: string;
      publishedChars: number;
      standard?: number;
      advanced?: number;
      reached: string[];
    };
  };
  /** 台账条数（回退留痕） */
  ledgerEvents: number;
  /**
   * 迁移指引矩阵（3×3 全给，含非法迁移的**理由**）。
   *
   * 界面按这张表渲染按钮：合法的可点、非法的禁用并把理由挂在 title 上。
   * 渲染层不自己抄一份迁移表——抄一份就会漂移，漂移出来的按钮点下去只会被引擎拒。
   */
  transitionGuide: {
    from: PublishStatus;
    to: PublishStatus;
    ok: boolean;
    reason: string;
    rollback: boolean;
  }[];
  /** 台账读不动的原因（空串 = 没问题）；读不动就不拿空账当"没有留痕" */
  ledgerError: string;
  /** 账实不符的章（章节状态与台账最后一条对不上）：空数组 = 没有 */
  mismatches: string[];
}

/** 改发布状态（真源写） */
export interface PublishSetStatusPayload {
  /** 章节的项目内相对路径 */
  path: string;
  to: PublishStatus;
  /**
   * 作者自己写的一句理由（回退时特别有用；不强制）。
   *
   * **迁移时刻不给渲染层填**——由主进程取本地时刻（带时区偏移）：
   * ① 渲染层填不出可信的时区；② 日期部分要与作者所在时区一致，
   * 否则"今日已发布字数"会算到隔壁那天；③ 时间戳是事实，不该由调用方声称。
   */
  note?: string;
  /** 章节文件当前的 hash（并发检测：外部改过即拒） */
  baseHash: string;
}

export interface PublishSetStatusResult {
  path: string;
  from: PublishStatus;
  to: PublishStatus;
  at: string;
  /** 这是回退（回退要留痕） */
  rollback: boolean;
  /** 台账条数（写完后的总条数） */
  ledgerEvents: number;
  wordCount: number;
}

/** 设定 / 清除定时发布（真源写；空串 = 清除定时） */
export interface PublishSchedulePayload {
  path: string;
  /** ISO 串；空串 = 清除定时 */
  publishAt: string;
  baseHash: string;
}

export interface PublishScheduleResult {
  path: string;
  publishAt: string;
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
export type SnapshotReasonPayload = "auto" | "manual" | "pre_restore" | "pre_destructive" | "pre_apply_proposal";

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

/* ---------- 设定抽取（T3-10；结构与 @yushu/world-engine extract 兼容） ---------- */

export interface ExtractionCandidatePayload {
  candidate_id: string;
  type: string;
  name: string;
  aliases: string[];
  summary: string;
  /** 出处引文（原文片段——无出处不得进入候选） */
  quote: string;
  confidence: number;
  diff: {
    kind: "new" | "augment" | "conflict";
    matched_card_id?: string;
    reason: string;
  };
  /** 服务端强制：抽取结果一律候选（采纳是用户显式动作） */
  status: "candidate";
}

export interface ExtractPreviewPayload {
  chapterId: string;
}

export interface ExtractPreviewResult {
  chapterId: string;
  chapterTitle: string;
  candidates: ExtractionCandidatePayload[];
  stats: { total: number; new: number; augment: number; conflict: number };
  provider_id: string;
  model: string;
  /** 实际请求次数（1 = 首次即通过；>1 = 校验失败回喂修复） */
  attempts: number;
  /** T3-3 降级回执（structured_output 未满足 → 提示词约束 + JSON 后校验） */
  downgrade: { capability: string; strategy: string; message: string }[];
}

export interface ExtractAdoptPayload {
  chapterId: string;
  candidate: ExtractionCandidatePayload;
}

export interface ExtractAdoptResult {
  path: string;
  hash: string;
  warnings: string[];
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

/** 冷启动计划的一层计数（缺 = 缺摘要且**有素材**） */
export interface MemoryColdStartLayerPayload {
  total: number;
  missing: number;
  covered: number;
}

/** 冷启动批次里的一条待补目标（只带界面要显示的四个字段） */
export interface MemoryColdStartTargetPayload {
  layer: "volume_summary" | "chapter_summary";
  id: string;
  title: string;
  sourceChars: number;
}

export interface MemoryColdStartPayload {
  volumes: MemoryColdStartLayerPayload;
  chapters: MemoryColdStartLayerPayload;
  /** 正文为空、因此不列待补的目标数（没素材就不逼作者凭空编） */
  noMaterial: number;
  materialTargets: number;
  /** 有素材的目标里已有摘要的占比；一个都无从判时为 null */
  coverageRatio: number | null;
  coverageReason: string | null;
  firstChapterMissing: boolean;
  batch: MemoryColdStartTargetPayload[];
  /** 这批的素材字数合计（换算金额交给成本面板，这里不猜单价） */
  batchChars: number;
  batchTruncated: boolean;
  stillMissing: number;
}

export interface MemoryStatePayload {
  /** 记忆真源目录（memory/；无记录时目录可能尚未创建） */
  dir: string;
  /** 当前项目命名空间（world.yaml 的 world.id） */
  project_id: string;
  summaries: MemorySummaryPayload[];
  targets: MemoryTargetPayload[];
  /**
   * 冷启动计划（T5-9，R95）：导入长篇后"还缺几条摘要、先补哪几条"。
   * 由同一份 targets 就地派生——数字必须与上方目标列表自洽，不允许有第二份事实。
   */
  coldStart: MemoryColdStartPayload;
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

/**
 * 批量补摘要候选（M5/T5-9 第二段，R106）。
 *
 * **候选化不变**：批量跑出来的也只是候选，逐条采纳才写库。
 */
export interface MemorySummarizeBatchPayload {
  /** 本次最多跑几条（分批推进；缺省由主进程按冷启动批次给） */
  limit?: number;
  /**
   * 作者已显式确认（超预算 / 有条目算不出金额时必需）。
   *
   * 未确认而主进程判定需要确认 ⇒ 拒绝跑并把理由带回界面（E_MEMORY_BATCH_CONFIRM）。
   */
  confirm?: boolean;
}

export interface MemorySummarizeBatchCandidate {
  layer: "volume_summary" | "chapter_summary";
  id: string;
  title: string;
  text: string;
  chars: number;
  provider_id: string;
  model: string;
  /** 这一条的预估 prompt token */
  promptTokens: number;
  /** 这一条的预估金额；null = **算不出来**（provider 没配单价），不是 0 */
  cost: number | null;
  currency: string;
}

export interface MemorySummarizeBatchResult {
  candidates: MemorySummarizeBatchCandidate[];
  /** 跑失败的条目与原因（不静默吞掉） */
  failed: { id: string; title: string; reason: string }[];
  /** 预算护栏的预检结论（J09 §3.3：生成前成本预估 + 超预算需用户确认） */
  budget: {
    needsConfirm: boolean;
    confirmReasons: string[];
    warnings: string[];
    reason: string;
    estimatedTokens: number;
    estimatedCost: number;
    /** 金额算不出来的条目 id（不参与上限计算，但要说明） */
    unpricedIds: string[];
  };
  /** 本批跑完还有多少条待补（分批推进，不一次铺开） */
  stillMissing: number;
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
/** 影响传播（M4/T4-5，R61）的 IPC 载荷。面板与主进程之间只走这几个形状 */
export type ProposalDecisionPayload = "accept" | "reject" | "pending";

export interface PropagatePreviewPayload {
  entity: string;
  field: string;
  /** 改名类改动的新值：只有它带得出机械可写的下游编辑（R62） */
  to?: string;
  maxDepth?: number;
}

export interface ProposalImpactPayload {
  entity: string;
  relation: string;
  depth: number;
  severity: "error" | "warn" | "info";
  /** 显式传播路径（从被改实体到本行，含两端）——A1 要求每条结论带路径 */
  path: string[];
  weight: number;
  weightAssumed: boolean;
}

export interface ProposalPayload {
  proposalId: string;
  /** to = 改名类改动的新 id；面板要把它显示出来，否则作者看不出"写回会把引用改指向哪里" */
  change: { entity: string; field: string; to?: string };
  status: "awaiting_confirmation" | "blocked" | "applied";
  impact: ProposalImpactPayload[];
  truncated: { frontier: string[]; count: number } | null;
  cycle: string[] | null;
  assumedRelations: string[];
  maxDepth: number;
  decisions: Record<string, ProposalDecisionPayload>;
  /** 已写回真源的条目下标（R62） */
  applied: number[];
  undecidedCount: number;
  path: string;
}

export interface ProposalDecidePayload {
  proposalId: string;
  index: number;
  decision: ProposalDecisionPayload;
}

/** 伏笔台账看板（M4 / T4-6，R66）：判定全在引擎，这里只是它的可序列化投影 */
export interface ForeshadowRowPayload {
  id: string;
  name: string;
  state: string;
  /** open = 还欠读者一个兑现；closed = 已回收或已带理由放弃 */
  board: "open" | "closed";
  isRedHerring: boolean;
  /** 距预期回收几章；无法定位是 null，不是 0 */
  overdueBy: number | null;
  sinceAction: number | null;
}

export interface ForeshadowFindingPayload {
  id: string;
  severity: "error" | "warn" | "info";
  rule: string;
  message: string;
}

export interface ForeshadowBoardPayload {
  path: string;
  exists: boolean;
  /** 台账读不了 / 没有台账 / 章清单为空时，这里给出**不静默**的原因 */
  note: string;
  /** 汇总的**结构化行**（R127）：界面逐行渲染，不切那串自由文本 */
  summary: SummaryRow[];
  chapterTotal: number;
  currentChapter: string | null;
  rows: ForeshadowRowPayload[];
  findings: ForeshadowFindingPayload[];
  stats: Record<string, number>;
}

/** 时间线视图（M4 / T4-7，R68）：刻度是内部数字年，displayYear 只是历法换算 */
export interface TimelineRowPayload {
  id: string;
  title: string;
  /** 内部统一数字刻度（锚定事件 = 0） */
  year: number;
  timeline: string;
  calendar: string;
  /** 历法认不出时为 null（不退回 offset 0） */
  displayYear: string | null;
  kind: string | null;
  location: string | null;
  /** 事件发生的**地点实体 id**（K08 §3.8 的 `place_ref`；没有 = null，不猜） */
  placeRef: string | null;
}

export interface TimelineFindingPayload {
  id: string;
  severity: "error" | "warn" | "info";
  rule: string;
  message: string;
}

export interface TimelineSkippedPayload {
  rule: string;
  reason: string;
  ids: string[];
}

export interface TimelineViewPayload {
  path: string;
  exists: boolean;
  note: string;
  /** 汇总的**结构化行**（R128）：界面逐行渲染，不切那串自由文本 */
  summary: SummaryRow[];
  calendars: { id: string; label: string; offset: number }[];
  activeCalendar: string | null;
  rows: TimelineRowPayload[];
  findings: TimelineFindingPayload[];
  notEvaluated: TimelineSkippedPayload[];
}

export interface TimelineViewRequestPayload {
  /** 缺省 = 用各条时间线自己的历法 */
  calendar?: string;
}

/** 关系图谱（M4 / T4-9，R69）：由真源行表投影出来的节点与边 */
export interface GraphNodePayload {
  id: string;
  name: string;
  type: string;
  layer: string;
  filePath: string;
  net: "characters" | "factions" | "geography" | "other";
  degree: number;
}

export interface GraphEdgePayload {
  from: string;
  to: string;
  relation: string;
  net: "characters" | "factions" | "geography" | "other";
  selfLoop: boolean;
}

/** 面板汇总的**结构化**行（R126）：由后端给，界面只排版 —— 不在界面里切字符串 */
export interface SummaryRow {
  /** 左列的标签（如"实体"） */
  label: string;
  /** 右列的值 */
  value: string;
  /** 需要提醒时（如"绑定的实体已不存在"）走警告色 */
  tone?: "warn";
}

export interface GraphViewPayload {
  note: string;
  /** 汇总的结构化行（界面逐行渲染 ⇒ 不折成一长串） */
  summary: SummaryRow[];
  focus: string | null;
  maxDepth: number;
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
  kinds: Record<string, { nodes: number; edges: number }>;
  dangling: { referrer: string; relation: string; target: string }[];
  unclassifiedRelations: string[];
  isolated: string[];
  duplicateEdges: number;
  selfLoops: number;
  focusMissing: boolean;
  truncated: { frontier: string[]; count: number } | null;
}

export interface GraphViewRequestPayload {
  focus?: string;
  maxDepth?: number;
}

/**
 * 世界地图视图请求（M5/T5-1，R120）：**无参数**。
 *
 * 图层显隐是**纯显示动作**，放在渲染层做（切层不必等一次 IPC 往返，动效才跟手，R111 的口径）。
 * 所以这条通道没有入参——将来做「事件锚点」（K08 §3.8）时再加。
 */
/** 底图登记的请求（R136）：`register` = 第一次登记（已有登记 ⇒ 拒绝）；`replace` = 换底图（替换那三行） */
export type WorldMapUploadBaseRequestPayload = {
  mode: "register" | "replace";
};

/**
 * 框定边界的请求（R138）：作者在底图上**拖出来**的那一块（**底图像素坐标**）。
 *
 * 口径回源 K08 §3.6：地图 = 图片底图 + bounds ⇒ 作者上传底图后**框定 bounds**
 * （不是"手填四个数"，是**在图上拖一块**——K08 §5 说的「上传底图 → 框定 bounds」）。
 */
export interface WorldMapSetBoundsRequestPayload {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 框定边界的结果（R138） */
export interface WorldMapSetBoundsResult {
  ok: boolean;
  /** 给作者看的一句话（成了 / 为什么没成） */
  note: string;
  /** 写进去的边界（没成时为 null） */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 底图本身的像素尺寸（作者框的范围要落在它里面） */
  imageSize: { width: number; height: number } | null;
}

/**
 * 挪标注的请求（R139）：标注 id + 新的**底图像素坐标**。
 *
 * 坐标用**底图像素**（不是归一化、不是画布像素）：作者在图上拖 ⇒ 拖出来的就是底图像素，
 * 与 `map.yaml` 里 `markers[].x/y` 的口径一致（K08 §3.6「坐标以图片像素记录」）。
 */
export interface WorldMapSetMarkerRequestPayload {
  markerId: string;
  x: number;
  y: number;
}

/** 挪标注的结果（R139） */
export interface WorldMapSetMarkerResult {
  ok: boolean;
  /** 给作者看的一句话（成了 / 为什么没成） */
  note: string;
  /** 挪到哪了（没成时为 null） */
  position: { x: number; y: number } | null;
  /** 改之前那一行（作者要挪回去，把这一行贴回去即可 ⇒ 回退的路摆在眼前） */
  previous: string[];
}

/**
 * 放标注的请求（R140）：绑哪个地点实体 + 落在哪（**底图像素坐标**）。
 */
export interface WorldMapCreateMarkerRequestPayload {
  /** 地点实体 id（K08 §3.7：标注即地点卡 ⇒ 标注必须绑一个真实存在的地点） */
  entityRef: string;
  x: number;
  y: number;
}

/** 放标注的结果（R140） */
export interface WorldMapCreateMarkerResult {
  ok: boolean;
  /** 给作者看的一句话（成了 / 为什么没成） */
  note: string;
  /** 新标注的 id 与位置（没成时为 null） */
  marker: { id: string; entityRef: string; x: number; y: number } | null;
}

/**
 * 挪事件锚点的请求（R141）：锚点 id + 新的**底图像素坐标**。
 */
export interface WorldMapSetAnchorRequestPayload {
  anchorId: string;
  x: number;
  y: number;
}

/** 挪事件锚点的结果（R141） */
export interface WorldMapSetAnchorResult {
  ok: boolean;
  /** 给作者看的一句话（成了 / 为什么没成） */
  note: string;
  /** 挪到哪了（没成时为 null） */
  position: { x: number; y: number } | null;
  /** 改之前那一行（作者要挪回去，把这一行贴回去即可） */
  previous: string[];
}

/**
 * 放事件锚点的请求（R142）：绑哪个事件 + 落在哪（**底图像素坐标**）。
 */
export interface WorldMapCreateAnchorRequestPayload {
  eventRef: string;
  x: number;
  y: number;
}

/** 放事件锚点的结果（R142） */
export interface WorldMapCreateAnchorResult {
  ok: boolean;
  /** 给作者看的一句话（成了 / 为什么没成） */
  note: string;
  /** 新锚点的 id 与位置（没成时为 null） */
  anchor: { id: string; eventRef: string; x: number; y: number } | null;
}

/** 底图登记的结果（R135）：**路径不出主进程**，只回项目内的相对路径与量出来的尺寸 */
export interface WorldMapUploadBaseResult {
  /** 作者取消了（没挑文件） */
  canceled: boolean;
  /** 成功时：项目内的相对路径（`world/assets/map/…`） */
  path: string | null;
  /** 量出来的像素尺寸（bounds 就是按它填的 ⇒ 作者再也填不对） */
  size: { width: number; height: number } | null;
  /** 给作者看的一句话（成功 / 没做 / 为什么没做） */
  note: string;
  /**
   * 作者**要自己改**的那三行（已有底图登记时不给写 ⇒ 把该改的给作者看），
   * 以及写盘时用的 map.yaml 相对路径。
   */
  snippet: string | null;
  /**
   * 换底图（R136）时**换之前**的那三行 ⇒ 作者想换回去，把它们贴回去即可
   * （旧的图片文件也**留在项目里**，没被删）。
   */
  previous: string[];
  /** map.yaml 的相对路径（作者要改的就是这个文件） */
  mapPath: string;
}

export type WorldMapViewRequestPayload = Record<string, never>;

/** 标注绑定的地点卡摘要（K08 §3.7：标注即地点卡） */
export interface WorldMapPlaceCard {
  id: string;
  name: string;
  type: string;
  layer: string;
  aliases: string[];
  visibility: string;
  filePath: string;
}

/** 地图标注（投影后：归一化坐标 + 地点实体名 + 卡摘要） */
export interface WorldMapViewMarker {
  id: string;
  layer: string;
  entityRef: string;
  entityName: string;
  /** 归一化坐标（0..1）：渲染层直接用，不必自己换算 */
  nx: number;
  ny: number;
  /** 底图像素坐标（作者写的那一对） */
  x: number;
  y: number;
  label: string;
  card: WorldMapPlaceCard | null;
}

/** 世界地图底图（R123）：把作者登记的底图读成 data URL 交给渲染层铺在坐标空间上 */
export interface WorldMapBasePayload {
  /** 真源里登记的底图路径（相对项目根）；没有登记底图 = null */
  path: string | null;
  exists: boolean;
  note: string;
  /** data URL（image/png 之类）；读不到或超限 = null */
  dataUrl: string | null;
  /** 底图像素尺寸（量出来的，不是作者写的） */
  size: { width: number; height: number } | null;
}

export interface WorldMapViewPayload {
  path: string;
  exists: boolean;
  note: string;
  /** 坐标空间（**作者框定的那一块**，底图像素坐标）；没有有效边界 = null（此时不产出坐标） */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
  /**
   * 画布宽高（= **bounds 那一块**的尺寸：作者框定的就是画布，底图按它裁切显示）。
   * 以前这里是"整张底图"的尺寸 —— 那等于"只能整张图当地图"，K08 §3.6 的「框定 bounds」就没处落脚。
   */
  canvas: { width: number; height: number } | null;
  /**
   * **底图声明的像素尺寸**（`base_size`）：作者框的那一块在**这张图**里的位置靠它换算
   * （框定模式下画的是整张图 ⇒ 拖出来的坐标就是底图像素坐标）。
   * 没有 `base_size` = null（此时画布就是 bounds 本身）。
   */
  baseSize: { width: number; height: number } | null;
  markers: WorldMapViewMarker[];
  /**
   * **项目里可放的地点**（R140：放标注时作者要选一个）。
   * 放标注 = 选一个地点实体 ⇒ 在图上点一下落一个标注（K08 §3.7：标注即地点卡 ⇒ 必须绑真实地点）。
   * 只给 **location 类**的实体（地图上放的是地点，不是事件）。
   */
  places: { id: string; name: string }[];
  /**
   * **项目里可挂的事件**（R142：放事件锚点时作者要选一个）。
   * 事件锚点 = 事件挂在地图上的坐标（K08 §3.8）⇒ 事件清单来自 `world/timeline.yaml`。
   */
  events: { id: string; title: string }[];
  /** 事件锚点（K08 §3.8：事件挂坐标 ⇒ 选事件能定位到地图上） */
  anchors: {
    id: string;
    eventRef: string;
    x: number;
    y: number;
    nx: number;
    ny: number;
    label: string;
  }[];
  layers: { kind: string; markerCount: number }[];
  findings: { code: string; severity: string; message: string; refs: string[] }[];
  orphanMarkers: string[];
  overlapClusters: { layer: string; members: string[] }[];
  outOfBoundsMarkers: string[];
  /** 落在底图边界之外的事件锚点 id */
  outOfBoundsAnchors: string[];
  /** 项目里的实体总数（地图只画标注过的那些） */
  entityCount: number;
  /**
   * **结构化摘要**（R124）：界面按行渲染这几项 ⇒ 说明不会堆成一长串。
   * 之前是一句 `A · B；C` 的自由文本，在窄栏里会断成四五行、读起来像碎片。
   */
  summary: { markers: number; layers: number; entities: number; findings: number; anchors: number };
}

/** 编年史（M4 / T4-8，R71）：大事年表 + 同一事件的多文化"伪史书" */
export interface ChronicleEntryPayload {
  eventId: string;
  title: string;
  year: number;
  displayYear: string | null;
  /** null = 该事件没有多文化版本（中性记载），不是"某个文化说了空话" */
  culture: string | null;
  account: string | null;
  source: string | null;
}

export interface ChronicleBookPayload {
  path: string;
  exists: boolean;
  note: string;
  /** 汇总的**结构化行**（R127）：界面逐行渲染，不切那串自由文本 */
  summary: SummaryRow[];
  calendars: { id: string; label: string; offset: number }[];
  activeCalendar: string | null;
  entries: ChronicleEntryPayload[];
  eras: { label: string; from: number; to: number; entries: number }[];
  divergences: { eventId: string; title: string; cultures: string[]; differing: boolean; note: string }[];
  withoutViewpoints: string[];
  orphanEvents: string[];
  uneraled: string[];
  ambiguousEra: boolean;
  /** era 卡上没写 `extensions.chronicle.{from,to}` 的那些：不猜年代边界，逐张点名 */
  eraSkipped: string[];
  stats: { events: number; entries: number; cultures: number };
}

export interface ChronicleBookRequestPayload {
  calendar?: string;
}

/** 爽点阈值：全部可选，**不传就不判定**（引擎侧同口径，见 world-engine/satisfaction.ts） */
export interface SatisfactionThresholdsPayload {
  same_type_streak_max?: number;
  release_interval_max?: number;
  strong_intensity?: number;
  suppress_streak_max?: number;
  promise_open_max?: number;
  no_advance_streak?: number;
}

export interface SatisfactionBoardRequestPayload {
  thresholds?: SatisfactionThresholdsPayload;
  currentChapter?: string;
}

export interface SatisfactionRowPayload {
  chapter: string;
  ordinal: number;
  hits: { id: string; type: string; intensity: number; beneficiary: string }[];
  promisesOpened: string[];
  phase: string | null;
  scenes: { total: number; advancing: number };
  /** null = 这一章没有场景声明，不是"推进率 0" */
  advanceRate: number | null;
}

export interface SatisfactionPromisePayload {
  id: string;
  promise: string;
  status: string;
  /** null = 章号认不出或没写到货期，不编 0 */
  overdueBy: number | null;
  evidence: "hit" | "foreshadow" | "none";
}

export interface SatisfactionBoardPayload {
  path: string;
  exists: boolean;
  note: string;
  /** 汇总的**结构化行**（R127）：界面逐行渲染，不切那串自由文本 */
  summary: SummaryRow[];
  chapterTotal: number;
  currentChapter: string | null;
  rows: SatisfactionRowPayload[];
  promises: SatisfactionPromisePayload[];
  findings: { id: string; severity: "error" | "warn" | "info"; rule: string; message: string }[];
  /** 没判定的规则逐条列在这里：面板必须把"没判的"和"判过没问题"分开显示 */
  notEvaluated: { rule: string; reason: string }[];
  stats: { hits: number; scenes: number; advanceRate: number | null; openPromises: number; strongestStreak: number };
}

/**
 * 存量导入（M5 / T5-7，R77）——挑选闸门与预演的载荷。
 *
 * 三个"看着奇怪"的形状都是刻意的：
 * - `ImportPickPayload` **没有 path**：路径只留在主进程的闸门登记表里，渲染层拿到的只有票据；
 * - `ImportPreviewPayload` **没有正文全文**：32MB 的稿子不整篇过 IPC，界面要的是字数与摘录；
 * - `encoding.assumed` 与 `split.hardSplit` 必须一路带到面板：编码是猜的、章没切开，
 *   都是作者入库前必须知道的事，藏在主进程等于没说。
 */

export interface ImportPickPayload {
  /** 闸门票据（10 分钟 TTL）：此后预览与入库都只认它 */
  ticket: string;
  /** 只给文件名（basename），不是路径 */
  name: string;
  bytes: number;
}

/** 一条清洗规则及其来源：作者要看得见"用了哪些规则"才知道报告在说什么 */
export interface ImportRulePayload {
  id: string;
  pattern: string;
  source: "builtin" | "custom";
}

export interface ImportCleanPayload {
  lineEndingNormalized: number;
  blankLinesCollapsed: number;
  removed: { rule: string; count: number; sample: string }[];
  redacted: { kind: string; count: number }[];
}

export interface ImportEncodingPayload {
  encoding: string;
  bom: string | null;
  /** true = GB18030 兜底，是猜的；面板必须把这句说出来 */
  assumed: boolean;
  /** false = 连猜都不猜（空文件） */
  ok: boolean;
  note: string;
}

export interface ImportChapterPreviewPayload {
  index: number;
  title: string;
  /** 与编辑器 / 导出同一个 countWords 口径 */
  chars: number;
  /** 摘录（≤80 字符，空白折成单空格）；不是正文全文 */
  excerpt: string;
}

export interface ImportPreviewPayload {
  name: string;
  bytes: number;
  /**
   * 预演时 `outline/outline.yaml` 的 hash（项目还没有大纲时为 null）。
   * 入库要把它带回去做并发检测——作者看报告这几秒里别人改了大纲，就不能覆盖。
   * 由主进程读：渲染层不该自己持有真源路径字符串。
   */
  outlineHash: string | null;
  encoding: ImportEncodingPayload;
  clean: ImportCleanPayload;
  rules: ImportRulePayload[];
  split: {
    /** false = 没按标题切开（整篇当一章） */
    hardSplit: boolean;
    note: string | null;
    chapterCount: number;
    volumeHints: string[];
    hasPreamble: boolean;
    preambleChars: number;
  };
  chapters: ImportChapterPreviewPayload[];
  totalChars: number;
  /**
   * 海选候选（I09 §3.4 的「规则海选」）：疑似章节标题的行。
   *
   * AI 只能指认这批候选的**序号**（不给行号、不给原文），
   * 作者也靠它来挑"该在这里切开"的位置。
   */
  candidates: ImportCandidatePayload[];
  /** 误切异常（I09 §3.5 的三类校验）：章号连续性 / 标题长度 / 章节字数分布 */
  miscuts: ImportMiscutPayload[];
  /** 这次的切分是"正则切的"还是"AI 筛过的"，以及回退理由 */
  ai: ImportAiSplitPayload;
  /**
   * 续跑线索：这份稿子有一份**可续跑**的任务记录（主进程按源文件指纹核对出来的——
   * 渲染层不自己判"是不是同一份"，判错了续跑就会把两本书接在一起）。
   */
  resume: ImportResumePayload | null;
}

/** 续跑线索：上次导到哪、还剩多少 */
export interface ImportResumePayload {
  /** 任务记录 id（入库时带回，主进程凭它续跑） */
  job_id: string;
  /** 源文件名（只 basename） */
  source_name: string;
  /** 上次已落盘的章数 */
  last_chapter: number;
  /** 这一批一共有几章 */
  total_chapters: number;
}

/** 一条海选候选 */
export interface ImportCandidatePayload {
  /** 候选序号（0 起）：AI 只报这个 */
  index: number;
  /** 行号（1 起） */
  line: number;
  /** 候选行原文 */
  text: string;
  /** 命中的海选规则 id */
  rule: string;
  /** 严筛（正则）也认它 ⇒ 这条已经是确定的章标题 */
  strict: boolean;
}

/** 一处误切异常 */
export interface ImportMiscutPayload {
  /** 章在预演清单里的序号 */
  index: number;
  title: string;
  chars: number;
  issues: { code: string; message: string }[];
}

/** AI 筛选的状态：面板要看得见"现在是正则切的还是 AI 切的" */
export interface ImportAiSplitPayload {
  /** 这次切分是不是 AI 筛出来的 */
  used: boolean;
  provider_id: string;
  model: string;
  /** 保留了几条候选 */
  kept: number;
  /** 被丢弃的条目（越界 / 重复）逐条点名 */
  rejected: string[];
  /** 回退到正则切分的理由（空 = 没回退） */
  fallback: string;
  /** 人工校正的条数 */
  corrections: number;
}

/** 预演请求：票据必填；规则是**追加**在默认规则之后的自定义正则 */
export interface ImportPreviewRequestPayload {
  ticket: string;
  rules?: { id: string; pattern: string }[];
}

/** AI 二次筛选切章的请求（只读；只改计划） */
export interface ImportAiSplitRequestPayload {
  ticket: string;
  /**
   * 当前生效的自定义清洗规则（追加在默认规则之后）。
   *
   * **必须与预演用的是同一套**：清洗会删行 ⇒ 候选行号会变。
   * 规则对不上，AI 认下的"第 N 行"就指到了别的文字上，作者在界面上看到的候选却是按另一套算的。
   */
  rules?: { id: string; pattern: string }[];
}

/** 人工校正的请求（只读；只改计划） */
export interface ImportCorrectRequestPayload {
  ticket: string;
  /** 与 AI 筛选同一套自定义清洗规则（见 `ImportAiSplitRequestPayload.rules`） */
  rules?: { id: string; pattern: string }[];
  /**
   * 校正动作：
   * - `merge`：把第 at 章与第 at+1 章合并；
   * - `split`：在第 candidateIndex 条海选候选所在处切开；
   * - `move`：把第 from 章挪到第 to 位。
   */
  correction:
    | { kind: "merge"; at: number }
    | { kind: "split"; candidateIndex: number }
    | { kind: "move"; from: number; to: number };
}

/** AI 筛选 / 人工校正的结果：回一份新的预演（面板直接换上去） */
export interface ImportPlanResultPayload {
  preview: ImportPreviewPayload;
  /** 这一步做了什么（面板回执原话） */
  note: string;
}

/**
 * 入库请求（R79）。**载荷里没有正文**：入库方凭同一张票重新读出、重新清洗、重新分章，
 * 所以"渲染层改一下正文再提交"这种篡改在数据结构上就不成立；
 * `rules` 必须与预演时同一套，否则对账比的是两个不同算法的结果。
 */
export interface ImportApplyPayload {
  ticket: string;
  rules?: { id: string; pattern: string }[];
  /** 卷名，默认「导入·<文件名>」 */
  volumeTitle?: string;
  /** 归属的幕（总纲 acts 的 name）；不传用第一幕；传了又不认识 ⇒ 报错并列出可选 */
  act?: string;
  /** 没切开（整篇作一章）时的显式确认 */
  confirmSingleChapter?: boolean;
  /** 确认时读到的 outline.yaml hash；不一致即拒（不覆盖别人的改动） */
  baseHash?: string;
  /**
   * 续跑：凭这张任务记录接着写（I09 §2.7 的断点续跑）。
   *
   * 主进程会核对三件事，任一不成立即拒：**同一份稿子**（指纹）、**同一份切分**（章数与字数）。
   * 不传 = 全新导入（会新建一卷）。
   */
  jobId?: string;
}

/** 取消这次导入的请求（票据是渲染层唯一能拿到的把手） */
export interface ImportCancelRequestPayload {
  ticket: string;
}

/** 取消的结果：告诉作者"停下"还是"这次放弃了" */
export interface ImportCancelResultPayload {
  /** 这次取消有没有让**正在跑的入库**停下 */
  stopped: boolean;
  /** 票据是否已作废（作废后不能再用它入库） */
  revoked: boolean;
  note: string;
}

/** 一条可续跑的导入任务（面板上要让作者看见"上次那稿子没导完"） */
export interface ImportJobSummaryPayload {
  id: string;
  /** 源文件名（只 basename） */
  source_name: string;
  status: string;
  /** 上次已落盘的章数 */
  last_chapter: number;
  /** 这一批一共有几章 */
  total_chapters: number;
}

/** 一章的入库结果：预演字数与落盘字数并排放，对不上就是 `reconciled: false` */
export interface ImportAppliedChapterPayload {
  outlineId: string;
  chapterId: string;
  path: string;
  title: string;
  expectedChars: number;
  writtenWords: number;
  reconciled: boolean;
}

export interface ImportApplyResultPayload {
  volumeId: string;
  volumeTitle: string;
  act: string;
  outlinePath: string;
  outlineHash: string;
  /** 入库前的破坏前快照 id（撤销窗口；拿不到快照时根本走不到写入那一步） */
  snapshotId: string | null;
  created: ImportAppliedChapterPayload[];
  /** 对账不上的章（含两边字数），空数组才算全部对上 */
  mismatched: string[];
  /** 首章之前的内容：**不入库**，只把字数与摘录交还给作者决定挪去哪儿 */
  preamble: { chars: number; excerpt: string } | null;
  totalExpectedChars: number;
  totalWrittenWords: number;
  /** 这次导入的任务记录 id（断点续跑靠它） */
  jobId: string;
  /** true = 作者中途取消了（只写了一部分，剩下的可续跑） */
  stopped: boolean;
  /** 已经写进盘上的章数 */
  writtenChapters: number;
  /** 这一批一共有几章 */
  totalChapters: number;
  note: string;
}
