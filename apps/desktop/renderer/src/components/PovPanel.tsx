/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PovPreviewPayload } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 视角策略与看板（M4 / T4-2 第三批，R102）。
 *
 * 这一屏只做四件事：**看清策略 → 改策略 → 给某章绑视角 → 看清结论**。判定全在引擎
 * （`pov-config.ts` / `pov-check.ts`，出处 F04 §3.1/§3.2/§3.6），这里一律不重算——
 * 两处各算一次，作者就会照一句假话核对（R94/R98 同一条规矩）。
 *
 * 四条展示口径：
 * ① **没声明 ≠ 没问题**：`undeclared` 时那句"本轮没有核对过视角"必须由引擎原话给出，
 *    面板不替它改成"暂无结论"；
 * ② **读不了 ≠ 没声明**：`unreadable` 把解析报错原样摊开，并且一条结论都不显示；
 * ③ **未建草稿的章不参与核对**：计数要点名它，否则"零结论"会被读成"全书视角没问题"；
 * ④ 面板**不假装能判 head-hopping**（同一场景里两个角色的内心直写）：那条要读文气，
 *    本仓库的口径是不靠关键词猜语义（R74），它留给配合 AI 采样核验的那一轮。
 *
 * 零新增 CSS：复用 `.panel` / `.slot-table` / `.checkbox` / `.outline-actions` / `.field`（策略输入框
 * 用它才铺得开——裸 textarea 只有 20 字符宽）/ `.muted` / `.warn` / `.error-text`（契约 §7：先复用再新建）。
 */

