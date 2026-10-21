/* SPDX-License-Identifier: Apache-2.0 */
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
  /** AI 筛选 / 人工校正（R107）：两者都只改计划，界面上的"分章预演"随之换新 */
  const [aiBusy, setAiBusy] = useState(false);
  const [notice, setNotice] = useState("");

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

  /**
   * 取消这次导入（R108，I09 §2.7 的"可中断"那半边）。
   *
   * 两种情形一句话说清：
   * ① **还没入库** ⇒ 放弃这次导入（票据作废，选中的文件不会再被读到）；
   * ② **正在入库** ⇒ 请求在**章的边界**上停下（半章写进去是半个章），
   *    断点落盘，剩下的可以续跑。
   */
  const cancel = async () => {
    if (picked === null) return;
    try {
      setError("");
      const done = await api().import.cancel({ ticket: picked.ticket });
      setNotice(done.note);
      // 放弃（没在入库）⇒ 回到初始态；只是"请求停下"⇒ 面板留着，等入库那边回执
      if (!done.stopped) {
        setPicked(null);
        setView(null);
        setConfirmSingle(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 续跑：带上任务 id 入库（主进程会核对源文件指纹与切分，核不过就拒） */
  const applyAsResume = async () => {
    if (picked === null || view === null || view.resume === null) return;
    try {
      setError("");
      setApplying(true);
      const done = await api().import.apply({
        ticket: picked.ticket,
        jobId: view.resume.job_id,
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

  /**
   * AI 二次筛选切分（R107）：只改计划，不写盘。
   *
   * 回执原话直接显示——**回退到正则切分时必须让作者看见**，
   * 不静默换一个算法（"看起来筛过了"与"其实没筛"差着一整个章节边界）。
   */
  const runAiSplit = async () => {
    if (picked === null) return;
    try {
      setError("");
      setAiBusy(true);
      // 规则要一起带过去：清洗会删行，候选行号随规则变（少了这一步，AI 认的行会指错文字）
      const result = await api().import.aiSplit({
        ticket: picked.ticket,
        ...(rules.length > 0 ? { rules } : {}),
      });
      setView(result.preview);
      setNotice(result.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  /** 人工校正（合并 / 拆分 / 重排）：同样只改计划 */
  const correct = async (
    correction:
      | { kind: "merge"; at: number }
      | { kind: "split"; candidateIndex: number }
      | { kind: "move"; from: number; to: number },
  ) => {
    if (picked === null) return;
    try {
      setError("");
      setAiBusy(true);
      const result = await api().import.correct({
        ticket: picked.ticket,
        correction,
        ...(rules.length > 0 ? { rules } : {}),
      });
      setView(result.preview);
      setNotice(result.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
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
        {picked !== null && (
          <button type="button" onClick={() => void cancel()} disabled={busy}>
            取消导入
          </button>
        )}
      </div>

      {error !== "" && <div className="error-text">{error}</div>}
      {notice !== "" && <div className="muted import-note">{notice}</div>}

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

          {/* 第二段（R107，I09 §3.4 / §3.5）：AI 二次筛选切章 + 误切校正。
              两件事都**只改计划**，不写盘——真源写仍是下面那条「确认入库」，
              而且它用的是**同一份**计划（计划上下文跟着票据走），所以预演与入库必然对得上。 */}
          <div className="import-block">
            <div className="import-block-title">
              切分复核：AI 二次筛选 + 误切校正
              <span className="muted">（I09：规则海选 → AI 筛选；误切进人工校正清单）</span>
            </div>
            <div className="import-counts">
              <span className="import-source">
                切分来源：{view.ai.used ? `AI 筛过（${view.ai.provider_id} / ${view.ai.model}，保留 ${String(view.ai.kept)} 条）` : "正则切分"}
              </span>
              <span>疑似标题候选 {String(view.candidates.length)} 条</span>
              <span>人工校正 {String(view.ai.corrections)} 处</span>
            </div>
            {view.ai.fallback !== "" && <div className="import-warn import-note">{view.ai.fallback}</div>}
            {view.ai.rejected.length > 0 && (
              <div className="import-warn import-note">AI 指认被丢弃 {String(view.ai.rejected.length)} 条：{view.ai.rejected.join("；")}</div>
            )}
            <div className="import-actions">
              <button type="button" disabled={busy || picked === null} onClick={() => void runAiSplit()}>
                {aiBusy ? "AI 正在筛…" : "AI 筛一遍切分"}
              </button>
              <span className="muted">
                AI 只在候选里挑（越界的一律丢弃）；筛不出来就回退正则切分，并把理由写在这里。
              </span>
            </div>
            {view.miscuts.length > 0 ? (
              <>
                <div className="import-warn import-note">
                  检出 {String(view.miscuts.length)} 处疑似误切（章号连续性 / 标题长度 / 章节字数分布）——请逐条处置
                </div>
                <table className="slot-table import-table import-miscut-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>标题</th>
                      <th>字数</th>
                      <th>问题</th>
                      <th>校正</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.miscuts.map((row) => (
                      <tr key={`${String(row.index)}`}>
                        <td className="import-num">{String(row.index + 1)}</td>
                        <td>{row.title === "" ? "（无标题）" : row.title}</td>
                        <td className="import-num">{String(row.chars)}</td>
                        <td className="muted">{row.issues.map((issue) => issue.message).join("；")}</td>
                        <td>
                          <button
                            type="button"
                            disabled={busy || row.index === 0}
                            onClick={() => void correct({ kind: "merge", at: row.index - 1 })}
                          >
                            与上一章合并
                          </button>
                          <button
                            type="button"
                            disabled={busy || row.index + 1 >= view.chapters.length}
                            onClick={() => void correct({ kind: "merge", at: row.index })}
                          >
                            与下一章合并
                          </button>
                          <button
                            type="button"
                            disabled={busy || row.index + 1 >= view.chapters.length}
                            onClick={() => void correct({ kind: "move", from: row.index, to: row.index + 1 })}
                          >
                            下移
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="muted import-note">
                  合并有两个方向：「与上一章合并」把这一章并进前一章，「与下一章合并」把它并进后一章——
                  章号不连续报在**断号后的那一章**上（第一章 → 第三章，断的是第三章那一行），
                  所以这一行通常该「与上一章合并」。
                </div>
                <div className="muted import-note">
                  拆章：在下面挑一个「疑似标题」行作为切点（作者点得到那行文字，才切得对）
                </div>
                <div className="import-actions">
                  {view.candidates
                    .filter((candidate) => !candidate.strict)
                    .slice(0, 20)
                    .map((candidate) => (
                      <button
                        key={String(candidate.index)}
                        type="button"
                        className="import-tag"
                        disabled={busy}
                        title={`第 ${String(candidate.line)} 行`}
                        onClick={() => void correct({ kind: "split", candidateIndex: candidate.index })}
                      >
                        在「{candidate.text}」处切开
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <div className="muted">没检出误切：章号连续、标题不长、字数分布均衡。</div>
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
              {/* 正在入库时给一个"停下"的入口：断点会落盘，剩下的可以续跑
                  （半章写进去是半个章 ⇒ 主进程在**章的边界**上才停） */}
              {applying && (
                <button type="button" onClick={() => void cancel()}>
                  停下（剩下的可续跑）
                </button>
              )}
            </div>
            <div className="muted import-rule-note">
              入库写的是真源：新建一卷 + 每章一条章纲 + 每章一个草稿文件，写之前强制留一份可撤销的快照。
              章纲的细项（谁 / 何地 / 目标 / 障碍 / 转折 / 结果 / 钩子）一律留空——那是作者的创作决策，工具不替猜。
            </div>
          </div>

          {/* 断点续跑（R108，I09 §2.7）：主进程按**源文件指纹**核对出来的——
              渲染层不自己判"是不是同一份"，判错了续跑会把两本书接在一起。 */}
          {view.resume !== null && (
            <div className="import-block">
              <div className="import-block-title">
                这稿子上次没导完：已落盘 {String(view.resume.last_chapter)} / {String(view.resume.total_chapters)} 章
              </div>
              <div className="muted import-note">
                续跑会接着写剩下的那几章，**已经写好的那几章不动**（主进程会核对你选的还是不是同一份文件、
                同一份切分，核不过就拒）。
              </div>
              <div className="import-actions">
                <button type="button" className="primary" disabled={busy || applying} onClick={() => void applyAsResume()}>
                  {applying ? "正在续跑…" : "续跑并入库"}
                </button>
                <span className="muted">不想接着上次？直接点下面的「确认入库」会另起一卷。</span>
              </div>
            </div>
          )}

          <div className="import-boundary">
            导入这条线还没做完的部分：实体抽取候选
            （对账已经做了，逐章比对预演字数与落盘字数；AI 二次筛选切章、误切校正与断点续跑已经在上面那几段里）。
          </div>
        </>
      )}

      {result !== null && (
        <div className="import-result">
          <div className="import-block-title">
            {/* 中途停下与导完是**两回事**：停下时"已入库 0 章"这句话会骗人
                （章数是"这次写了几章"，不是"总共几章"）——分开说。 */}
            {result.stopped ? (
              <>
                已停下：写入了 {String(result.writtenChapters)} / {String(result.totalChapters)} 章，剩下的可以续跑
              </>
            ) : (
              <>
                已入库：{result.volumeTitle}（{String(result.created.length)} 章 · {String(result.totalWrittenWords)} 字）
              </>
            )}
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
