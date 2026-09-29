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
    setKey: (providerId, apiKey) => invoke("ai:setKey", { providerId, apiKey }),
    drafts: () => invoke("ai:drafts"),
    context: (payload) => invoke("ai:context", payload),
    start: (payload) => invoke("ai:start", payload),
    abort: (streamId) => invoke("ai:abort", { streamId }),
    adopt: (payload) => invoke("ai:adopt", payload),
    usage: () => invoke("ai:usage"),
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
  export: {
    preview: () => invoke("export:preview"),
    run: (payload) => invoke("export:run", payload),
    clipboard: (payload) => invoke("export:clipboard", payload),
  },
  index: {
    status: () => invoke("index:status"),
    rebuild: () => invoke("index:rebuild"),
    search: (keyword, limit) => invoke("index:search", { keyword, limit }),
  },
  naming: {
    generate: (payload) => invoke("naming:generate", payload),
  },
  app: {
    writeClipboard: (text) => invoke("app:writeClipboard", { text }),
  },
  chapter: {
    read: (path) => invoke("chapter:read", { path }),
    write: (payload) => invoke("chapter:write", payload),
    writeSidecar: (payload) => invoke("chapter:writeSidecar", payload),
  },
});