export function PovPanel() {
  const [view, setView] = useState<PovPreviewPayload | null>(null);
  const [strict, setStrict] = useState(true);
  /** 策略编辑中的草稿；null = 未编辑（显示盘上那份） */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const next = await api().pov.preview({ strict });
      setView(next);
      // 正在编辑的那份不能被"重新核对"冲掉——但盘上哈希要跟着刷新（保存时用它做 baseHash）
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [strict]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const configText = draft ?? view?.configText ?? "";
  const dirty = draft !== null && draft !== (view?.configText ?? "");

  const saveConfig = async () => {
    if (view === null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api().pov.writeConfig({ content: draft ?? view.configText, baseHash: view.configHash });
      setReceipt(`已保存 ${saved.path}（清空即回到「未声明」；策略一改，下一次体检就按新口径判）`);
      setDraft(null);
      const next = await api().pov.preview({ strict });
      setView(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bindChapter = async (path: string, hash: string, pov: string) => {
    setBusy(true);
    setError(null);
    try {
      await api().pov.setChapter({ path, pov, baseHash: hash });
      const next = await api().pov.preview({ strict });
      setView(next);
      setReceipt(
        pov === ""
          ? "已清除该章视角（回到「本章未声明」；限知模式下会重新被点名）"
          : `已把该章视角绑到 ${pov}（只改 frontmatter，正文与记录字数一字不动）`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 章 id → 标题：结论表要说"哪一章"，不能让作者自己去对 id */
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of view?.chapters ?? []) map.set(row.chapterId, row.title);
    return map;
  }, [view]);

  return (
    <section className="panel pov-panel">
      <h3>
        视角策略与看板 <span className="muted">T4-2 第三批：只判能判的（F04 §3.1 / §3.2 / §3.6）</span>
      </h3>
      <p className="muted">
        策略写在 <code>config/pov.yaml</code>。没写就是「没声明」——御书不替你选模式，也不按「多数网文是三限」
        给你发一堆假警告。<b>同一场景里两个角色的内心直写（head-hopping）这一轮不判</b>：那条要靠读文气，
        不靠关键词猜。
      </p>

      {view === null && !busy && <p className="muted">正在读取视角策略…</p>}

      {view !== null && (
        <>
          {view.state === "undeclared" && (
            <p className="warn pov-state">
              {view.findings[0]?.message ??
                "还没声明视角策略：本轮没有核对过视角，没有结论不等于没有问题。"}
            </p>
          )}
          {view.state === "unreadable" && (
            <p className="error-text pov-state">
              策略读不了，本轮一条视角结论都没有（这不代表没问题）：{view.configError}
            </p>
          )}
          {view.state === "declared" && (
            <div className="pov-strategy">
              模式 <code>{view.mode || "（未写）"}</code> · 距离 <code>{view.distance || "（未写）"}</code> ·
              默认视角 <code>{view.defaultPov || "（未写）"}</code> · 白名单{" "}
              {view.allowedPovs.length === 0 ? (
                <span className="muted">空（不限制谁能当视角）</span>
              ) : (
                <code>{view.allowedPovs.join("、")}</code>
              )}{" "}
              · 切换预算{" "}
              {view.minGapChapters === null ? (
                <span className="muted">未设（不判切换间隔）</span>
              ) : (
                <>
                  同一角色至少隔 <code>{view.minGapChapters}</code> 章
                </>
              )}
              {view.signalRequired !== null && (
                <span className="muted">
                  {" "}
                  · 切换需分隔信号 {view.signalRequired ? "（已声明，但本轮不判——要看正文分场）" : "（不要求）"}
                </span>
              )}
            </div>
          )}

          <label className="checkbox pov-strict">
            <input
              type="checkbox"
              checked={strict}
              disabled={busy}
              onChange={(event) => setStrict(event.target.checked)}
            />
            <span>严格档：切换预算按警告报（关掉降为提示，同一条事实、同一句原话）</span>
          </label>

          <p className="muted pov-counted">
            大纲 {view.counted.outlineChapters} 章 · 已建草稿 {view.counted.drafted} 章 · 其中已标视角{" "}
            {view.counted.withPov} 章 · 未建草稿 {view.counted.notDrafted} 章
            <span className="muted">（未建草稿的章没有 frontmatter，不参与视角核对）</span> · 角色卡{" "}
            {view.counted.characters} 张 · 本轮结论 {view.counted.findings} 条
          </p>

          <label className="field pov-config-field">
            <span>策略文件 config/pov.yaml（清空并保存 = 撤销声明；解析不过就不落盘）</span>
            <textarea
              className="pov-config"
              rows={6}
              value={configText}
              disabled={busy}
              placeholder={"mode: third_limited\nallowed_povs:\n  - char-xxx\nswitch_policy:\n  min_gap_chapters: 2"}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>

          <div className="outline-actions">
            <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void saveConfig()}>
              保存策略
            </button>
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              重新读取
            </button>
          </div>
          {/* 回执紧跟按钮：它是"刚才那一下成了没有"的回答，不该掉到长表底下 */}
          {receipt && <div className="muted pov-receipt">{receipt}</div>}

          {/* 结论排在章表之前：34 章的长表把结论挤到屏幕外，等于没有结论 */}
          {view.findings.length === 0 ? (
            <p className="muted pov-clean">
              {view.state === "declared"
                ? "本轮没有视角结论（只判已声明策略能判的那几条）。"
                : "本轮没有逐章结论（见上面那句状态说明）。"}
            </p>
          ) : (
            <table className="slot-table pov-findings">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>规则</th>
                  <th>哪一章</th>
                  <th>结论</th>
                  <th>依据</th>
                  <th>建议修法</th>
                </tr>
              </thead>
              <tbody>
                {view.findings.map((item, index) => (
                  <tr key={`${item.rule}-${item.subject}-${index}`}>
                    <td className={item.severity === "warn" ? "warn" : "muted"}>{item.severity}</td>
                    <td>
                      <code>{item.rule}</code>
                    </td>
                    <td>
                      <code>{item.subject}</code>
                      {titleById.has(item.subject) ? <span className="muted"> {titleById.get(item.subject)}</span> : null}
                    </td>
                    <td>{item.message}</td>
                    <td className="muted">{item.evidence}</td>
                    <td>{item.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {view.chapters.length === 0 ? (
            <p className="muted">大纲里还没有章：先有章纲（三级大纲页），再建草稿，才会有视角可绑。</p>
          ) : (
            <table className="slot-table pov-chapters">
              <thead>
                <tr>
                  <th>章</th>
                  <th>标题</th>
                  <th>本章视角</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {view.chapters.map((row) => {
                  const flagged = view.findings.filter((item) => item.subject === row.chapterId);
                  return (
                    <tr key={row.chapterId}>
                      <td>
                        <code>
                          {row.idx} · {row.chapterId}
                        </code>
                      </td>
                      <td>
                        {row.title}
                        <div className="muted">{row.volumeTitle}</div>
                      </td>
                      <td>
                        {row.drafted && row.path !== null && row.hash !== null ? (
                          <PovSelect
                            value={row.pov}
                            characters={view.characters}
                            busy={busy}
                            onChange={(pov) => void bindChapter(row.path!, row.hash!, pov)}
                          />
                        ) : (
                          <span className="muted">未建草稿</span>
                        )}
                      </td>
                      <td className={flagged.length > 0 ? "warn" : "muted"}>
                        {flagged.length === 0
                          ? "无结论"
                          : flagged.map((item) => item.rule).join("、")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {view.exemptions.length > 0 && (
            <table className="slot-table pov-exemptions">
              <thead>
                <tr>
                  <th>豁免</th>
                  <th>对象</th>
                  <th>理由（必须写）</th>
                </tr>
              </thead>
              <tbody>
                {view.exemptions.map((item) => (
                  <tr key={`${item.scope}-${item.id}`}>
                    <td>
                      <code>{item.scope}</code>
                    </td>
                    <td>
                      <code>{item.id}</code>
                      {item.scope === "chapter" ? (
                        <span className="muted">
                          {" "}
                          {titleById.has(item.id) ? titleById.get(item.id) : "（这一章不在大纲里）"}
                        </span>
                      ) : (
                        <span className="muted">（本轮只按 scope: chapter 判，别的取值不参与）</span>
                      )}
                    </td>
                    <td>{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted pov-note">
            点上面的「全书体检」时，这些结论会和结构类规则、派系包规则一起进那张表（出处列写着它们的来源）。
            想长期放过某一条，写进 <code>config/consistency.yaml</code>（体检豁免，必须写理由）；
            想让某一章按全知开场，写进 <code>config/pov.yaml</code> 的 <code>exemptions</code>（叙事豁免）——两件事别混成一个词。
          </p>
        </>
      )}

      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

/**
 * 本章视角的下拉：候选只来自角色卡（写一个查无此人的 id 在主进程就被拒）。
 * 当前值若已经悬空（角色卡被删了），仍给它一个选项并标明——否则下拉会把它洗成「未指定」，
 * 作者看不见自己正 pointing 到一个不存在的角色。
 */
function PovSelect(input: {
  value: string;
  characters: Array<{ id: string; name: string }>;
  busy: boolean;
  onChange: (pov: string) => void;
}) {
  const known = input.characters.some((item) => item.id === input.value);
  return (
    <select
      className="pov-bind"
      aria-label="本章视角"
      value={input.value}
      disabled={input.busy}
      onChange={(event) => input.onChange(event.target.value)}
    >
      <option value="">（未指定）</option>
      {input.characters.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}（{item.id}）
        </option>
      ))}
      {input.value !== "" && !known && <option value={input.value}>{input.value}（查无此人）</option>}
    </select>
  );
}
