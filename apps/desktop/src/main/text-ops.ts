import { readChapterFile } from "@yushu/world-engine";
import { YushuError } from "@yushu/core";
import { applyFixes, proofreadText, type ProofreadFinding } from "@yushu/text";
import type {
  ProofreadFindingPayload,
  TextFixBodyPayload,
  TextFixBodyResultPayload,
  TextProofreadPanelPayload,
  TextProofreadPayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 中文自查主进程编排（M3 / T3-13，J14）——**两个通道都是只读的**。
 *
 * 为什么不在这里写盘：写正文必须只有**一个**入口（编辑器的保存路径 `chapter:write`），
 * 它已经带着 baseHash 冲突检测、编辑日志（防丢稿）、字数增量与索引刷新。
 * 所以 `text:fixBody` 只负责"按已确认的条目算出改后正文"，把结果连同**改前正文**一起回给渲染层；
 * 渲染层先比对"我此刻的正文是否仍等于改前正文"，一致才替换（随后由正常保存路径落盘），
 * 不一致就放弃替换并提示重新自查——这是乐观并发控制，避免把作者刚敲的字覆盖掉。
 *
 * J14 的安全底线在这里有第二道保险：`confirmed !== true` 时**原样返回正文**并计数 `blocked`，
 * 引擎侧 `applyFixes` 同一条规则也会拦一次（`proofread-autofix-unconfirmed`，error）。
 */

async function readBody(
  gateway: ProjectGateway,
  path: string,
): Promise<{ body: string; chapterId: string }> {
  const trimmed = path.trim();
  if (trimmed === "") throw new YushuError("E_INVALID_INPUT", "章节路径不能为空");
  const doc = await gateway.readDoc(trimmed).catch(() => null);
  if (doc === null) {
    throw new YushuError("E_INVALID_INPUT", `章节文件不存在或不可读：${trimmed}（请先在编辑器里选择一章）`);
  }
  const parsed = readChapterFile(doc.content);
  return { body: parsed.body, chapterId: parsed.chapter.id };
}

/** 引擎结果 → IPC 载荷（逐字段显式拷贝，避免把结构化类型整个透传出去） */
function toFindingPayload(finding: ProofreadFinding): ProofreadFindingPayload {
  const payload: ProofreadFindingPayload = {
    rule: finding.rule,
    severity: finding.severity,
    span: {
      ...(finding.span.chapter === undefined ? {} : { chapter: finding.span.chapter }),
      start: finding.span.start,
      end: finding.span.end,
      text: finding.span.text,
    },
    evidence: finding.evidence,
    autofix: finding.autofix,
    source: { engine: finding.source.engine, ...(finding.source.conf === undefined ? {} : { conf: finding.source.conf }) },
  };
  if (finding.suggestion !== undefined) payload.suggestion = finding.suggestion;
  if (finding.candidates !== undefined) payload.candidates = [...finding.candidates];
  return payload;
}

/** 只读检测：对章节正文跑一遍 J14 规则集 */
export async function readProofreadPanel(
  gateway: ProjectGateway,
  payload: TextProofreadPayload,
): Promise<TextProofreadPanelPayload> {
  const { body, chapterId } = await readBody(gateway, payload.path);
  const result = proofreadText(body, { chapter: chapterId });
  return {
    path: payload.path.trim(),
    chapterId,
    chars: result.chars,
    findings: result.findings.map(toFindingPayload),
    counts: result.counts,
    checkedRules: result.checkedRules,
    skippedRules: result.skippedRules,
  };
}

/**
 * 按已确认的条目算出改后正文（**不写盘**，见文件头说明）。
 *
 * 采纳请求只带「起始下标 + 规则」，改法由主进程**重新检测**得到的条目决定——
 * 渲染层不能自己指定"把任意区间改成任意文本"，防成一条绕过校验的通用写通道。
 * `replacement` 仅用于 `autofix:false` 的条目（作者从候选里选定那一个），且必须是该条目登记的候选之一。
 */
export async function buildFixedBody(
  gateway: ProjectGateway,
  payload: TextFixBodyPayload,
): Promise<TextFixBodyResultPayload> {
  const { body } = await readBody(gateway, payload.path);
  const findings = proofreadText(body, {}).findings;

  const picked: ProofreadFinding[] = [];
  const chosen: Array<string | undefined> = [];
  const rejected: Array<{ start: number; reason: string }> = [];

  for (const edit of payload.edits ?? []) {
    const start = Number.isInteger(edit.start) && (edit.start as number) >= 0 ? edit.start : -1;
    if (start < 0) {
      rejected.push({ start: -1, reason: "起始下标非法（必须是非负整数），本条不改" });
      continue;
    }
    const hit = findings.find((f) => f.span.start === start && f.rule === edit.rule);
    if (!hit) {
      rejected.push({
        start,
        reason: "该位置已无对应检测条目（正文或检测口径已变化），本条不改",
      });
      continue;
    }
    picked.push(hit);
    // 与 picked 同序：引擎按下标取显式候选，并校验候选是否真属于该条目
    chosen.push(edit.replacement);
  }

  const result = applyFixes(body, picked, { confirmed: payload.confirmed === true, replacements: chosen });
  return {
    path: payload.path.trim(),
    body: result.text,
    beforeBody: body,
    applied: result.applied,
    rejected: [...rejected, ...result.rejected.map((item) => ({ start: item.span.start, reason: item.reason }))],
    blocked: result.blocked.length,
  };
}
