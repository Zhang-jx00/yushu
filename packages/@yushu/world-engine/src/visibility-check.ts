/* SPDX-License-Identifier: Apache-2.0 */
import { VISIBILITIES, type Visibility } from "@yushu/core";

/**
 * 信息可见性核对（M4 / T4-2 第四批·第一段，R103；纯函数，不碰 fs）。
 *
 * 判据逐条回源，不是这里发明的：
 * - **docs/01 §4.2**：设定条目元数据 = 叙事可见性（冰山原则）+ 关联剧情标记 + **来源章节链接**；
 * - **K05:80 的示例卡**：`source_chapters: [ch-003, ch-012]` 配 `visibility: written_unrevealed`
 *   ——登记了出场章但仍"已写未揭示"是**合法形状**，所以本模块绝不判"出场即揭示"；
 * - **A08 §3.4 / §5**：单章新揭示数 >3 ⇒ 警告"设定轰炸"（阈值 3 来自那句原文，可覆盖）；
 * - **界面自己的释义**（`ArchiveView` 可见性下拉）：`hidden` = 「隐藏（未在正文出现）」
 *   ——于是 `hidden` + 非空 `source_chapters` 是卡内自相矛盾，不需要读任何正文就能判。
 *
 * 一条贯穿口径：**没登记就不判**（R97 的 `powerup-gate-no-data` 同一条路子）。
 * 全项目一条出处都没登记时只发**一条 info 总述**并写明"这不等于台账没问题"，
 * 不给每张卡发一行 warn——那等于用红色惩罚"还没开始登记"，而误报的代价是作者学会忽略整块看板。
 *
 * **明写不做的部分**：F07 的 `knows` 信息差矩阵、A08 的 `reveal_chapter` / `knowable_by` /
 * "本章用未揭示规则解扣"——这些字段在本项目里根本不存在（grep 零命中），要判只能靠关键词猜正文，
 * 那是 R74 明令不走的路子。缺数据就少判，不假装能判。
 */

/** 五条 id 都要能被豁免清单认出来（覆盖锁扫源码里的 `rule: "…"` 字面量，漏一条就红） */
export const VISIBILITY_RULE_IDS = [
  "vis-hidden-but-sourced",
  "vis-revealed-no-source",
  "vis-no-source-registered",
  "vis-source-chapter-unknown",
  "vis-first-appearance-overload",
] as const;

export type VisibilityRuleId = (typeof VISIBILITY_RULE_IDS)[number];
export type VisibilitySeverity = "warn" | "info";

/** 结论出处：不是包规则，是御书对作者自己登记的那份可见性台账的核对 */
export const VISIBILITY_CHECK_ORIGIN = "御书信息可见性核对（docs/01 §4.2 冰山原则 · A08 §3/§5）";

/** A08 §3.4 的"如 3 条/章"——阈值给默认值，调用方可按自己书的节奏覆盖 */
export const VISIBILITY_MAX_FIRST_APPEARANCES = 3;

/** 没登记出处时那条 info 的主体：它不属于任何一张卡，就落在字段名上 */
export const VISIBILITY_LEDGER_SUBJECT = "source_chapters";

export interface VisibilityCardRow {
  id: string;
  /** 显示名：结论要能说"哪张卡"，不能让作者自己去对 id */
  name: string;
  /** 卡上的可见性；不在 VISIBILITIES 里的取值由 schema 拦，本模块遇到就不判（不猜） */
  visibility: string;
  /** 卡上登记的来源章节 id（出场登记，不等于揭示） */
  sourceChapters: readonly string[];
}

export interface VisibilityCheckInput {
  cards: readonly VisibilityCardRow[];
  /** 章序：大纲里章的先后（ch- id）；来源章节按它排"最早出现" */
  chapterOrder: readonly string[];
  /** 单章"首次出现"上限（默认 3，来自 A08 §3.4） */
  maxFirstAppearancesPerChapter?: number;
}

