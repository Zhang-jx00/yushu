import { useEffect, useState } from "react";
import type {
  ImportApplyResultPayload,
  ImportPickPayload,
  ImportPreviewPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 存量导入面板（M5 / T5-7，R77 第二段）：**只预演，不写盘**。
 *
 * 面板存在的意义是把三份报告摊在作者面前，让"导入"不是一个按下就完成的动作：
 * ① 编码是**猜的**（GB18030 兜底）就必须用横幅说"这是猜的，请抽查"——把猜的显示成确定的，
 *    等于用乱码覆盖别人的稿子；② 清洗删过的每一行都要有计数与样例，密钥剔除单独报；
 * ③ 章**没切开**就必须显示"整篇作为一章"，而不是安静地给一个 1。
 *
 * 这里**没有"确认入库"按钮**，也不是漏了——建卷建章与字数对账是下一轮（R78）的能力。
 * 面板也不显示文件路径：闸门票据是渲染层唯一的把手（`import-gate.ts`）。
 */

/** 表格里最多列出的章数：一部几百章的稿子不该一次全挂进 DOM */
const CHAPTER_ROWS = 40;

const bytesOf = (value: number): string => {
  if (value < 1024) return `${String(value)} B`;
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
};

export function ImportPanel() {
  const [picked, setPicked] = useState<ImportPickPayload | null>(null);
  const [view, setView] = useState<ImportPreviewPayload | null>(null);
  const [rules, setRules] = useState<{ id: string; pattern: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [volumeTitle, setVolumeTitle] = useState("");
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ImportApplyResultPayload | null>(null);

  useEffect(() => {
    if (picked === null) return;
    let alive = true;
    setBusy(true);
    api()
      .import.preview({ ticket: picked.ticket, ...(rules.length > 0 ? { rules } : {}) })
      .then((result) => {
        if (alive) {
          setView(result);
          setError("");
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
    // 规则数组每次渲染都是新对象，依赖收敛成序列化键
  }, [picked?.ticket ?? "", JSON.stringify(rules)]);

  const choose = async () => {
    try {
      setError("");
      const got = await api().import.pick();
      if (got === null) {
        // 取消：清掉上一次的条件与报告（票据已作废，留着报告会让人以为还能入库）
        setPicked(null);
        setView(null);
        setConfirmSingle(false);
        return;
      }
      setConfirmSingle(false);
      setResult(null);
      setPicked(got);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 入库：载荷里**没有正文**，只有票据与"用哪几条规则"——主进程凭同一张票重新算一遍，
   * 所以界面这边改不了要写进去的内容。baseHash 取自预演回报，挡"看报告这几秒有人改了大纲"。
   */
  const apply = async () => {
    if (picked === null || view === null) return;
    try {
      setError("");
      setApplying(true);
      const done = await api().import.apply({
        ticket: picked.ticket,
        ...(rules.length > 0 ? { rules } : {}),
        ...(volumeTitle.trim() !== "" ? { volumeTitle: volumeTitle.trim() } : {}),
        ...(view.split.hardSplit ? {} : { confirmSingleChapter: true }),
        ...(view.outlineHash === null ? {} : { baseHash: view.outlineHash }),
      });
      setResult(done);
      setPicked(null);
      setView(null);
      setConfirmSingle(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const needsConfirm = view !== null && !view.split.hardSplit;
  const canApply = view !== null && !busy && !applying && (!needsConfirm || confirmSingle);

  const addRule = () => {
    const pattern = draft.trim();
    if (pattern === "") return;
    setRules((current) => [...current, { id: `custom-${String(current.length + 1)}`, pattern }]);
    setDraft("");
  };

  return (
    <section className="panel import-panel">
      <div className="panel-title">导入存量稿件（先出三份报告，确认后才建卷建章）</div>

      <div className="import-actions">
        <button type="button" className="primary" onClick={() => void choose()} disabled={busy}>
          选择文件…
        </button>
        {picked !== null && (
          <span className="muted import-file">
            {picked.name} · {bytesOf(picked.bytes)} · 凭票预演（票据 10 分钟内有效，过期请重选）
          </span>
        )}
        {picked === null && (
          <span className="muted">路径不进渲染层：选中的文件由主进程登记成一张票据，这里只显示文件名。</span>
        )}
      </div>

      {error !== "" && <div className="error-text">{error}</div>}

      {picked !== null && view === null && error === "" && <div className="muted">正在读字节并算报告…</div>}

      {view !== null && (
        <>
          <div className={`import-probe ${view.encoding.assumed ? "warn" : ""}`}>
            <div className="import-probe-head">
              编码探测：
              <strong>{view.encoding.encoding}</strong>
              {view.encoding.bom !== null && <span className="import-tag">BOM {view.encoding.bom}</span>}
              {view.encoding.assumed && <span className="import-tag danger">这是猜的</span>}
              {!view.encoding.ok && <span className="import-tag danger">没判出来</span>}
            </div>
            <div className="muted">{view.encoding.note}</div>
          </div>

          <div className="import-block">
            <div className="import-block-title">清洗报告（删掉的每一行都留了计数与样例）</div>
            <div className="import-counts">
              <span>行尾归一 {String(view.clean.lineEndingNormalized)} 处</span>
              <span>多余空行折叠 {String(view.clean.blankLinesCollapsed)} 处</span>
              <span>规则删行 {String(view.clean.removed.reduce((acc, item) => acc + item.count, 0))} 行</span>
              <span>疑似密钥剔除 {String(view.clean.redacted.reduce((acc, item) => acc + item.count, 0))} 处</span>
            </div>
            {view.clean.removed.length > 0 && (
              <table className="slot-table import-table">
                <thead>
                  <tr>
                    <th>规则</th>
                    <th>删了几行</th>
                    <th>留个样例</th>
                  </tr>
                </thead>
                <tbody>
                  {view.clean.removed.map((item) => (
                    <tr key={item.rule}>
                      <td>{item.rule}</td>
                      <td className="import-num">{String(item.count)}</td>
                      <td className="muted">{item.sample === "" ? "（空行）" : item.sample}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view.clean.redacted.length > 0 && (
              <div className="import-redacted">
                {view.clean.redacted.map((item) => (
                  <div key={item.kind} className="import-warn">
                    就地替换了 {String(item.count)} 处「{item.kind}」——原文里不会再有这串字符
                  </div>
                ))}
              </div>
            )}
            <div className="import-rules muted">
              生效规则：
              {view.rules.map((rule) => (
                <span key={rule.id} className={`import-tag ${rule.source === "custom" ? "custom" : ""}`}>
                  {rule.id}
                  {rule.source === "custom" ? "（自定义）" : ""}
                </span>
              ))}
            </div>
            <div className="import-rule-editor">
              <input
                type="text"
                className="import-rule-input"
                placeholder="追加一条删行正则（如 ^【广告】）"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addRule();
                }}
              />
              <button type="button" onClick={addRule} disabled={draft.trim() === ""}>
                追加
              </button>
              {rules.length > 0 && (
                <button type="button" onClick={() => setRules([])}>
                  清空自定义（{String(rules.length)}）
                </button>
              )}
            </div>
            {error === "" && rules.length > 0 && (
              <div className="muted import-rule-note">自定义正则是读不懂就报错、不会静默跳过；写坏了会显示在上面的错误里。</div>
            )}
          </div>

          <div className="import-block">
            <div className="import-block-title">
              分章预演：{String(view.split.chapterCount)} 章 · 共 {String(view.totalChars)} 字
              <span className="muted">（与编辑器同一个字数口径）</span>
            </div>
            {!view.split.hardSplit && view.split.note !== null && (
              <div className="import-warn import-note">{view.split.note}</div>
            )}
            {view.split.volumeHints.length > 0 && (
              <div className="muted import-volumes">
                卷标题（不当成章）：{view.split.volumeHints.join(" / ")}
              </div>
            )}
            {view.split.hasPreamble && (
              <div className="muted import-volumes">
                首章之前另有 {String(view.split.preambleChars)} 字（楔子 / 简介）：入库时单独安置，不并进第一章
              </div>
            )}
            {view.chapters.length > 0 && (
              <table className="slot-table import-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>标题</th>
                    <th>字数</th>
                    <th>摘录</th>
                  </tr>
                </thead>
                <tbody>
                  {view.chapters.slice(0, CHAPTER_ROWS).map((chapter) => (
                    <tr key={chapter.index}>
                      <td className="import-num">{String(chapter.index + 1)}</td>
                      <td>{chapter.title === "" ? "（无标题）" : chapter.title}</td>
                      <td className="import-num">{String(chapter.chars)}</td>
                      <td className="muted">{chapter.excerpt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view.chapters.length > CHAPTER_ROWS && (
              <div className="muted import-more">
                另有 {String(view.chapters.length - CHAPTER_ROWS)} 章未列出（预演只给摘录，正文不穿过 IPC）
              </div>
            )}
          </div>

          <div className="import-block import-apply-block">
            <div className="import-block-title">确认入库</div>
            <div className="import-apply-row">
              <input
                type="text"
                className="import-volume-input"
                placeholder={`卷名（留空 = 导入·${view.name.replace(/\.[^.]+$/, "")}）`}
                value={volumeTitle}
                onChange={(event) => setVolumeTitle(event.target.value)}
              />
              {needsConfirm && (
                <label className="import-confirm">
                  <input
                    type="checkbox"
                    className="import-confirm-box"
                    checked={confirmSingle}
                    onChange={(event) => setConfirmSingle(event.target.checked)}
                  />
                  整篇作为一章入库（没认出章节标题，我不指望工具替我切）
                </label>
              )}
              <button type="button" className="primary import-apply-btn" disabled={!canApply} onClick={() => void apply()}>
                {applying ? "正在建卷建章…" : "确认入库"}
              </button>
            </div>
            <div className="muted import-rule-note">
              入库写的是真源：新建一卷 + 每章一条章纲 + 每章一个草稿文件，写之前强制留一份可撤销的快照。
              章纲的细项（谁 / 何地 / 目标 / 障碍 / 转折 / 结果 / 钩子）一律留空——那是作者的创作决策，工具不替猜。
            </div>
          </div>

          <div className="import-boundary">
            导入这条线还没做完的部分：AI 二次筛选切章、误切校正、实体抽取候选、可中断续跑
            （对账已经做了，逐章比对预演字数与落盘字数）。
          </div>
        </>
      )}

      {result !== null && (
        <div className="import-result">
          <div className="import-block-title">
            已入库：{result.volumeTitle}（{String(result.created.length)} 章 · {String(result.totalWrittenWords)} 字）
          </div>
          <div className="muted">{result.note}</div>
          {result.mismatched.length > 0 && (
            <ul className="import-mismatched">
              {result.mismatched.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ul>
          )}
          {result.preamble !== null && (
            <div className="import-warn">
              首章之前还有 {String(result.preamble.chars)} 字未入库（源文件没动，请自己决定挪去哪儿）：
              {result.preamble.excerpt}
            </div>
          )}
          <div className="muted import-result-foot">
            撤销窗口：{result.snapshotId ?? "（无快照 id）"}；要回退到入库前，去「项目文件 → 本地快照」整体回退。
            票据已作废——同一张票不能把同一部稿子导两遍。
          </div>
        </div>
      )}
    </section>
  );
}
