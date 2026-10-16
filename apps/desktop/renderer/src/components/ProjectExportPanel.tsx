/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState } from "react";
import type { ProjectExportPreviewPayload, ProjectExportRunResult } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 项目迁移包面板（M3 / T3-14 后半，R101）。
 *
 * 这一层的立场是"把会少带、会被剥掉的东西先说清，再让你点确认"：
 * ① 派生目录 `.yushu/`（索引库 + **密文库**）整棵不进包，跳过的每条都给理由——静默少文件与静默多文件一样坏；
 * ② 配置里若有疑似明文密钥，预览就报"要剥几条"，不是写完才发现；
 * ③ 目标目录只回**票据与目录名**，绝对路径不进渲染层（与 `chooseDirectory` 那条故意不同）；
 * ④ 落盘后主进程还会复扫一遍字节，仍检出明文就整包删除——回执里的"复扫 N 条"就是那条判据的脸。
 *
 * 零新增 CSS：复用 `.panel` / `.slot-table` / `.checkbox` / `.outline-actions` / `.clip-preview`（契约 §7）。
 */

function kilo(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function ProjectExportPanel() {
  const [preview, setPreview] = useState<ProjectExportPreviewPayload | null>(null);
  const [includeExports, setIncludeExports] = useState(false);
  const [target, setTarget] = useState<{ name: string; ticket: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [result, setResult] = useState<ProjectExportRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      setPreview(await api().project.exportPreview({ includeExports }));
      setReviewed(false);
      setResult(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [includeExports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api().project.exportPick();
      if (picked.canceled || picked.ticket === undefined) {
        setTarget(null);
        setReviewed(false);
      } else {
        setTarget({ name: picked.name, ticket: picked.ticket });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api().project.exportRun({ ticket: target.ticket, confirmed: true, includeExports }));
      setReviewed(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const redactedTotal = (preview?.redactions ?? []).reduce((sum, row) => sum + row.count, 0);
  const ready = preview !== null && target !== null && !busy;

  return (
    <section className="panel project-export-panel">
      <h3>
        项目迁移包 <span className="muted">T3-14：可交给别人的那份，不带密钥</span>
      </h3>
      <p className="muted">
        把项目的 Markdown / YAML 真源打成一个目录（不压缩、可用任何编辑器打开）。
        索引库、快照与<b>密文库</b>都在 <code>.yushu/</code> 里，整棵不进包；接收方在自己机器上重建索引、重新录入自己的 API Key。
      </p>

      {preview === null && !busy && <p className="muted">正在清点项目文件…</p>}
      {preview !== null && (
        <>
          <div className="export-summary">
            <div>
              《{preview.bookTitle || "（未命名世界）"}》· {preview.files.length} 个真源文件 · {kilo(preview.totalBytes)}
            </div>
            <div className="muted">
              跳过派生 / 旁路 {preview.excluded.length} 个；读不出内容 {preview.unreadable.length} 个；
              {redactedTotal > 0 ? `将剥离 ${redactedTotal} 处疑似明文密钥` : "配置里没有明文密钥可剥"}
            </div>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeExports}
              disabled={busy}
              onChange={(event) => setIncludeExports(event.target.checked)}
            />
            <span>把 exports/ 里已有的导出物也装进包（默认不装：那本来就是可从真源重出的派生物）</span>
          </label>

          {(preview.redactions.length > 0 || preview.unreadable.length > 0) && (
            <table className="slot-table">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>会怎么处理</th>
                </tr>
              </thead>
              <tbody>
                {preview.redactions.map((row) => (
                  <tr key={row.path}>
                    <td>{row.path}</td>
                    <td className="warn">写出前剥离 {row.count} 处明文密钥（结构保留，值变注释）</td>
                  </tr>
                ))}
                {preview.unreadable.map((row) => (
                  <tr key={row.path}>
                    <td>{row.path}</td>
                    <td className="muted">不进包：{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted">{preview.note}</p>

          <details className="project-export-excluded">
            <summary>跳过了哪些文件、为什么（{preview.excluded.length} 条）</summary>
            <table className="slot-table">
              <tbody>
                {preview.excluded.map((row) => (
                  <tr key={row.path}>
                    <td>{row.path}</td>
                    <td className="muted">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <div className="outline-actions">
        <button type="button" disabled={busy} onClick={() => void pick()}>
          {target === null ? "选择导出位置" : `已选：${target.name}（换目录）`}
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          重新清点
        </button>
      </div>

      <label className="checkbox confirm-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={!ready}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        <span>
          {preview === null
            ? "正在清点……没看见文件数与剥离条数就不许确认（防手滑）"
            : target === null
              ? "还没选导出位置——没地方可写就不许确认"
              : "我已核对文件数、被剥掉的密钥条数与被跳过的派生文件（将在所选目录里新建一个子目录，不覆盖已有内容）"}
        </span>
      </label>
      <div className="outline-actions">
        <button type="button" className="primary" disabled={!ready || !reviewed} onClick={() => void run()}>
          导出迁移包
        </button>
      </div>

      {result && (
        <div className="muted project-export-receipt">
          已导出 → {result.subdir}/（{result.files} 个文件 · {kilo(result.bytes)}；剥离明文密钥 {result.redacted} 处；
          落盘后复扫命中 {result.plaintextRemaining} 条；跳过派生 {result.skippedDerived} 个；读不出 {result.unreadableSkipped} 个）
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
