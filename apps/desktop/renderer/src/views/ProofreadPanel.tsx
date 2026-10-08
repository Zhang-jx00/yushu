import { useState } from "react";
import type {
  ProofreadFindingPayload,
  ProofreadSeverityPayload,
  TextProofreadPanelPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 中文自查面板（M3 / T3-13，J14）——**只读检测 + 逐条确认修复**。
 *
 * 三条设计约束（都不是装饰，而是 J14 的红线）：
 * ① **确认闸门可见**：未勾选「我已确认」时所有采纳按钮禁用；即便被程序化绕过，主进程与引擎
 *    仍会各拦一次（`proofread-autofix-unconfirmed`，error）。
 * ② **不新写落盘路径**：改后正文交回编辑器替换文档，随后由既有自动保存通道（baseHash 冲突检测 +
 *    编辑日志 + 字数同步 + 索引刷新）落盘——面板自己从不写文件。
 * ③ **繁简歧义不硬猜**：`autofix:false` 且有候选列表的条目必须作者**从候选里选一个**才提交，
 *    任意文本会被主进程拒绝（防这条通道退化成能改任意区间的通用写通道）。
 */

const SEVERITY_LABEL: Record<ProofreadSeverityPayload, string> = {
  error: "确定性错误",
  warn: "修改建议",
  info: "存疑提示",
};

/** 行的唯一键：同一位置可能被多条规则命中，规则名必须一起进键 */
const rowKey = (finding: ProofreadFindingPayload): string => `${finding.rule}@${finding.span.start}`;

const MAX_ROWS = 60;

export function ProofreadPanel(props: {
  /** 当前章节路径（未选章时为 null，面板如实提示） */
  path: string | null;
  /**
   * 编辑器是否有未保存改动。
   * **闸门用脏标记，不用「正文是否逐字等于磁盘」**：富文本形态下 `htmlToMd(getHTML())` 与磁盘
   * 正文可能语义相同但不逐字相等（空格 / 列表标记往返），按字节比会把采纳**永久拒掉**；
   * 而"会不会吃掉作者刚敲的字"这件事，脏标记才是准确信号——不脏时编辑器内容本就等同磁盘。
   */
  dirty: boolean;
  /** 把改后正文交回编辑器（替换文档内容，落盘由自动保存负责） */
  onReplace: (nextBody: string) => void;
}) {
  const [panel, setPanel] = useState<TextProofreadPanelPayload | null>(null);
  /** 取数回执（最后一次「重新自查」的摘要） */
  const [receipt, setReceipt] = useState("");
  /** 操作回执（最近一次采纳的结果）——与取数回执分两行，否则重扫会把"已采纳 N 处"冲掉，作者看不到自己刚改了什么 */
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 用户为 `autofix:false` 条目选定的候选（rowKey → 文本） */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);

  const findings = panel ? panel.findings : [];

  const refresh = async (): Promise<void> => {
    if (!props.path) {
      setError("请先选择一章再自查");
      return;
    }
    setBusy(true);
    try {
      setError(null);
      const next = await api().text.proofread({ path: props.path });
      setPanel(next);
      setChosen({});
      setReceipt(
        `自查完成：正文 ${next.chars} 字｜${SEVERITY_LABEL.error} ${next.counts.error}｜` +
          `${SEVERITY_LABEL.warn} ${next.counts.warn}｜${SEVERITY_LABEL.info} ${next.counts.info}｜` +
          `已检规则 ${next.checkedRules.length} 条` +
          (next.skippedRules.length > 0 ? `（关闭：${next.skippedRules.join("、")}）` : ""),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (targets: ProofreadFindingPayload[]): Promise<void> => {
    if (!props.path || targets.length === 0) return;
    if (props.dirty) {
      // 主进程按磁盘正文算改后文本；此刻编辑器有未保存改动，替换会把作者刚敲的字吃掉
      setAction("编辑器有未保存改动：请先保存（或撤销）后再采纳，本次未改动稿件");
      return;
    }
    setBusy(true);
    try {
      setError(null);
      const result = await api().text.fixBody({
        path: props.path,
        confirmed: true,
        edits: targets.map((finding) => {
          const picked = chosen[rowKey(finding)];
          return {
            start: finding.span.start,
            rule: finding.rule,
            ...(picked === undefined ? {} : { replacement: picked }),
          };
        }),
      });
      if (result.applied.length === 0) {
        const why =
          result.rejected[0]?.reason ??
          (result.blocked > 0 ? `未确认，${result.blocked} 条被闸门拦下（正文未改动）` : "没有可修的条目");
        setAction(`未改动：${why}`);
        return;
      }
      props.onReplace(result.body);
      setAction(
        `已采纳 ${result.applied.length} 处（改的是编辑器内容，落盘由自动保存完成）` +
          (result.rejected.length > 0 ? `；另有 ${result.rejected.length} 处未改：${result.rejected[0]!.reason}` : "") +
          (result.blocked > 0 ? `；${result.blocked} 条被闸门拦下` : ""),
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel proofread-panel">
      <div className="panel-title">
        <h3>
          中文自查 <span className="muted">J14：标点 / 别字 / 繁简 / 重复 / 长句（只读，逐条确认才改）</span>
        </h3>
        <button type="button" className="link proofread-refresh" onClick={() => void refresh()} disabled={busy || !props.path}>
          {busy ? "处理中…" : "重新自查"}
        </button>
      </div>
      {!props.path && <p className="muted">未选择章节：先在左侧选中一章。</p>}
      {panel === null && props.path && <p className="muted">尚未取数：点「重新自查」检测本章正文。</p>}
      {receipt !== "" && <div className="muted proofread-receipt">{receipt}</div>}
      {action !== "" && <div className="muted proofread-action">{action}</div>}
      {error && <div className="warn proofread-error">{error}</div>}
      {panel && findings.length === 0 && (
        <p className="muted proofread-clean">本次检测没有发现问题（已检规则 {panel.checkedRules.length} 条）。</p>
      )}
      {panel && findings.length > 0 && (
        <>
          <label className="field proofread-confirm-field">
            <span>
              <input
                type="checkbox"
                className="proofread-confirm"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              我已确认这些改动（未勾选则无法采纳；这是 J14 的修复边界——检测可自动、修复需确认）
            </span>
          </label>
          <button
            type="button"
            className="primary proofread-adopt-all"
            disabled={!confirmed || busy}
            onClick={() => void adopt(findings.filter((finding) => finding.autofix))}
          >
            采纳全部「可自动修」（{findings.filter((f) => f.autofix).length} 条）
          </button>
          <ul className="proofread-list">
            {findings.slice(0, MAX_ROWS).map((finding) => {
              const key = rowKey(finding);
              const needsChoice = !finding.autofix && (finding.candidates?.length ?? 0) > 0;
              const picked = chosen[key];
              return (
                <li key={key} className={`proofread-row severity-${finding.severity}`} data-start={finding.span.start}>
                  <span className={`badge proofread-severity ${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
                  <span className="proofread-rule muted">{finding.rule}</span>
                  <code className="proofread-hit">「{finding.span.text}」</code>
                  {finding.suggestion !== undefined && <span className="proofread-suggest">→ {finding.suggestion}</span>}
                  {needsChoice && (
                    <select
                      className="proofread-candidate"
                      value={picked ?? ""}
                      onChange={(event) => setChosen((prev) => ({ ...prev, [key]: event.target.value }))}
                    >
                      <option value="">选候选…</option>
                      {(finding.candidates ?? []).map((candidate) => (
                        <option key={candidate} value={candidate}>
                          {candidate}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="link proofread-adopt"
                    disabled={
                      !confirmed ||
                      busy ||
                      (finding.autofix ? false : picked === undefined)
                    }
                    onClick={() => void adopt([finding])}
                  >
                    采纳
                  </button>
                  <div className="muted proofread-evidence">{finding.evidence}</div>
                </li>
              );
            })}
          </ul>
          {findings.length > MAX_ROWS && (
            <p className="muted">仅列出前 {MAX_ROWS} 条（共 {findings.length} 条）——先处理高优先项或分章自查。</p>
          )}
        </>
      )}
    </div>
  );
}
