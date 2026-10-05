import { useCallback, useEffect, useState } from "react";
import type {
  DocSnapshot,
  IndexProgressPayload,
  IndexSearchResultPayload,
  IndexStatusPayload,
  ProjectSnapshot,
  SnapshotStatePayload,
  TreeEntry,
} from "../../../src/shared/ipc";
import { api } from "../api";
import { cardTypeLabel, layerLabel } from "../card-labels";

/** 自动增量状态文案（T2-5 切片 B）：索引未构建时不宣称"已同步"（首次构建仍由用户显式触发） */
function indexRefreshLabel(status: IndexStatusPayload): string {
  const refresh = status.refresh;
  if (!refresh) return "";
  if (!status.exists) return "自动增量：待索引首次构建后生效（保存后自动刷新）";
  if (refresh.lastError) return `自动增量：上次失败（${refresh.lastError.slice(0, 60)}），下次保存后重试`;
  if (refresh.pending || refresh.running) return "自动增量：保存后正在刷新…";
  if (refresh.lastRunAt) return `自动增量：已同步（${refresh.lastRunAt.replace("T", " ").slice(0, 19)}）`;
  return "自动增量：保存后自动刷新";
}

/** 重建进度文案（T2-5 切片 B：解析 → 分片写入 → 段合并） */
function indexProgressLabel(progress: IndexProgressPayload): string {
  switch (progress.phase) {
    case "parse":
      return `解析文件 ${progress.done}/${progress.total}`;
    case "files":
      return `写入文件表 ${progress.done}/${progress.total}`;
    case "chunks":
      return `分片写入 ${progress.done}/${progress.total} 块`;
    case "merge":
      return "合并 FTS 索引段";
  }
}

/** 进度百分比（解析阶段总数可能未定：为 0 时按不确定态处理） */
function indexProgressPercent(progress: IndexProgressPayload): number {
  if (progress.phase === "merge") return 100;
  if (progress.total <= 0) return 0;
  return Math.min(100, Math.round((progress.done / progress.total) * 100));
}

