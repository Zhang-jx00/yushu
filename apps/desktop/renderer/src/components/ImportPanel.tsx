import { useEffect, useState } from "react";
import type { ImportPickPayload, ImportPreviewPayload } from "../../../src/shared/ipc";
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
      const result = await api().import.pick();
      if (result === null) {
        setPicked(null);
        setView(null);
        return;
      }
      setPicked(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addRule = () => {
    const pattern = draft.trim();
    if (pattern === "") return;
    setRules((current) => [...current, { id: `custom-${String(current.length + 1)}`, pattern }]);
    setDraft("");
  };

  return (
    <section className="panel import-panel">
      <div className="panel-title">导入存量稿件（只预演 · 编码 / 清洗 / 分章三份报告，不写盘）</div>

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

          <div className="import-boundary">
            这一版只到「看清报告」为止：建卷建章、逐章字数对账与冲突检测在下一轮，所以这里没有「确认入库」按钮。
          </div>
        </>
      )}
    </section>
  );
}
