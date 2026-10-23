/* SPDX-License-Identifier: Apache-2.0 */
// 御书 preload：仅经 contextBridge 暴露白名单 API（一消息一方法），不做业务逻辑。
// 通道清单与 apps/desktop/src/shared/ipc.ts 保持一致（以该文件为唯一事实源）。
const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.data;
    // 注意：contextBridge 跨隔离世界克隆 Error 时会丢失自定义属性（如 code），
    // 因此错误码同时写入 message 前缀（UI 与自动化据此识别）。
    const code = (result.error && result.error.code) || "E_UNKNOWN";
    const message = (result.error && result.error.message) || "未知错误";
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    throw error;
  }
  return result;
}

contextBridge.exposeInMainWorld("yushu", {
  project: {
    open: (payload) => invoke("project:open", payload),
    close: () => invoke("project:close"),
    tree: () => invoke("project:tree"),
    current: () => invoke("project:current"),
    chooseDirectory: () => invoke("project:chooseDirectory"),
    exportPick: () => invoke("project:exportPick"),
    exportPreview: (payload) => invoke("project:exportPreview", payload),
    exportRun: (payload) => invoke("project:exportRun", payload),
    create: (payload) => invoke("project:create", payload),
    world: () => invoke("project:world"),
  },
  pack: {
    catalog: () => invoke("pack:catalog"),
    fuse: (packIds) => invoke("pack:fuse", { packIds }),
  },
  card: {
    list: () => invoke("card:list"),
    read: (path) => invoke("card:read", { path }),
    write: (payload) => invoke("card:write", payload),
  },
  doc: {
    read: (path) => invoke("doc:read", { path }),
    write: (path, content, baseHash) => invoke("doc:write", { path, content, baseHash }),
    rename: (from, to) => invoke("doc:rename", { from, to }),
  },
  outline: {
    read: () => invoke("outline:read"),
    generate: (payload) => invoke("outline:generate", payload),
    write: (payload) => invoke("outline:write", payload),
    createChapter: (payload) => invoke("outline:createChapter", payload),
  },
  ai: {
    config: () => invoke("ai:config"),
    saveConfig: (payload) => invoke("ai:saveConfig", payload),
    /** AI 总开关（A4）：翻转主进程侧事实源并回读配置 */
    setEnabled: (enabled) => invoke("ai:setEnabled", { enabled }),
    setKey: (providerId, apiKey) => invoke("ai:setKey", { providerId, apiKey }),
    /** 加密保存 provider Key（T3-14）：apiKey 单向传给主进程，返回值只含 key_ref 与三态布尔 */
    saveKey: (providerId, apiKey) => invoke("ai:saveKey", { providerId, apiKey }),
    /** 清除凭据（T3-14）：删凭据库密文条目并去掉真源 key_ref */
    clearKey: (providerId) => invoke("ai:clearKey", { providerId }),
    drafts: () => invoke("ai:drafts"),
    context: (payload) => invoke("ai:context", payload),
    start: (payload) => invoke("ai:start", payload),
    abort: (streamId) => invoke("ai:abort", { streamId }),
    adopt: (payload) => invoke("ai:adopt", payload),
    usage: () => invoke("ai:usage"),
    /** Token 与成本面板（T3-12，J09）：双口径聚合 + 稳定前缀编排核对（只读；payload 指定核对章节） */
    cost: (payload) => invoke("ai:cost", payload),
    /** 候选拒绝原因记录（T3-11，J15）：写入 .yushu/ai-feedback.jsonl 并回传统计 */
    reject: (payload) => invoke("ai:reject", payload),
    /** 拒绝原因统计（本机） */
    feedback: () => invoke("ai:feedback"),
    /**
     * 订阅流式事件（主进程 → 渲染层单向推送）；返回取消订阅函数。
     * 只透传事件数据，不向渲染层暴露 ipcRenderer / event 对象。
     */
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("ai:event", listener);
      return () => ipcRenderer.removeListener("ai:event", listener);
    },
  },
  /** 中文自查（T3-13，J14）：只读检测 + 只回改后正文（写盘仍走 chapter:write） */
  text: {
    proofread: (payload) => invoke("text:proofread", payload),
    fixBody: (payload) => invoke("text:fixBody", payload),
  },
  rule: {
    catalog: () => invoke("rule:catalog"),
    dryRun: (payload) => invoke("rule:dryRun", payload),
  },
  consistency: {
    check: (payload) => invoke("consistency:check", payload),
  },
  propagate: {
    preview: (payload) => invoke("propagate:preview", payload),
  },
  proposal: {
    list: () => invoke("proposal:list"),
    decide: (payload) => invoke("proposal:decide", payload),
    apply: (payload) => invoke("proposal:apply", payload),
  },
  foreshadow: {
    board: () => invoke("foreshadow:board"),
  },
  timeline: {
    view: (payload) => invoke("timeline:view", payload),
  },
  graph: {
    relation: (payload) => invoke("graph:relation", payload),
  },
  map: {
    view: () => invoke("map:view"),
    base: () => invoke("map:base"),
    /** 底图登记（R135）：主进程弹原生对话框挑一张图 ⇒ 拷进项目 ⇒ 写 map.yaml；**路径不出主进程** */
    uploadBase: (payload) => invoke("map:uploadBase", payload),
    /** 框定边界（R138）：作者在底图上拖出的那一块（底图像素坐标）⇒ 写 map.yaml 的 bounds */
    setBounds: (payload) => invoke("map:setBounds", payload),
    /** 挪标注（R139）：作者在图上把标注拖到新位置 ⇒ 写 map.yaml 里那一个标注的 x / y */
    setMarker: (payload) => invoke("map:setMarker", payload),
    /** 放标注（R140）：作者选一个地点 ⇒ 在图上点一下 ⇒ 落一个标注（写 map.yaml 的 markers 段） */
    createMarker: (payload) => invoke("map:createMarker", payload),
    /** 挪事件锚点（R141）：作者在图上把锚点拖到新位置 ⇒ 写 map.yaml 里那一个锚点的 x / y */
    setAnchor: (payload) => invoke("map:setAnchor", payload),
  },
  chronicle: {
    book: (payload) => invoke("chronicle:book", payload),
  },
  satisfaction: {
    board: (payload) => invoke("satisfaction:board", payload),
  },
  import: {
    pick: () => invoke("import:pick"),
    preview: (payload) => invoke("import:preview", payload),
    apply: (payload) => invoke("import:apply", payload),
    /** AI 二次筛选切章（R107）：只改计划，不写盘 */
    aiSplit: (payload) => invoke("import:aiSplit", payload),
    /** 人工校正切分（R107）：只改计划，不写盘 */
    correct: (payload) => invoke("import:correct", payload),
    /** 取消这次导入（R108）：作废票据 + 记一次取消（正在入库的话在章的边界上停） */
    cancel: (payload) => invoke("import:cancel", payload),
    /** 可续跑的导入任务（R108）：只读 */
    jobs: () => invoke("import:jobs"),
  },
  export: {
    preview: (payload) => invoke("export:preview", payload),
    run: (payload) => invoke("export:run", payload),
    clipboard: (payload) => invoke("export:clipboard", payload),
  },
  bible: {
    preview: (payload) => invoke("bible:preview", payload),
    run: (payload) => invoke("bible:run", payload),
  },
  pov: {
    preview: (payload) => invoke("pov:preview", payload),
    writeConfig: (payload) => invoke("pov:writeConfig", payload),
    setChapter: (payload) => invoke("pov:setChapter", payload),
  },
  publish: {
    board: () => invoke("publish:board"),
    setStatus: (payload) => invoke("publish:setStatus", payload),
    schedule: (payload) => invoke("publish:schedule", payload),
  },
  index: {
    status: () => invoke("index:status"),
    rebuild: (payload) => invoke("index:rebuild", payload),
    search: (keyword, limit) => invoke("index:search", { keyword, limit }),
    /**
     * 订阅索引重建进度（T2-5 切片 B：分片写入 / 段合并；主进程 → 渲染层单向推送）；
     * 返回取消订阅函数，只透传事件数据。
     */
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("index:progress", listener);
      return () => ipcRenderer.removeListener("index:progress", listener);
    },
  },
  naming: {
    generate: (payload) => invoke("naming:generate", payload),
  },
  library: {
    /** 稿件总览（T2-4 切片 A：全库视图；只读大纲 + 章节文件的汇总） */
    list: () => invoke("library:list"),
  },
  app: {
    writeClipboard: (text) => invoke("app:writeClipboard", { text }),
    /**
     * 订阅「关闭窗口前落盘」请求（主进程 → 渲染层单向推送）；返回取消订阅函数。
     * 渲染层完成 flush 后必须调用 flushDone() 回执，主进程才会真正关闭窗口（超时兜底 5s）。
     */
    onBeforeClose: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("app:beforeClose", listener);
      return () => ipcRenderer.removeListener("app:beforeClose", listener);
    },
    /** 落盘完成回执（单向发送；payload 供主进程记录日志：{ editorFlushed, detail, error }） */
    flushDone: (payload) => ipcRenderer.send("app:flushDone", payload),
  },
  chapter: {
    read: (path) => invoke("chapter:read", { path }),
    write: (payload) => invoke("chapter:write", payload),
    writeSidecar: (payload) => invoke("chapter:writeSidecar", payload),
  },
  recovery: {
    /** 编辑日志（T2-8）：写入当前正文快照（输入期间短防抖调用） */
    writeJournal: (payload) => invoke("recovery:writeJournal", payload),
    /** 保存成功后清除本编辑器对应章节的日志 */
    clearJournal: (path) => invoke("recovery:clearJournal", { path }),
    /** 进入项目时检测可恢复条目（journal 与磁盘不一致才返回） */
    list: () => invoke("recovery:list"),
    /** 丢弃某章节的编辑日志 */
    discard: (path) => invoke("recovery:discard", { path }),
  },
  snapshot: {
    /** 快照列表与 blob 占用统计（T2-7 切片 A：内容寻址快照） */
    state: () => invoke("snapshot:state"),
    /** 立即快照（手动 = 强制，不受 60s 最小间隔限制） */
    take: () => invoke("snapshot:take"),
    /** 整体回滚到指定快照（恢复前自动生成 pre_restore 快照） */
    restore: (id) => invoke("snapshot:restore", { id }),
  },
  session: {
    /** 会话异常退出检测（T2-8 切片 B）：上次会话是否异常退出 + 最近快照新鲜度 */
    status: () => invoke("session:status"),
  },
  stats: {
    /** 码字统计（T2-9 切片 A）：今日 / 日序列 / 周月汇总 / 目标 / 断更 */
    read: () => invoke("stats:read"),
    /** 设置每日目标（0 = 清除目标） */
    setGoal: (payload) => invoke("stats:setGoal", payload),
    /** 写作活动心跳（T2-9 切片 C）：编辑输入期间节流上报（活跃时长 / 会话） */
    activity: () => invoke("stats:activity"),
  },
  git: {
    /** Git 版本管理（T2-7 切片 B）：状态 / 变更 / 最近提交 */
    state: () => invoke("git:state"),
    /** 初始化仓库（main 分支；幂等） */
    init: () => invoke("git:init"),
    /** 提交全部变更（一次批量改动 = 一次提交） */
    commit: (payload) => invoke("git:commit", payload),
    /** 整体回滚到指定提交（工作区语义：不改写历史；回滚前强制 pre_restore 快照） */
    rollback: (payload) => invoke("git:rollback", payload),
  },
  memory: {
    /** 五层记忆（T3-5）：摘要 / 事实台账 / 目标 / 体检发现 / 跨项目拒绝清单 */
    state: () => invoke("memory:state"),
    /** AI 摘要候选（生成不入库——采纳是用户显式动作） */
    summarize: (payload) => invoke("memory:summarize", payload),
    /** 批量补摘要候选（T5-9 第二段，R106）：与预算护栏联动；产出的也只是候选 */
    summarizeBatch: (payload) => invoke("memory:summarizeBatch", payload),
    /** 摘要入库：origin=ai（rev>0 拒绝覆盖）/ origin=human（rev+1） */
    saveSummary: (payload) => invoke("memory:saveSummary", payload),
    /** 事实登记（带出处：章节 + 字符区间，服务端计算摘录 hash） */
    saveFact: (payload) => invoke("memory:saveFact", payload),
    /** 删除事实（携带 baseHash 并发检测） */
    deleteFact: (payload) => invoke("memory:deleteFact", payload),
    /** 注入预演（T3-6）：对指定章节输出注入计划（决策 + 排除原因 + token 估算） */
    injectionPreview: (payload) => invoke("memory:injectionPreview", payload),
    /** 上下文组装（T3-7）：固定槽位顺序 + 槽位 cap + 全局预算裁剪 + 去重（决策与证据） */
    assemble: (payload) => invoke("memory:assemble", payload),
    /** RAG 检索预演（T3-8）：向量路 + 关键词路并行 → RRF 融合 → 可选重排（只读） */
    ragPreview: (payload) => invoke("memory:ragPreview", payload),
    /** 上下文快照导出（T3-9）：组装 + 决策证据写入 .yushu/context-log/（可复现指纹） */
    contextSnapshot: (payload) => invoke("memory:contextSnapshot", payload),
  },
  extract: {
    /** 设定抽取预演（T3-10）：JSON Schema 契约 + 后校验 + 修复回喂；候选一律 status=candidate（不入库） */
    preview: (payload) => invoke("extract:preview", payload),
    /** 采纳抽取候选（写设定卡真源）：仅 new 候选允许（服务端复核——augment/conflict 明确拒绝） */
    adopt: (payload) => invoke("extract:adopt", payload),
  },
});