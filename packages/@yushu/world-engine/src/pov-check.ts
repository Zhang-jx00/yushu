/* SPDX-License-Identifier: Apache-2.0 */
import type { PovConfig, PovExemption } from "./pov-config.js";

/**
 * 视角一致性的**可判定**部分（M4 / T4-2 第三批，R102）。
 *
 * 判据出处 docs/research/F-叙事与故事构建/F04-视角与人称.md：§3.1 五种模式、
 * §3.2 限知视角需要逐章绑定、§3.6 切换预算与豁免清单、§5 的 L2–L5。
 *
 * **本轮不做的**（宁可少一条检查，也不假装它能用）：
 * - L1「同一场景内出现 ≥2 个角色的内心直写」（head-hopping）：要靠标记词表猜，
 *   与本仓库"不靠关键词猜语义"的口径冲突（R74 的裁决：误报的代价是作者学会忽略整块看板）。
 *   那条要配合既有的 AI 采样核验一起做（R58 那套），本轮不落地。
 * - `switch_policy.signal_required` 与 `granularity: scene`：解析层认这两个字段（写错了会报错），
 *   但**这里不据它们发结论**——"切换处有没有分隔信号"要读正文分场，本轮没有那个能力。
 *   配置能写而检查不判，是因为面板要把策略完整展示给作者；不判的字段不能变成假绿灯，
 *   所以未声明策略时那条 info 会说明"没核对过不等于没问题"。
 *
 * 一条贯穿的口径：**没声明就不判**。`config/pov.yaml` 缺失 ⇒ 只报一条 info 总述，
 * 不拿"多数网文是三限"当默认去给每章发警告。
 */

export type PovRuleId =
  | "pov-missing"
  | "pov-unknown"
  | "pov-not-allowed"
  | "pov-switch-gap"
  | "pov-policy-undeclared";

/** 这五条都要能被豁免清单认出来（同 POWER_GATE / FORESHADOW 那两条口径：报得出来却豁免不掉等于逼作者删结论） */
export const POV_RULE_IDS: readonly PovRuleId[] = [
  "pov-missing",
  "pov-not-allowed",
  "pov-policy-undeclared",
  "pov-switch-gap",
  "pov-unknown",
];

/** 结论出处：不是包规则，是御书对作者自己声明的那份视角策略的核对 */
export const POV_CHECK_ORIGIN = "御书视角策略核对（F04 §3.1 / §3.2 / §3.6）";

/**
 * 需要逐章绑定视角的模式（F04 §3.2）：限知与混用都要知道"这一章是谁的眼睛"。
 * 全知 / 第一 / 第二人称不要求——给全知小说发"本章未标视角"是纯噪声。
 * `mode` 没写时**不判**这一条：不知道作者选的是哪种模式，就没资格要求他绑视角。
 */
const POV_REQUIRED_MODES: readonly string[] = ["third_limited", "mixed"];

export interface PovChapterRow {
  chapterId: string;
  path: string;
  title: string;
  /** 章序（全书单调递增）：切换预算按它算间隔，结论顺序也按它排 */
  idx: number;
  /** 章 frontmatter 里的 `pov`，未填为空串 */
  pov: string;
}

export interface PovFinding {
  rule: PovRuleId;
  severity: "warn" | "info";
  /** 主体：章 id；策略未声明时是 config/pov.yaml 这个路径 */
  subject: string;
  /** 相关方：被点名的角色 id / 上一次同视角的那一章 */
  related?: string;
  /** 一行说清发生了什么（面板首行用它） */
  message: string;
  /** 可核验的证据：拿到的实际值，而不是"这里有问题" */
  evidence: string;
  fix: string;
  origin: string;
}

export interface PovCheckInput {
  chapters: readonly PovChapterRow[];
  /** 项目里真实存在的角色 id（悬空视角引用按它判） */
  characterIds: readonly string[];
  /** null = 作者还没声明策略 */
  config: PovConfig | null;
  /**
   * 严格档（默认）：切换预算按 warn 报，全书体检里会进红字计数；
   * 宽松档降一级为 info——同一条事实，只是作者此刻不想被催。
   */
  strict?: boolean;
}

/** 码点序比较（红线 5：不用 localeCompare，同输入必须同输出） */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 章序：先按 idx，同 idx 再按章 id——两本不同顺序读进来的项目要给出同一份结论 */
function chapterOrder(a: PovChapterRow, b: PovChapterRow): number {
  if (a.idx !== b.idx) return a.idx - b.idx;
  return byCodePoint(a.chapterId, b.chapterId);
}

/** 该章是否在豁免清单里（F04 §3.6：豁免要指到具体那一章，且必须写理由） */
function isExempt(exemptions: readonly PovExemption[] | undefined, chapterId: string): boolean {
  if (exemptions === undefined) return false;
  return exemptions.some((row) => row.scope === "chapter" && row.id === chapterId);
}

/**
 * 视角 → 角色的核对与白名单判定。
 *
 * **一章只给一个根因**：查不到这个角色的章，不再顺带报"不在白名单"——
 * 那条即便成立也不是作者该先改的东西（先把 id 修对，白名单才有意义）。
 */
