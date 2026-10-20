/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 注入门控核对（M4 / T4-2 第五批·第二段，R104；纯函数，不碰 fs）。
 *
 * 判据回源：
 * - **docs/03 §10.1**：`reveal_gate: ch-030 # 早于该章不注入（叙事可见性，J05/A08）`；
 * - **`@yushu/memory/injection.ts:202-213`**：门控解析不到 ⇒ 直接进排除清单，
 *   理由「无法解析（保守不注入，防剧透优先）」。这是**对的保守**，本模块不碰它；
 *   这里要补的是它看不见的那一半——一条门控指向不存在的章，就等于这条内容**在任何一章都不会进上下文**，
 *   而记忆页上"门控 ch-xxx"那行字看着像已经配好了。静默失效比报错更难发现。
 * - **J03:99** 的 `memory-spoiler-leak`（门控未到却被注入）由 `planInjection` 自己拦，不在这里重复发。
 *
 * **口径与 R103 一致**：没登记门控 ⇒ 零结论（"没配置"不进表，R102 裁决）；
 * 有登记但**章序一条都取不到** ⇒ 只发一条 info 总述，不逐条喊悬空——
 * 把"章纲还没回填 chapter_id"报成"N 条门控全坏了"是假红灯，代价是作者学会忽略整张表。
 */

/** 两条 id 都要能被豁免清单认出来（覆盖锁扫源码里的 `rule: "…"` 字面量，漏一条就红） */
export const GATE_RULE_IDS = ["gate-chapter-unknown", "gate-no-chapter-order"] as const;

export type GateRuleId = (typeof GATE_RULE_IDS)[number];
export type GateSeverity = "warn" | "info";

/** 结论出处：御书对作者自己配的注入控制做的核对，不是包规则 */
export const GATE_CHECK_ORIGIN = "御书注入门控核对（docs/03 §10.1 reveal_gate · J05/A08 防剧透）";

/** 章序取不到时那条 info 的主体：它不属于任何一条内容，就落在字段名上（与 R103 同一手法） */
export const GATE_LEDGER_SUBJECT = "reveal_gate";

export interface GateItemRow {
  /** 事实 id 或设定卡 id：结论的主体 */
  id: string;
  /** 显示名（事实取正文首句 / 卡取 name），结论要说"哪一条" */
  label: string;
  /** 条目种类：只为把证据写清楚，判定不区分它 */
  kind: "fact" | "card" | "summary";
  /** 卡 / 事实上登记的 `reveal_gate`；空 = 无门控（常驻或按提及触发），不参与本核对 */
  gate: string;
}

export interface GateCheckInput {
  items: readonly GateItemRow[];
  /** 章序：与可见性核对照同一份（大纲回填的 chapter_id，按卷内顺序摊平） */
  chapterOrder: readonly string[];
}

export interface GateFinding {
  rule: GateRuleId;
  severity: GateSeverity;
  subject: string;
  related?: string;
  message: string;
  evidence: string;
  fix: string;
  origin: string;
}

/** 码点序比较（红线 5：不用 localeCompare，同输入必须同输出） */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function kindLabel(kind: GateItemRow["kind"]): string {
  return kind === "fact" ? "事实" : kind === "card" ? "设定卡" : "摘要";
}

export function checkInjectionGates(input: GateCheckInput): GateFinding[] {
  const gated = input.items
    .filter((item) => item.gate.trim() !== "")
    .sort((a, b) => byCodePoint(a.id, b.id));
  if (gated.length === 0) return [];

  const known = new Set(input.chapterOrder);
  if (known.size === 0) {
    return [
      {
        rule: "gate-no-chapter-order",
        severity: "info",
        subject: GATE_LEDGER_SUBJECT,
        message: `${String(gated.length)} 条内容登记了注入门控，但项目里一条章序都取不到：本轮没法核对门控指向哪一章——这不等于门控都没有问题`,
        evidence: `有 reveal_gate 的条目 ${String(gated.length)} 条，而章序为空（大纲里没有一章回填了 chapter_id，或大纲还没建）：这条不等于门控没有问题——本轮根本没核对过，"判不了"与"没问题"必须分开写`,
        fix: "先去大纲页把章纲「一键创建草稿」跑起来（回填 chapter_id 之后这条链才有章可指）；只想让某条内容常驻就把它的门控清掉。",
        origin: GATE_CHECK_ORIGIN,
      },
    ];
  }

  const findings: GateFinding[] = [];
  for (const item of gated) {
    const gate = item.gate.trim();
    if (known.has(gate)) continue;
    findings.push({
      rule: "gate-chapter-unknown",
      severity: "warn",
      subject: item.id,
      related: gate,
      message: `${kindLabel(item.kind)}「${item.label}」的门控指向 ${gate}，而大纲里没有这一章：它现在任何一章都不会被注入`,
      evidence: `reveal_gate: ${gate} 不在大纲章序里（章被删过、id 写错、或章纲没回填 chapter_id 都会这样）；注入计划按「门控无法解析⇒保守不注入」处理，防剧透是对的，但这条内容也就此永不生效`,
      fix: "把门控改成大纲里存在的章 id（要到哪章才许出现），或清掉门控让它按 mode 正常参与注入；确实想让它永远不进上下文就记豁免并写理由——留着一个坏 id 只会让人以为门控已经配好了。",
      origin: GATE_CHECK_ORIGIN,
    });
  }
  return findings;
}
