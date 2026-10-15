/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState } from "react";
import type { ClipboardResult, ExportPreviewPayload, ExportRunResult } from "../../../src/shared/ipc";
import { BiblePanel } from "../components/BiblePanel";
import { api } from "../api";

/**
 * 导出与敏感词自查（S6；T1-18 ~ T1-20）：
 * - 字数对账（frontmatter 记录 vs 正文实际）+ 敏感词命中（定位 + 替换建议）；
 * - 防手滑：必须先核对摘要并勾选确认，服务端再次校验 confirmed；
 * - 干净剪贴板：去注释（默认）/ 去 AI 标识（可选），写入系统剪贴板。
 */

const SEVERITY_LABEL: Record<string, string> = { error: "错误", warn: "警告", info: "提示" };

/** 导出格式（与 `ExportRunPayload.format` 同一套字面量；顺序与能力矩阵一致） */
const EXPORT_FORMATS = ["txt", "epub", "docx", "pdf"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 门禁结论怎么说：没跑过就是"未校验"，不许写成"通过" */
function gateLine(result: { gate?: { ran: boolean; passed: boolean; reason: string } } | null): string {
  if (!result?.gate) return "";
  const gate = result.gate;
  if (!gate.ran) return `；EPUB 质检：${gate.reason}`;
  return gate.passed ? "；EPUB 质检通过" : `；EPUB 质检未通过：${gate.reason}`;
}

/** 按平台格式导出时回执要说清用了哪个包、哪条模板，以及有多少标题的前缀被换掉（R94） */
function platformLine(result: {
  platform?: { id: string; chapterTitleFormat: string; warnings: number; strippedPrefixes: number };
} | null): string {
  if (!result?.platform) return "";
  const info = result.platform;
  return `；平台格式 ${info.id}：${info.chapterTitleFormat}（警告 ${info.warnings} 条${
    info.strippedPrefixes > 0 ? `，${info.strippedPrefixes} 章自带前缀已让位给模板` : ""
  }）`;
}

export function ExportView() {
  const [preview, setPreview] = useState<ExportPreviewPayload | null>(null);
  const [format, setFormat] = useState<ExportFormat>("txt");
  /** 平台包 id（R94）；"" = 不按任何平台格式 */
  const [platform, setPlatform] = useState("");
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

  const refresh = useCallback(async (forceTooling = false) => {
    setBusy(true);
    try {
      setError(null);
      const state = await api().export.preview({
        refresh: forceTooling,
        platform: platform === "" ? undefined : platform,
      });
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
    } finally {
      setBusy(false);
    }
    // platform 进依赖：换一个平台就该重新核对一次（预览里的格式行与样例随之变）
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().export.run({
        confirmed: true,
        format,
        includeToc,
        stripMarkers,
        platform: platform === "" ? undefined : platform,
      });
      setExported(result);
      setNotice(
        `已导出 ${result.format.toUpperCase()} → ${result.path}（${result.chapters} 章 · ${result.words} 字）${
          result.clean ? "；无 error 级敏感词命中" : "；⚠ 仍有 error 级命中，建议处理后再投稿"
        }${gateLine(result)}${platformLine(result)}${result.sourcePath ? `；源文件 ${result.sourcePath}` : ""}`,
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
  // TXT 永远可出（御书自己装配）；其余以现场探测的结论为准
  const selectedUnavailable =
    format !== "txt" && preview?.capabilities.find((entry) => entry.format === format)?.available !== true;

  return (
    <div className="export">
      <aside>
        <section className="panel">
          <h3>
            导出 <span className="muted">T1-18 / T5-4</span>
          </h3>
          {/* 格式选择：不可用的格式直接 disabled，理由就写在下面一行——点不动要有原因，不许静默 */}
          <div className="chips export-formats" role="group" aria-label="导出格式">
            {EXPORT_FORMATS.map((item) => {
              const cap = preview?.capabilities.find((entry) => entry.format === item);
              const available = item === "txt" ? true : cap?.available === true;
              return (
                <button
                  type="button"
                  key={item}
                  className={`chip${format === item ? " on" : ""}`}
                  disabled={!available || busy || preview === null}
                  title={cap?.reason ?? "正在探测本机工具链…"}
                  onClick={() => setFormat(item)}
                >
                  {item.toUpperCase()}
                </button>
              );
            })}
          </div>
          <p className="muted export-format-reason">
            {preview === null
              ? "正在核对章数、字数与本机工具链…"
              : (preview.capabilities.find((entry) => entry.format === format)?.reason ?? "")}
          </p>
          {/* 平台格式（R94 / K11）：清单来自 packs/platforms/，代码里没有一个平台名；没有包就整区不出现 */}
          {preview !== null && preview.platforms.length > 0 && (
            <div className="chips export-platforms" role="group" aria-label="平台章节格式">
              <button
                type="button"
                className={`chip${platform === "" ? " on" : ""}`}
                disabled={busy}
                title="章头照作者写的样子导出"
                onClick={() => setPlatform("")}
              >
                不按平台
              </button>
              {preview.platforms.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`chip${platform === item.id ? " on" : ""}`}
                  disabled={busy || item.parseError !== null}
                  title={
                    item.parseError !== null
                      ? `包不合规：${item.parseError}`
                      : `${item.platform} v${item.version} · 生效 ${item.effectiveDate} · 核对 ${item.checkedAt}`
                  }
                  onClick={() => setPlatform(item.id)}
                >
                  {item.id}
                </button>
              ))}
            </div>
          )}
          {preview !== null && preview.platforms.length === 0 && (
            <p className="muted export-platforms-empty">
              本机没有任何平台导出包（packs/platforms/ 为空），章头将照作者原文写。
            </p>
          )}
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
            <input
              type="checkbox"
              checked={reviewed}
              disabled={preview === null || busy}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              {preview === null
                ? "正在核对章数、字数与敏感词命中……核对完成前不能确认（防手滑：没看见数字就不许勾）"
                : "我已核对以上章数、字数与敏感词命中（防手滑：导出将写入项目 exports/ 目录）"}
            </span>
          </label>
          <div className="outline-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !reviewed || !preview?.chapters || selectedUnavailable}
              onClick={doExport}
            >
              确认导出 {format.toUpperCase()}
            </button>
            {/* 必须显式传 true：直接把 refresh 当 handler 会把 click 事件当成 forceTooling */}
            <button type="button" disabled={busy} onClick={() => refresh(true)}>
              重新核对
            </button>
          </div>
          {exported && (
            <div className="muted">
              最近导出（{exported.format.toUpperCase()}）：{exported.path}
            </div>
          )}
        </section>

        {/* 平台格式核对（R94）：包从哪儿来、套上后每章的章头长什么样、哪里不对 */}
        {preview !== null && (preview.platform !== null || preview.platformNote !== null) && (
          <section className="panel export-platform-panel">
            <h3>
              平台章节格式 <span className="muted">K11：参数从包读，不硬编码</span>
            </h3>
            {preview.platformNote !== null && (
              <p className="warn">未给出核对结果：{preview.platformNote}</p>
            )}
            {preview.platform !== null && (
              <>
                <p className="muted">
                  {preview.platform.pack.id} · v{preview.platform.pack.version} · 生效{" "}
                  {preview.platform.pack.effectiveDate} · 核对于 {preview.platform.pack.checkedAt} · 模板{" "}
                  {preview.platform.pack.chapterTitleFormat} · 编码 {preview.platform.pack.encoding} · 来源{" "}
                  {preview.platform.pack.sourceUrls.length} 条 · 已核对 {preview.platform.checkedChapters} 章
                </p>
                {preview.platform.pack.validWordRule !== "" && (
                  <p className="muted">字数口径（照包转述，不判超没超）：{preview.platform.pack.validWordRule}</p>
                )}
                {preview.platform.pack.submissionMaterials.length > 0 && (
                  <p className="muted">
                    投稿材料清单（由包列出；是否齐备请作者自己确认，御书没有可核对的项目内约定）：
                    {preview.platform.pack.submissionMaterials.join("、")}
                  </p>
                )}
                {preview.platform.strippedPrefixes > 0 && (
                  <p className="warn">
                    {preview.platform.strippedPrefixes} 章的标题自带"第N章"前缀：导出副本里会让位给平台模板的编号（
                    <b>真源一个字不动</b>），建议把标题写成裸名。
                  </p>
                )}
                <table className="slot-table export-platform-samples">
                  <thead>
                    <tr>
                      <th>章节</th>
                      <th>你写的标题</th>
                      <th>导出会写出的章头</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.platform.titles.map((sample) => (
                      <tr key={sample.chapterId}>
                        <td>{sample.chapterId}</td>
                        <td>{sample.title}</td>
                        <td>{sample.head}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.platform.rows.length === 0 ? (
                  <p className="muted">格式核对：没有问题。</p>
                ) : (
                  <table className="slot-table export-platform-rows">
                    <thead>
                      <tr>
                        <th>级别</th>
                        <th>规则</th>
                        <th>对象</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.platform.rows.map((row) => (
                        <tr key={`${row.rule}-${row.subject}`}>
                          <td>{SEVERITY_LABEL[row.severity] ?? row.severity}</td>
                          <td>{row.rule}</td>
                          <td>{row.subject}</td>
                          <td>{row.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>
        )}

        {/* 设定集（世界圣经）：R98 / T5-5，与章节导出同页不同事，各自确认、各自落盘 */}
        <BiblePanel />

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

        <section className="panel export-capabilities">
          <h3>
            导出格式能力 <span className="muted">T5-4：按本机实测，不按猜测</span>
          </h3>
          {preview === null ? (
            <p className="muted">正在探测本机工具链…</p>
          ) : preview.capabilities.length === 0 ? (
            <p className="warn">{preview.capabilitiesNote ?? "本轮未探测到本机工具链，暂不给结论。"}</p>
          ) : (
            <table className="slot-table">
              <thead>
                <tr>
                  <th>格式</th>
                  <th>本机可否产出</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody>
                {preview.capabilities.map((capability) => (
                  <tr key={capability.format}>
                    <td>{capability.format.toUpperCase()}</td>
                    <td className={capability.available ? "" : "warn"}>
                      {capability.available ? "可产出" : "暂不可"}
                    </td>
                    <td className="muted">{capability.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">
            探测只做只读命令（<code>--version</code> / <code>--list-output-formats</code> / 查可执行文件是否存在），
            不写入任何文件；缺少引擎时这里会说清缺什么，而不是等导出失败才发现。
            装好引擎或备好 EPUBCheck jar 之后，点一次「重新核对」就会重问本机，不必重启应用。
          </p>
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