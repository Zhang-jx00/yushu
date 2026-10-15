/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState } from "react";
import type { BiblePreviewPayload, BibleRunResult } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 设定集（世界圣经）面板（M5 / T5-5，R98）。
 *
 * 面板只做三件事：**选层 → 选脱敏 → 看清会写出什么**，编排规则全在主进程与引擎里，
 * 这里不重算一遍（两处各算一次，作者就会照一句假话核对——与 R94 的"核对行必须等于导出写出的那行"同一条规矩）。
 *
 * 三条展示口径都是"不许把安静说成干净"：
 * ① 被层级选取排除的卡、被脱敏剔除的条目、读不了的卡，**各报各的数**，不合并成一句"已导出 N 条"；
 * ② 未揭示却没脱敏的条目进产物时逐条点名（warn 不阻断，但要在屏幕上留着）；
 * ③ 预览的 markdown 可能截断，截断就明说"全文见落盘产物"，不假装这一屏就是全部。
 *
 * 零新增 CSS：复用 `.panel` / `.chips` / `.chip` / `.slot-table` / `.clip-preview` / `.checkbox`（契约 §7：先复用再新建）。
 */

export function BiblePanel() {
  const [preview, setPreview] = useState<BiblePreviewPayload | null>(null);
  /** 显式选层；空数组 = 用主进程给的默认（世界里开着的层） */
  const [layers, setLayers] = useState<string[]>([]);
  const [mask, setMask] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [result, setResult] = useState<BibleRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const state = await api().bible.preview({
        ...(layers.length === 0 ? {} : { layers }),
        maskUnrevealed: mask,
      });
      setPreview(state);
      setReviewed(false);
      setResult(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [layers, mask]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleLayer = (key: string) => {
    // 点第一下先把"默认选中的层"落到显式清单上，否则"取消一层"会变成"只选这一层"
    const base = layers.length > 0 ? layers : (preview?.layers ?? []).filter((row) => row.selected).map((row) => row.key);
    setLayers(base.includes(key) ? base.filter((item) => item !== key) : [...base, key]);
  };

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api().bible.run({
        confirmed: true,
        ...(layers.length === 0 ? {} : { layers }),
        maskUnrevealed: mask,
      });
      setResult(run);
      setReviewed(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const leaks = preview?.findings ?? [];
  const exportable =
    preview !== null && preview.error === null && preview.included > 0 && !busy;

  return (
    <section className="panel bible-panel">
      <h3>
        设定集（世界圣经） <span className="muted">T5-5：按层级编排 · 按可见性脱敏</span>
      </h3>
      <p className="muted">
        把项目里的设定卡汇编成一份可外发的设定集：目录按世界构建金字塔（起源 → 章节）排，
        每张卡成一节，正文原样收录。
      </p>

      <div className="chips" role="group" aria-label="编入设定集的层级">
        <button
          type="button"
          className={`chip${layers.length === 0 ? " on" : ""}`}
          disabled={busy}
          title="世界里开着的层都编入（关掉且没卡的层不占位）"
          onClick={() => setLayers([])}
        >
          默认（开着的层）
        </button>
        {(preview?.layers ?? []).map((row) => (
          <button
            type="button"
            key={row.key}
            className={`chip${row.selected ? " on" : ""}`}
            disabled={busy}
            title={`${row.key} · ${row.cards} 张卡 · ${row.enabled ? "世界已启用" : "世界已关闭（默认不编入，点一下可强制编入）"}`}
            onClick={() => toggleLayer(row.key)}
          >
            {row.title}
            {row.cards > 0 ? ` ${row.cards}` : ""}
          </button>
        ))}
      </div>

      <label className="checkbox bible-mask">
        <input type="checkbox" checked={mask} disabled={busy} onChange={(event) => setMask(event.target.checked)} />
        <span>按可见性脱敏（未揭示的设定整条不进产物，连条目名都不出）</span>
      </label>

      {preview === null && !busy && <p className="muted">正在读取设定卡…</p>}
      {preview !== null && (
        <>
          <div className="export-summary bible-summary">
            <div>
              《{preview.bookTitle || "（未命名世界）"}》·{" "}
              <span className="bible-title">{preview.title}</span> · {preview.sections.length} 层 /{" "}
              <span className="bible-included">{preview.included}</span> 条 · {preview.wordCount.toLocaleString("zh-CN")} 字
            </div>
            <div className="muted">
              项目共 {preview.cardTotal} 张卡；因层级选取排除 {preview.excludedByLayer} 张；
              {mask ? `脱敏略过 ${preview.masked.length} 条` : "未开脱敏"}；读不了 {preview.unreadable.length} 张
            </div>
          </div>

          {preview.error !== null && <p className="error-text">设定集没能编排出来：{preview.error}</p>}
          {preview.included === 0 && preview.error === null && (
            <p className="warn">
              当前选取下一条都编不进去（没有设定卡、或层级与脱敏把条目全滤掉了）——导出会拒绝落笔，
              项目里不会留空产物。
            </p>
          )}
          {preview.unreadable.length > 0 && (
            <table className="slot-table">
              <thead>
                <tr>
                  <th>读不了的卡</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.unreadable.map((row) => (
                  <tr key={row.path}>
                    <td>{row.path}</td>
                    <td className="warn">{row.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {leaks.length > 0 && (
            <table className="slot-table bible-leaks">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>规则</th>
                  <th>对象</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {leaks.map((row) => (
                  <tr key={`${row.rule}-${row.related}`}>
                    <td className="warn">警告</td>
                    <td>{row.rule}</td>
                    <td>{row.related}</td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.masked.length > 0 && (
            <table className="slot-table bible-masked">
              <thead>
                <tr>
                  <th>已脱敏（不进产物）</th>
                  <th>类型</th>
                  <th>可见性</th>
                </tr>
              </thead>
              <tbody>
                {preview.masked.map((entry) => (
                  <tr key={entry.path}>
                    <td>{entry.name}</td>
                    <td>{entry.type}</td>
                    <td className="muted">{entry.visibility}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.sections.length > 0 && (
            <table className="slot-table bible-toc">
              <thead>
                <tr>
                  <th>层级</th>
                  <th>条数</th>
                  <th>条目</th>
                </tr>
              </thead>
              <tbody>
                {preview.sections.map((section) => (
                  <tr key={section.layer}>
                    <td>{section.heading}</td>
                    <td>{section.entries.length}</td>
                    <td className="muted">
                      {section.entries
                        .slice(0, 5)
                        .map((entry) => entry.name)
                        .join("、")}
                      {section.entries.length > 5 ? `…（共 ${section.entries.length} 条）` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.markdown !== "" && (
            <pre className="clip-preview">
              {preview.markdown}
              {preview.truncated ? "\n…（预览截断，全文见落盘产物）" : ""}
            </pre>
          )}
        </>
      )}

      <label className="checkbox confirm-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={!exportable}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        <span>
          {preview === null
            ? "正在核对条目数与未揭示条数……核对完成前不能确认（防手滑：没看见数字就不许勾）"
            : "我已核对以上条目数、略过条数与未揭示条数（导出将写入项目 exports/ 目录）"}
        </span>
      </label>
      <div className="outline-actions">
        <button type="button" className="primary" disabled={!exportable || !reviewed} onClick={doExport}>
          导出设定集
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          重新读取
        </button>
      </div>

      {result && (
        <div className="muted bible-receipt">
          已导出设定集《{result.title}》→ {result.path}（{result.included} 条 · {result.wordCount.toLocaleString("zh-CN")} 字；
          脱敏{result.maskUnrevealed ? "开" : "关"}，略过 {result.maskedCount} 条；未揭示仍在产物{" "}
          {result.leakCount} 条；读不了 {result.unreadableCount} 张）
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
