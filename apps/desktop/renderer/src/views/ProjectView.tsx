import { useCallback, useEffect, useState } from "react";
import type {
  DocSnapshot,
  IndexSearchResultPayload,
  IndexStatusPayload,
  ProjectSnapshot,
  TreeEntry,
} from "../../../src/shared/ipc";
import { api } from "../api";

/** 项目视图：目录树 + 文档编辑（带 baseHash 并发检测）+ 检索索引卡（T1-21 无头能力的桌面入口） */
export function ProjectView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tree, setTree] = useState<TreeEntry[]>(snapshot.tree);
  const [doc, setDoc] = useState<DocSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("已打开项目");
  const [error, setError] = useState<string | null>(null);

  const [indexStatus, setIndexStatus] = useState<IndexStatusPayload | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [searchResult, setSearchResult] = useState<IndexSearchResultPayload | null>(null);

  const dirty = doc !== null && draft !== doc.content;

  const refresh = useCallback(async () => {
    try {
      setTree(await api().project.tree());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshIndex = useCallback(async () => {
    try {
      setIndexStatus(await api().index.status());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshIndex();
  }, [refresh, refreshIndex]);

  const openDoc = async (path: string) => {
    try {
      setError(null);
      const snap = await api().doc.read(path);
      setDoc(snap);
      setDraft(snap.content);
      setStatus(`已读取 ${path}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async () => {
    if (!doc) return;
    try {
      setError(null);
      const snap = await api().doc.write(doc.path, draft, doc.hash);
      setDoc(snap);
      setStatus(`已保存（${snap.hash.slice(0, 10)}…）`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 重建索引（T1-21）：全量可重建，删库后重跑零丢失 */
  const rebuildIndex = async () => {
    setIndexBusy(true);
    setError(null);
    try {
      const result = await api().index.rebuild();
      setIndexStatus(result);
      setStatus(
        `索引已重建：${result.stats.files} 文件 / ${result.stats.entities} 实体 / ${result.stats.refs} 引用 / ${result.stats.chunks} 块` +
          (result.skipped.length > 0 ? `（跳过 ${result.skipped.length} 个解析失败文件）` : ""),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIndexBusy(false);
    }
  };

  const doSearch = async () => {
    if (keyword.trim() === "") return;
    try {
      setError(null);
      setSearchResult(await api().index.search(keyword.trim()));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="project">
      <aside>
        <div className="panel">
          <div className="panel-title">
            <span className="muted">检索索引（.yushu/index.db）</span>
            <button type="button" className="link" onClick={refreshIndex}>
              刷新
            </button>
          </div>
          <div className="muted">
            {indexStatus?.exists && indexStatus.stats
              ? `已构建：${indexStatus.stats.files} 文件 · ${indexStatus.stats.entities} 实体 · ${indexStatus.stats.refs} 引用 · ${indexStatus.stats.chunks} 块（${indexStatus.stats.builtAt.replace("T", " ").slice(0, 19)}）`
              : "尚未构建（索引可随删随建，真源不受影响）"}
          </div>
          <div className="outline-actions">
            <button type="button" disabled={indexBusy} onClick={rebuildIndex}>
              {indexBusy ? "重建中…" : "重建索引"}
            </button>
          </div>
          <div className="dir-row">
            <input
              value={keyword}
              placeholder="检索正文 / 设定…"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void doSearch();
              }}
            />
            <button type="button" onClick={doSearch}>
              检索
            </button>
          </div>
          {searchResult && (
            <div className="search-results">
              <div className="muted">
                「{searchResult.keyword}」：实体 {searchResult.entities.length} · 正文块 {searchResult.chunks.length}
              </div>
              <ul>
                {searchResult.entities.map((entity) => (
                  <li key={entity.id} onClick={() => void openDoc(entity.filePath)}>
                    <strong>{entity.name}</strong>
                    <span className="muted"> {entity.type} · {entity.layer}</span>
                  </li>
                ))}
                {searchResult.chunks.map((chunk) => (
                  <li key={chunk.chunkId} onClick={() => void openDoc(chunk.path)}>
                    <span className="muted">{chunk.snippet}</span>
                    <div className="muted">
                      {chunk.path} · 第 {chunk.charStart + 1}-{chunk.charEnd} 字符
                      {chunk.entities.length > 0 ? ` · 涉及 ${chunk.entities.join("、")}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="panel-title">
          <span className="muted">目录树</span>
          <button type="button" className="link" onClick={refresh}>
            刷新
          </button>
        </div>
        <ul className="tree">
          {tree.map((entry) => (
            <li
              key={entry.path}
              className={[entry.type, doc?.path === entry.path ? "active" : ""].filter(Boolean).join(" ")}
              title={entry.path}
              onClick={entry.type === "file" ? () => void openDoc(entry.path) : undefined}
            >
              {entry.type === "dir" ? `▸ ${entry.path}` : entry.path}
            </li>
          ))}
        </ul>
      </aside>
      <section className="editor">
        <div className="panel-title">
          <span className="muted">{doc ? doc.path : "选择左侧文件进行编辑"}</span>
          {dirty && <span className="dirty">有未保存修改</span>}
        </div>
        <textarea
          spellCheck={false}
          value={draft}
          disabled={!doc}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="editor-foot">
          <button type="button" className="primary" onClick={save} disabled={!doc || !dirty}>
            保存（baseHash 并发检测）
          </button>
          {error ? <span className="error-text">{error}</span> : <span className="muted">{status}</span>}
        </div>
      </section>
    </div>
  );
}