function judgeDeclaredPov(
  chapter: PovChapterRow,
  pov: string,
  input: { known: Set<string>; allowed: Set<string> | null },
): PovFinding[] {
  const rows: PovFinding[] = [];
  if (!input.known.has(pov)) {
    rows.push({
      rule: "pov-unknown",
      severity: "warn",
      subject: chapter.chapterId,
      related: pov,
      message: `「${chapter.title}」声明的视角「${pov}」在项目里找不到这个角色`,
      evidence: `本章 pov: ${pov}，但角色清单（memory/角色卡）里没有同名 id`,
      fix: "把 pov 改成存在的角色 id；确实还没建档就先建那张卡。要临时放过这一章，去 config/pov.yaml 的 exemptions 记 scope: chapter + id + reason（豁免必须写理由）。",
      origin: POV_CHECK_ORIGIN,
    });
    return rows;
  }
  if (input.allowed !== null && !input.allowed.has(pov)) {
    rows.push({
      rule: "pov-not-allowed",
      severity: "warn",
      subject: chapter.chapterId,
      related: pov,
      message: `「${chapter.title}」用的视角「${pov}」不在策略白名单 allowed_povs 里`,
      evidence: `本章 pov: ${pov}；config/pov.yaml 的 allowed_povs 为 [${[...input.allowed].join(", ")}]`,
      fix: "要么把该角色加进 allowed_povs（等于承认它是视角角色），要么换回白名单里的角色来写这一章；两者都不选就记豁免并写理由。",
      origin: POV_CHECK_ORIGIN,
    });
  }
  return rows;
}

export function checkPovConsistency(input: PovCheckInput): PovFinding[] {
  const config = input.config;
  if (config === null) {
    // 没声明 ⇒ 不判：唯一那条 info 必须说清"本轮没核对过"，不能被读成"视角没问题"
    return [
      {
        rule: "pov-policy-undeclared",
        severity: "info",
        subject: "config/pov.yaml",
        message: "还没声明视角策略（config/pov.yaml 不存在或为空）：本轮没有核对过视角，没有结论不等于没有问题",
        evidence: "读不到 config/pov.yaml；御书不替作者默认一个模式（限知还是全知是叙事选择，猜错会连带发一堆假警告）",
        fix: "在 config/pov.yaml 写下 mode（first / second / third_limited / third_omniscient / mixed）与 allowed_povs；不想被逐章要求绑定视角就如实选 third_omniscient。",
        origin: POV_CHECK_ORIGIN,
      },
    ];
  }

  const strict = input.strict ?? true;
  const known = new Set(input.characterIds);
  const allowed = config.allowed_povs !== undefined && config.allowed_povs.length > 0 ? new Set(config.allowed_povs) : null;
  const minGap = config.switch_policy?.min_gap_chapters;
  const requirePov = config.mode !== undefined && POV_REQUIRED_MODES.includes(config.mode);

  const chapters = [...input.chapters].sort(chapterOrder);
  const rows: PovFinding[] = [];
  /** 每个角色上一次担任视角的章序：切换预算只看相邻两次，跨三次的不重复报 */
  const lastIdxByPov = new Map<string, number>();

  for (const chapter of chapters) {
    const pov = chapter.pov.trim();
    if (isExempt(config.exemptions, chapter.chapterId)) continue;

    if (pov === "") {
      if (requirePov) {
        rows.push({
          rule: "pov-missing",
          severity: "warn",
          subject: chapter.chapterId,
          message: `「${chapter.title}」没有声明视角，而策略选的是限知模式（${config.mode}）`,
          evidence: `本章 frontmatter 缺 pov；config/pov.yaml 的 mode: ${config.mode} 要求每一章都知道是谁的眼睛`,
          fix: "在这一章的 frontmatter 补 pov: <角色 id>；楔子、序章这类要用全知开的，去 config/pov.yaml 的 exemptions 记一条 scope: chapter + id + reason（豁免必须写理由）。",
          origin: POV_CHECK_ORIGIN,
        });
      }
      continue;
    }

    rows.push(...judgeDeclaredPov(chapter, pov, { known, allowed }));

    if (minGap !== undefined) {
      const previous = lastIdxByPov.get(pov);
      if (previous !== undefined && chapter.idx - previous < minGap) {
        rows.push({
          rule: "pov-switch-gap",
          severity: strict ? "warn" : "info",
          subject: chapter.chapterId,
          message: `「${chapter.title}」又换回「${pov}」的视角，距上次只隔 ${String(chapter.idx - previous)} 章，比策略的 min_gap_chapters: ${String(minGap)} 还近`,
          evidence: `同一视角的两章章序为 ${String(previous)} → ${String(chapter.idx)}，间隔 ${String(chapter.idx - previous)} < ${String(minGap)}`,
          fix: "把两章之间插入别的视角，或在 config/pov.yaml 调小 min_gap_chapters（这是作者自己的预算，改它等于承认节奏就这样）；个例走 exemptions。",
          origin: POV_CHECK_ORIGIN,
        });
      }
      lastIdxByPov.set(pov, chapter.idx);
    }
  }

  // 顺序在这里就定了：按章序遍历，同一章内的多条按代码写死的先后，
  // 所以结论顺序只由章序决定，与调用方传进来的数组顺序无关（红线 5）。
  return rows;
}