export interface VisibilityFinding {
  rule: VisibilityRuleId;
  severity: VisibilitySeverity;
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

function dedupeSorted(chapters: readonly string[]): string[] {
  return [...new Set(chapters.map((chapter) => chapter.trim()).filter((chapter) => chapter !== ""))].sort(byCodePoint);
}

function namedList(names: readonly string[]): string {
  const head = names.slice(0, 5);
  return head.join("、") + (names.length > head.length ? `…（共 ${String(names.length)} 张）` : "");
}

export function checkVisibility(input: VisibilityCheckInput): VisibilityFinding[] {
  const cards = [...input.cards].sort((a, b) => byCodePoint(a.id, b.id));
  if (cards.length === 0) return [];

  const rank = new Map<string, number>();
  input.chapterOrder.forEach((chapter, index) => {
    if (!rank.has(chapter)) rank.set(chapter, index);
  });
  const limit = input.maxFirstAppearancesPerChapter ?? VISIBILITY_MAX_FIRST_APPEARANCES;
  const rows: VisibilityFinding[] = [];
  /** 全项目有没有人登记过出处——决定"逐卡点名"还是"一条总述"（R97 同一条防误报口径） */
  const anyRegistered = cards.some((card) => card.sourceChapters.length > 0);
  if (!anyRegistered) {
    return [
      {
        rule: "vis-no-source-registered",
        severity: "info",
        subject: VISIBILITY_LEDGER_SUBJECT,
        message: `全项目 ${String(cards.length)} 张设定卡都没有登记来源章节：本轮没有可对照的出处，未揭示 / 已揭示都判不了——这不等于可见性台账没有问题`,
        evidence: `全项目 ${String(cards.length)} 张卡的 source_chapters 都是空数组：本轮没有可对照的出处，"没核对过"不等于"台账没问题"（AI 抽取采纳时会自动登记，手写卡要在档案页的来源章节那一栏自己填）`,
        fix: "从最关键的几张卡开始补 source_chapters（它同时是冰山台账与「这条设定在哪章露过面」的唯一线索）；确实不打算维护就干脆别看这条结论。",
        origin: VISIBILITY_CHECK_ORIGIN,
      },
    ];
  }
  /** 章 → 以该章为"首次出现"的那些卡（悬空 id 不进桶，见下面那条规则） */
  const buckets = new Map<string, VisibilityCardRow[]>();

  for (const card of cards) {
    const sources = dedupeSorted(card.sourceChapters);
    const known = sources.filter((chapter) => rank.has(chapter));
    const unknown = sources.filter((chapter) => !rank.has(chapter));

    if (!VISIBILITIES.includes(card.visibility as Visibility)) continue;

    if (card.visibility === "hidden" && sources.length > 0) {
      rows.push({
        rule: "vis-hidden-but-sourced",
        severity: "warn",
        subject: card.id,
        related: known[0] ?? sources[0],
        message: `设定「${card.name}」的可见性是 hidden（界面释义：未在正文出现），却登记了 ${String(sources.length)} 个来源章节`,
        evidence: `visibility: hidden 与 source_chapters: [${sources.join(", ")}] 同时出现在同一张卡上，两者互相打脸`,
        fix: "二选一：它确实出场了就改成 written_unrevealed（已写未揭示）/ foreshadowed（已埋伏笔）/ revealed（已揭示）；它还没出场就清掉 source_chapters。确认是刻意留白就写进 config/consistency.yaml 并记理由。",
        origin: VISIBILITY_CHECK_ORIGIN,
      });
    }

    if (card.visibility === "revealed" && sources.length === 0 && anyRegistered) {
      rows.push({
        rule: "vis-revealed-no-source",
        severity: "warn",
        subject: card.id,
        message: `设定「${card.name}」标着已揭示，却没有登记任何来源章节`,
        evidence: "visibility: revealed 且 source_chapters 为空；同项目里别的卡已经登记了来源章节（说明这条链是有人在维护的）",
        fix: "把揭示它的那一章填进 source_chapters（docs/01 §4.2 的「来源章节链接」就是给这条链用的）；其实还没揭示就把可见性改回 written_unrevealed。",
        origin: VISIBILITY_CHECK_ORIGIN,
      });
    }

    if (unknown.length > 0) {
      rows.push({
        rule: "vis-source-chapter-unknown",
        severity: "warn",
        subject: card.id,
        related: unknown[0],
        message: `设定「${card.name}」登记的来源章节有 ${String(unknown.length)} 个在大纲章序里找不到`,
        evidence: `这些 id 不在大纲章序里：${unknown.join(", ")}（章被删过、id 写错、或章纲没回填 chapter_id 都会这样）`,
        fix: "改成现存章的 id，或删掉这条登记；这条不判它「在第几章首次出现」——猜出来的章序比不判更坏。",
        origin: VISIBILITY_CHECK_ORIGIN,
      });
    }

    /** 首次出现 = 已登记来源章里章序最早的那个（悬空 id 不参与，见上） */
    if (known.length > 0) {
      const first = known.reduce((best, chapter) => ((rank.get(chapter) ?? 0) < (rank.get(best) ?? 0) ? chapter : best));
      buckets.set(first, [...(buckets.get(first) ?? []), card]);
    }
  }

  for (const chapter of input.chapterOrder) {
    const bucket = buckets.get(chapter);
    if (bucket === undefined || bucket.length <= limit) continue;
    rows.push({
      rule: "vis-first-appearance-overload",
      severity: "warn",
      subject: chapter,
      message: `第 ${String(input.chapterOrder.indexOf(chapter) + 1)} 章一次性首次出现 ${String(bucket.length)} 张设定，超过阈值 ${String(limit)}（A08 说的"设定轰炸"）`,
      evidence: `以卡上登记的最早来源章节为"首次出现"的代理：${namedList(bucket.map((card) => card.name))}`,
      fix: "把其中几条挪到后面的章再露面，或先只留读者当下必须懂的那一条；这是节奏判断，不认就调 maxFirstAppearancesPerChapter 或记豁免并写理由。",
      origin: VISIBILITY_CHECK_ORIGIN,
    });
  }
  return rows;
}
