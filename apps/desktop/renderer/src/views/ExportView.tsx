import { useCallback, useEffect, useState } from "react";
import type { ClipboardResult, ExportPreviewPayload, ExportRunResult } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 导出与敏感词自查（S6；T1-18 ~ T1-20）：
 * - 字数对账（frontmatter 记录 vs 正文实际）+ 敏感词命中（定位 + 替换建议）；
 * - 防手滑：必须先核对摘要并勾选确认，服务端再次校验 confirmed；
 * - 干净剪贴板：去注释（默认）/ 去 AI 标识（可选），写入系统剪贴板。
 */

const SEVERITY_LABEL: Record<string, string> = { error: "错误", warn: "警告", info: "提示" };

export function ExportView() {
  const [preview, setPreview] = useState<ExportPreviewPayload | null>(null);
  const [includeToc, setIncludeToc] = useState(true);
  const [stripMarkers, setStripMarkers] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [exported, setExported] = useState<ExportRunResult | null>(null);
  const [stripComments, setStripComments] = useState(true);
  const [stripAiMarks, setStripAiMarks] = useState(false);
  const [clipResult, setClipResult] = useState<ClipboardResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const state = await api().export.preview();
      setPreview(state);
      setReviewed(false);
      setExported(null);
      if (state.chapters === 0) {
        setNotice("暂无可导出的正文：请先在「三级大纲」创建草稿章节，并通过 AI 副驾或编辑器写入正文。");
      } else {
        setNotice(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().export.run({ confirmed: true, includeToc, stripMarkers });
      setExported(result);
      setNotice(
        `已导出 → ${result.path}（${result.chapters} 章 · ${result.words} 字）${
          result.clean ? "；无 error 级敏感词命中" : "；⚠ 仍有 error 级命中，建议处理后再投稿"
        }`,
      );
      setReviewed(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doClipboard = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().export.clipboard({ stripComments, stripAiMarks });
      setClipResult(result);
      setNotice(`干净正文已写入系统剪贴板（${result.chapters} 章 · ${result.words} 字）`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errorHits = preview?.bySeverity.error ?? 0;

  return (
    <div className="export">
      <aside>
        <section className="panel">
          <h3>
            导出 TXT <span className="muted">T1-18</span>
          </h3>
          {preview && (
            <div className="export-summary">
              <div>
                《{preview.bookTitle}》· {preview.volumes} 卷 / {preview.chapters} 章 · {preview.totalWords} 字
              </div>
              {preview.missingDrafts > 0 && (
                <div className="warn">
                  还有 {preview.missingDrafts} 个章纲尚未创建草稿章节，不会出现在导出中。
                </div>
              )}
              {errorHits > 0 && (
                <div className="error-text">存在 {errorHits} 条 error 级敏感词命中，建议处理后再投稿。</div>
              )}
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={includeToc} onChange={(event) => setIncludeToc(event.target.checked)} />
            <span>包含目录页</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={stripMarkers}
              onChange={(event) => setStripMarkers(event.target.checked)}
            />
            <span>去除内部标记（HTML/Markdown 注释）</span>
          </label>
          <label className="checkbox confirm-check">
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
            <span>
              我已核对以上章数、字数与敏感词命中（防手滑：导出将写入项目 <code>exports/</code> 目录）
            </span>
          </label>
          <div className="outline-actions">
            <button type="button" className="primary" disabled={busy || !reviewed || !preview?.chapters} onClick={doExport}>
              确认导出 TXT
            </button>
            <button type="button" disabled={busy} onClick={refresh}>
              重新核对
            </button>
          </div>
          {exported && <div className="muted">最近导出：{exported.path}</div>}
        </section>

        <section className="panel">
          <h3>
            干净剪贴板 <span className="muted">T1-20</span>
          </h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={stripComments}
              onChange={(event) => setStripComments(event.target.checked)}
            />
            <span>去除注释（内部备注不粘贴到平台后台）</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={stripAiMarks}
              onChange={(event) => setStripAiMarks(event.target.checked)}
            />
            <span>去除 AI 标识（如「（AI 生成）」，按平台政策酌情使用）</span>
          </label>
          <div className="outline-actions">
            <button type="button" disabled={busy || !preview?.chapters} onClick={doClipboard}>
              复制干净正文
            </button>
          </div>
          {clipResult && (
            <>
              <div className="muted">
                已复制 {clipResult.chapters} 章 · {clipResult.words} 字 → {clipResult.target}
              </div>
              <pre className="clip-preview">{clipResult.preview}…</pre>
            </>
          )}
        </section>

        <section className="panel">
          <h3>
            敏感词词库 <span className="muted">外置可更新</span>
          </h3>
          {preview?.wordlists.map((wordlist) => (
            <div className="provider" key={`${wordlist.id}@${wordlist.version}`}>
              <div className="pack-title">
                <strong>{wordlist.id}</strong>
                <span className="muted">v{wordlist.version}</span>
              </div>
              <div className="muted">
                {wordlist.source ?? "（未标注来源）"} · 生效词条 {wordlist.entries}
              </div>
            </div>
          ))}
          <div className="muted">
            扫描目录：{preview?.wordlistDirs.join(" ｜ ")}；合并后共 {preview?.wordEntryCount ?? 0} 条（同词后者覆盖）。
          </div>
          {(preview?.skippedWordlists.length ?? 0) > 0 && (
            <ul className="issues">
              {preview?.skippedWordlists.map((item) => (
                <li key={item.path} className="error-text">
                  词库未加载：{item.path}（{item.error}）
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <section>
        <div className="panel">
          <h3>
            字数对账 <span className="muted">frontmatter 记录 vs 正文实际（去空白字符数）</span>
          </h3>
          {preview && preview.reconcile.length === 0 && <p className="muted">暂无章节可对账。</p>}
          {preview && preview.reconcile.length > 0 && (
            <table className="slot-table">
              <thead>
                <tr>
                  <th>卷 / 章</th>
                  <th>记录</th>
                  <th>实际</th>
                  <th>对账</th>
                </tr>
              </thead>
              <tbody>
                {preview.reconcile.map((row) => (
                  <tr key={row.chapterId}>
                    <td>
                      {row.volumeTitle} · {row.title}
                    </td>
                    <td>{row.stated}</td>
                    <td>{row.actual}</td>
                    <td className={row.matched ? "" : "error-text"}>{row.matched ? "✓ 一致" : "✗ 失配"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview && preview.reconcile.length > 0 && (
            <div className="muted">
              合计 {preview.totalWords} 字；一致 {preview.reconcile.filter((row) => row.matched).length} /{" "}
              {preview.reconcile.length} 章
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <h3>
              敏感词自查 <span className="muted">T1-19：命中定位 + 替换建议</span>
            </h3>
            <span className="muted">
              {preview ? `命中 ${preview.hitTotal} 处（错误 ${preview.bySeverity.error} / 警告 ${preview.bySeverity.warn} / 提示 ${preview.bySeverity.info}）` : ""}
            </span>
          </div>
          {preview && preview.hitTotal === 0 && <p className="muted">未命中任何词条：词库与正文均干净。</p>}
          {preview && preview.hitTotal > 0 && (
            <table className="slot-table">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>词条</th>
                  <th>位置</th>
                  <th>上下文</th>
                  <th>替换建议</th>
                </tr>
              </thead>
              <tbody>
                {preview.hits.map((hit) => (
                  <tr key={`${hit.chapterId}-${hit.index}-${hit.word}`}>
                    <td className={hit.severity === "error" ? "error-text" : hit.severity === "warn" ? "warn" : "muted"}>
                      {SEVERITY_LABEL[hit.severity] ?? hit.severity}
                    </td>
                    <td>{hit.word}</td>
                    <td className="muted">
                      {hit.chapterTitle} · 第 {hit.index + 1} 字符
                    </td>
                    <td className="muted">{hit.context}</td>
                    <td>{hit.suggestion ?? "（无建议）"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview && preview.hitTotal > preview.hits.length && (
            <div className="muted">仅显示前 {preview.hits.length} 条命中（全量计数见上方）。</div>
          )}
        </div>

        {notice && <div className="muted">{notice}</div>}
        {error && <div className="error-bar">{error}</div>}
      </section>
    </div>
  );
}