/** 快照来源文案（T2-7 切片 A；T2-8 切片 B 增补破坏前） */
function snapshotReasonLabel(reason: string): string {
  switch (reason) {
    case "manual":
      return "手动";
    case "pre_restore":
      return "恢复前";
    case "pre_destructive":
      return "破坏前";
    default:
      return "自动";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 项目视图：目录树 + 文档编辑（带 baseHash 并发检测）+ 检索索引卡（T1-21 无头能力的桌面入口） */
export function ProjectView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tree, setTree] = useState<TreeEntry[]>(snapshot.tree);
  const [doc, setDoc] = useState<DocSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("已打开项目");
  const [error, setError] = useState<string | null>(null);

  const [indexStatus, setIndexStatus] = useState<IndexStatusPayload | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  /** 重建进度（T2-5 切片 B）：仅重建进行中显示 */
  const [indexProgress, setIndexProgress] = useState<IndexProgressPayload | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchResult, setSearchResult] = useState<IndexSearchResultPayload | null>(null);

  /** 本地快照（T2-7 切片 A）：内容寻址快照的状态 / 操作 */
  const [snapState, setSnapState] = useState<SnapshotStatePayload | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapStatus, setSnapStatus] = useState("");
  /** 恢复需二次确认（页内确认行，不用系统对话框——防手滑且可自动化取证） */
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);

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

  const refreshSnapshots = useCallback(async () => {
    try {
      setSnapState(await api().snapshot.state());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshIndex();
    void refreshSnapshots();
  }, [refresh, refreshIndex, refreshSnapshots]);

  // 重建进度订阅（T2-5 切片 B）：主进程经 index:progress 推送（仅手动重建期间有事件）
  useEffect(() => api().index.onProgress(setIndexProgress), []);

  /** 立即快照（手动强制；不受 60s 最小间隔限制） */
  const takeSnapshot = async () => {
    setSnapBusy(true);
    setError(null);
    try {
      const result = await api().snapshot.take();
      setSnapStatus(
        result.outcome === "taken"
          ? `已生成快照（${snapshotReasonLabel(result.snapshot?.reason ?? "manual")} · ${result.snapshot?.files ?? 0} 文件 · ${formatBytes(result.snapshot?.bytes ?? 0)}）`
          : result.outcome === "unchanged"
            ? "内容与最新快照一致，未新增"
            : "距上一份快照不足 60s，已跳过（自动策略）",
      );
      await refreshSnapshots();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSnapBusy(false);
    }
  };

  /** 整体回滚（二次确认后；服务端恢复前强制生成 pre_restore 快照） */
  const restoreSnapshot = async (id: string) => {
    setSnapBusy(true);
    setError(null);
    setRestoreConfirmId(null);
    try {
      const result = await api().snapshot.restore(id);
      setSnapStatus(
        `已恢复到快照 ${result.id}：写回 ${result.restoredFiles} 个文件、重建 ${result.recreatedFiles} 个被删文件；` +
          `快照后新增的 ${result.extraFiles.length} 个文件保守保留；恢复前快照 ${result.preRestoreId} 已生成（可再回滚）`,
      );
      await refreshSnapshots();
      await refresh();
      void refreshIndex();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSnapBusy(false);
    }
  };

  // 自动增量（T2-5 切片 B）：刷新待命 / 执行中时轮询状态（结束后自动停，不常驻轮询）
  useEffect(() => {
    const st = indexStatus?.refresh;
    if (!st || (!st.pending && !st.running)) return;
    const timer = window.setInterval(() => void refreshIndex(), 1200);
    return () => window.clearInterval(timer);
  }, [indexStatus, refreshIndex]);

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

  /** 重建索引（T1-21 全量 / T2-5 增量）：增量复用未变文件；完整性失败自动自愈为全量；全程推送进度（切片 B） */
  const rebuildIndex = async (incremental = false) => {
    setIndexBusy(true);
    setError(null);
    setIndexProgress(null);
    try {
      const result = await api().index.rebuild(incremental ? { incremental: true } : {});
      setIndexStatus(result);
      const modeText =
        result.mode === "incremental"
          ? `增量：复用 ${result.reusedFiles} · 更新 ${result.updatedFiles} · 移除 ${result.removedFiles} 个文件`
          : `全量 · 分片 ${result.shards} 批 · 解析 ${result.parseVia === "utility" ? "utility 进程" : "主进程（回退）"}`;
      setStatus(
        `索引已重建（${modeText}）：${result.stats.files} 文件 / ${result.stats.entities} 实体 / ${result.stats.refs} 引用 / ${result.stats.chunks} 块` +
          (result.skipped.length > 0 ? `（跳过 ${result.skipped.length} 个解析失败文件）` : "") +
          (result.integrityIssues.length > 0 ? `（完整性自愈：${result.integrityIssues[0]}）` : ""),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIndexBusy(false);
      setIndexProgress(null);
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
          {indexStatus?.refresh && <div className="muted">{indexRefreshLabel(indexStatus)}</div>}
          <div className="outline-actions">
            <button type="button" disabled={indexBusy} onClick={() => void rebuildIndex()}>
              {indexBusy ? "重建中…" : "重建索引"}
            </button>
            <button
              type="button"
              disabled={indexBusy || !indexStatus?.exists}
              onClick={() => void rebuildIndex(true)}
              title="复用未变文件，只重新解析变更内容；索引损坏时自动全量自愈"
            >
              增量重建
            </button>
          </div>
          {/* 重建进度（T2-5 切片 B）：分片写入 / 段合并实时推进；重建结束自动收起 */}
          {indexBusy && (
            <div className="index-progress">
              <div className="index-progress-track">
                <div
                  className="index-progress-bar"
                  style={{ width: `${indexProgress ? indexProgressPercent(indexProgress) : 0}%` }}
                />
              </div>
              <span className="muted">
                {indexProgress ? indexProgressLabel(indexProgress) : "准备中…"}
                {indexProgress?.currentPath ? ` · ${indexProgress.currentPath}` : ""}
              </span>
            </div>
          )}
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
                    <span className="muted"> {cardTypeLabel(entity.type)} · {layerLabel(entity.layer)}</span>
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

        <div className="panel">
          <div className="panel-title">
            <span className="muted">本地快照（.yushu/snapshots）</span>
            <button type="button" className="link" onClick={() => void refreshSnapshots()}>
              刷新
            </button>
          </div>
          <div className="muted">
            {snapState
              ? `快照 ${snapState.snapshots.length} 份 · 内容寻址 blob ${snapState.blobCount} 个（${formatBytes(snapState.blobBytes)}）· 自动快照 60s 一份、环形保留 20`
              : "快照保护误删与误改：打开项目即建立基线，此后每 60s 自动一份"}
          </div>
          <div className="outline-actions">
            <button type="button" disabled={snapBusy} onClick={() => void takeSnapshot()}>
              {snapBusy ? "处理中…" : "立即快照"}
            </button>
          </div>
          <ul className="snapshots">
            {snapState?.snapshots.map((item) => (
              <li key={item.id}>
                <span className="muted">
                  {item.createdAt.replace("T", " ").slice(0, 19)} · {snapshotReasonLabel(item.reason)} · {item.files} 文件 ·{" "}
                  {formatBytes(item.bytes)}
                </span>
                <span className="spacer" />
                {restoreConfirmId === item.id ? (
                  <span className="snapshot-confirm">
                    <span className="muted">整体回滚到该快照？恢复前会自动快照当前状态</span>
                    <button type="button" disabled={snapBusy} onClick={() => void restoreSnapshot(item.id)}>
                      确认恢复
                    </button>
                    <button type="button" onClick={() => setRestoreConfirmId(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button type="button" disabled={snapBusy} onClick={() => setRestoreConfirmId(item.id)}>
                    恢复
                  </button>
                )}
              </li>
            ))}
            {snapState && snapState.snapshots.length === 0 && (
              <li className="muted">暂无快照（打开项目建立基线；每 60s 自动检查，内容变化才生成）</li>
            )}
          </ul>
          {snapStatus && <div className="muted">{snapStatus}</div>}
          <div className="muted">
            恢复 = 整体回滚到该快照：被删文件重建、被改文件写回；快照之后新增的文件保守保留（列出不删除），绝不静默丢内容
          </div>
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