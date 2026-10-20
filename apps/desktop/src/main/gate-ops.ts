/* SPDX-License-Identifier: Apache-2.0 */
import {
  GATE_CHECK_ORIGIN,
  MEMORY_FACTS_DIR,
  checkInjectionGates,
  type GateItemRow,
  type ReportFinding,
} from "@yushu/world-engine";
import { parseFact } from "@yushu/memory";
import type { GateUnreadablePayload } from "../shared/ipc.js";
import type { ProjectGateway } from "./file-gateway.js";
import { outlineChapterOrder, readProjectId } from "./doc-readers.js";
import { readAllCards } from "./prompt-ops.js";

/**
 * 注入门控核对的桌面侧（M4 / T4-2 第五批·第二段，R104）。
 *
 * 判定在引擎（`gate-check.ts`），本模块只做引擎做不到的两件事：
 * ① **把带 `reveal_gate` 的条目都找出来**——这条链分散在两处真源：事实级记忆
 *    （`memory/facts/*.md` 的 frontmatter）与设定卡（卡上的 `injection`），
 *    现成的读取没有一个能一次给全（`loadMemoryState` 只给事实且会把默认配置合并进来、
 *    看不出的"这条到底自己填了门控"；`readAllCards` 只给卡），所以这里自己走一遍真源；
 * ② 章序取 `outlineChapterOrder` 那份**单一口径**（与 R103 的可见性核对同一份答案）。
 *
 * 两条如实的边界，写在这里而不是假装没有：
 * - **跨项目的事实跳过**：它们本来就不进本项目的注入计划（`loadMemoryState` 同样处理并单列拒绝清单），
 *   对一条永不参与的记录喊"门控悬空"是转移视线；
 * - **坏卡由 `vis-card-unreadable` 点名**：卡走的是 `readAllCards`，解析失败的单卡会被跳过——
 *   同一张卡在体检表里已经有一条读不动的结论了，这里不再重复发第二条同族结论；
 *   事实文件读不动则在本模块点名（`gate-record-unreadable`），因为 `loadMemoryState` 的那条
 *   `memory-malformed` 只出现在记忆页，进不了体检表与豁免清单。
 */

/** 桌面侧的 id（引擎只吃解析好的行，不知道"有份记录读不动"）；与 fs/pov/vis/open 同族 */
export const GATE_UNREADABLE_RULE = "gate-record-unreadable";

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 从"原始 injection 值"里取门控：卡上的 injection 是 schema 透传的 unknown，不能当可信对象用 */
function gateOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const gate = (raw as Record<string, unknown>)["reveal_gate"];
  if (typeof gate !== "string") return undefined;
  const trimmed = gate.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 事实的显示名：优先第一个触发键（那才是作者认得的那个词），退回正文首行 */
function factLabel(keys: readonly string[], text: string): string {
  const first = keys[0];
  if (first !== undefined && first.trim() !== "") return first.trim();
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === undefined ? "（空事实）" : line.slice(0, 24);
}

async function scanGated(
  gateway: ProjectGateway,
): Promise<{ items: GateItemRow[]; unreadable: GateUnreadablePayload[] }> {
  const projectId = await readProjectId(gateway);
  const tree = await gateway.listTree();
  const factPaths = tree
    .filter((entry) => entry.type === "file" && entry.path.startsWith(`${MEMORY_FACTS_DIR}/`) && entry.path.endsWith(".md"))
    .map((entry) => entry.path)
    .sort(byCodePoint);

  const items: GateItemRow[] = [];
  const unreadable: GateUnreadablePayload[] = [];

  for (const path of factPaths) {
    try {
      const snapshot = await gateway.readDoc(path);
      const fact = parseFact(snapshot.content);
      if (fact.project_id !== projectId) continue;
      const gate = fact.injection?.reveal_gate;
      if (typeof gate === "string" && gate.trim() !== "") {
        items.push({ id: fact.id, kind: "fact", label: factLabel(fact.keys, fact.text), gate: gate.trim() });
      }
    } catch (err) {
      unreadable.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const card of await readAllCards(gateway)) {
    const gate = gateOf(card.injection);
    if (gate !== undefined && card.id !== "") {
      items.push({ id: card.id, kind: "card", label: card.name, gate });
    }
  }
  return { items, unreadable };
}

/** 读不动的事实文件（面板与结论都要点名它，不能让它消失在"零结论"里） */
export async function gateUnreadable(gateway: ProjectGateway): Promise<GateUnreadablePayload[]> {
  return (await scanGated(gateway)).unreadable;
}

export async function gateReportFindings(gateway: ProjectGateway): Promise<ReportFinding[]> {
  const { items, unreadable } = await scanGated(gateway);
  if (items.length === 0 && unreadable.length === 0) return [];

  const findings: ReportFinding[] = checkInjectionGates({
    items,
    chapterOrder: await outlineChapterOrder(gateway),
  }).map((row) => ({
    rule: row.rule,
    severity: row.severity,
    subject: row.subject,
    ...(row.related === undefined ? {} : { related: row.related }),
    evidence: row.evidence,
    fix: row.fix,
    origin: row.origin,
  }));
  const broken: ReportFinding[] = unreadable.map((record) => ({
    rule: GATE_UNREADABLE_RULE,
    severity: "warn",
    subject: record.path,
    evidence: `${record.path} 读不动，它的注入门控本轮没有参与核对：${record.error}`,
    fix: "按报错修那份事实记录的 frontmatter（keys 必填、injection 字段非法会整份拒绝）；修不好就去记忆页重记一条。",
    origin: GATE_CHECK_ORIGIN,
  }));
  return [...findings, ...broken];
}
