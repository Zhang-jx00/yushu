/* SPDX-License-Identifier: Apache-2.0 */
import type { PowerGain, PowerLogEntry } from "./power-log.js";

/**
 * 升级门槛与临时增益的核对（M4 / T4-2 第二批，R97；纯函数，不碰 fs）。
 *
 * 判据逐条来自 D03 §5 的规则草案，不是这里发明的：
 * ① `powerup_gate`（R3「新能力三件套」：`evidence_ref / cost / reuse_record`，`on_missing: warning`）；
 * ② `buff_ttl`（R5「临时增益必须带 `expiry`，逾期自动回落」）。
 *
 * **为什么这两条写在御书、"战力崩没崩"却写在派系包**（R57 那条分工要在这里再划一次边界）：
 * 崩塌与否是**流派判断**——换个流派门槛就不同，归包；而"作者自己声明升级了却没记代价"
 * 是**御书那份台账的完整性**，与流派无关，归这里（同 R75 的 `fs-ledger-unreadable`、`lintMemory` 一类）。
 * 规则 DSL 也表达不了它：缺字段在 DSL 里是求值失败（`E_RULE_UNORDERABLE`），不是"报一条缺项"。
 *
 * 一条防误报的口径（R74 的教训：误报的代价是作者学会忽略整块看板）：
 * 三件套**一件都没记**时只发一条 info 总述，不给每次升级刷一行 warn——那等于用红色惩罚"还没用新功能"；
 * 但只要作者**开始记了**（哪怕只记了一条），剩下的缺项就逐条 warn：他显然打算记，漏了就该被点出来。
 */

export type { PowerLogEntry } from "./power-log.js";

/**
 * 这三条 id 都要能被豁免清单认出来（同 R75 的 `FORESHADOW_RULE_IDS`：
 * 报得出来却豁免不掉，等于把作者逼到只能删结论）。有一条覆盖锁扫源码里的
 * `rule: "…"` 字面量，漏一条就红。
 */
export const POWER_GATE_RULE_IDS = ["powerup-gate", "powerup-gate-no-data", "buff-ttl"] as const;

/** 结论出处：这不是包规则，是御书对自己那份台账的核对（面板要能区分开） */
export const POWER_GATE_ORIGIN = "御书战力台账核对（D03 R3 / R5）";

export interface PowerGateRow {
  rule: "powerup-gate" | "powerup-gate-no-data" | "buff-ttl";
  severity: "warn" | "info";
  subject: string;
  /** 结论落在哪一章（台账里作者自己写的那个章号） */
  related: string;
  message: string;
  evidence: string;
  fix: string;
}

/** 三件套的中文名：报错要能对上包里的键名，也要能让作者看懂缺的是什么 */
const GAIN_LABELS: Array<{ key: keyof PowerGain; field: string; label: string }> = [
  { key: "evidenceRef", field: "evidence_ref", label: "证据" },
  { key: "cost", field: "cost", label: "代价" },
  { key: "reuseRecord", field: "reuse_record", label: "复用记录" },
];

function missingGainKeys(entry: PowerLogEntry): string[] {
  const gain = entry.gain ?? {};
  return GAIN_LABELS.filter((item) => gain[item.key] === undefined).map((item) => `${item.label}（${item.field}）`);
}

/** 境界上升的那些条目（三件套管的是"新能力"，不是数值波动） */
export function risingPowerEntries(entries: readonly PowerLogEntry[]): PowerLogEntry[] {
  const rising: PowerLogEntry[] = [];
  for (let index = 1; index < entries.length; index += 1) {
    const prev = entries[index - 1] as PowerLogEntry;
    const current = entries[index] as PowerLogEntry;
    if (current.tier > prev.tier) rising.push(current);
  }
  return rising;
}

function stateOf(entry: PowerLogEntry): string {
  return `境界 ${entry.tier} / 战力 ${entry.combatPower}${entry.event ? ` · 事件 ${entry.event}` : ""}`;
}

export function checkPowerGate(input: { subject: string; entries: readonly PowerLogEntry[] }): PowerGateRow[] {
  const rows: PowerGateRow[] = [];
  const rising = risingPowerEntries(input.entries);
  const recorded = rising.filter((entry) => entry.gain !== undefined);

  if (rising.length > 0 && recorded.length === 0) {
    rows.push({
      rule: "powerup-gate-no-data",
      severity: "info",
      subject: input.subject,
      related: rising[rising.length - 1]!.chapter,
      message:
        `台账里有 ${rising.length} 次境界提升，但没有任何一条记过升级三件套（证据 / 代价 / 复用记录），` +
        `D03 R3 无从核对——**这不等于没有"无代价的新能力"**，只是没人记过`,
      evidence: `战力台账（${input.subject}）：${rising.map((entry) => `${entry.chapter} → ${stateOf(entry)}`).join("；")}`,
      fix: "挑一次最关键的升级，在对应条目的 gain 里补 `evidence_ref / cost / reuse_record`；补齐一条后本条总述会换成逐条点名",
    });
  }

  for (const entry of recorded) {
    const missing = missingGainKeys(entry);
    if (missing.length === 0) continue;
    rows.push({
      rule: "powerup-gate",
      severity: "warn",
      subject: input.subject,
      related: entry.chapter,
      message: `第 ${entry.chapterNo} 章境界升到 ${entry.tier}，但三件套缺：${missing.join("、")}`,
      evidence: `${entry.chapter}：${stateOf(entry)}${entry.gain?.evidenceRef ? ` · 已记证据「${entry.gain.evidenceRef}」` : ""}`,
      fix: `在 ${entry.chapter} 那条台账的 gain 里补 ${missing.map((item) => item.split("（")[1]?.replace("）", "") ?? "").filter(Boolean).join(" / ")}；确认这次升级不需要交代就写进 config/consistency.yaml 并记理由`,
    });
  }

  for (const entry of input.entries) {
    if (entry.kind !== "buff") continue;
    if (entry.expiry !== undefined) continue;
    rows.push({
      rule: "buff-ttl",
      severity: "warn",
      subject: input.subject,
      related: entry.chapter,
      message: `${entry.chapter} 声明是临时增益（kind: buff）却没写 expiry，逾期不回落就会长期顶在高位`,
      evidence: `${entry.chapter}：${stateOf(entry)}`,
      fix: `给这条台账补 expiry（写到哪一章失效），或把 kind 改成 skill_gain / item_equip 这类常驻变更`,
    });
  }

  return rows;
}
