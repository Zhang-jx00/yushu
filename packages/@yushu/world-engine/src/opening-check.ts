/* SPDX-License-Identifier: Apache-2.0 */
import { BRIEF_KEYS } from "./outline.js";

/**
 * 黄金三章核对（M4 / T4-2 第五批，R104；纯函数，不碰 fs，也不读正文）。
 *
 * 判据逐条回源，不是这里发明的：
 * - **F02-网文连载结构.md:76**：「第 1 章：…具名角色 ≤3；新设定名词 ≤3」；
 * - **F02:79**：「前三章禁区：…POV 切换…」（联动 F04 的视角 lint）；
 * - **F11-开篇设计.md:21**：「黄金三章检查清单 → 开局模板内置逐章必填项（schema 见 §5），缺项黄牌」；
 * - **F02:76**「主角登场且给出代入锚点」：项目里**没有**「主角」这个字段（`@yushu/core` 的 EntityBase
 *   只有 type / layer / aliases），所以这条只能退化成"章上登记的视角角色在不在本章正文里露过面"，
 *   并且只给 **info**——它是提示，不是缺陷。
 *
 * **和 R103 的分工写死在这里**：「新设定名词 ≤3」不在本模块重复发一条。
 * R103 的 `vis-first-appearance-overload` 已经在按章序数"单章首次出现的设定卡"，阈值同为 3；
 * 同一件事发两个 id 只会让作者在一张表里看见两行同样的话，还会让豁免率被同一条问题摊薄。
 *
 * **明写不做的部分**（缺数据就少判，不假装能判）：
 * 「前 300 字内出现冲突或悬念」「大段设定说明」「闪回开局」「主角纯被动挨打超过 1 章」
 * 「金手指亮相」「长线期待」「第一个压抑→释放闭环」「章末钩子的强度分级」
 * ——前七条要读正文语义（AI 采样那一类），后一条要的字段根本不存在。
 * F02:80「第 1 卷主线须在第 3 章前挂出」也不判：`master.logline` 有没有填是**大纲**的事，
 * 而这条要的是"读者在第 3 章前有没有看见主线"，两回事，不许拿前者冒充后者。
 *
 * **结论落在章纲条目上**（subject = `co-*`）：开局窗口是大纲的判断单位，
 * 而 `open-brief-incomplete` 那一条本来就没有正文章可落；已建的草稿章放进 `related`，定位仍能找到文件。
 *
 * **`evidence` 必须自带全部关键信息**（R103 撞过的坑）：桌面侧的 `ReportFinding` 投影到全书体检表时
 * **没有 message 这一列**，只渲染 evidence / fix——写在 message 里的话等于没写。
 */

/** 四条 id 都要能被豁免清单认出来（覆盖锁扫源码里的 `rule: "…"` 字面量，漏一条就红） */
export const OPENING_RULE_IDS = [
  "open-cast-overload",
  "open-brief-incomplete",
  "open-pov-switch-early",
  "open-protagonist-absent",
] as const;

export type OpeningRuleId = (typeof OPENING_RULE_IDS)[number];
export type OpeningSeverity = "warn" | "info";

/** 结论出处：不是包规则，是御书拿作者自己登记的大纲 / 视角 / 提及扫出来的核对 */
export const OPENING_CHECK_ORIGIN = "御书黄金三章核对（F02 §5 检查规则 · F11 §3 开篇实践）";

/** F02 说的"前三章"——窗口给默认值，调用方可按自己书的开局长度覆盖 */
export const OPENING_WINDOW_CHAPTERS = 3;

/** F02:76 给的两个数：具名角色 ≤3（"新设定名词 ≤3" 由 R103 那条同阈值的规则负责，见文件头） */
export const OPENING_MAX_NAMED_CHARACTERS = 3;

/**
 * 章纲七要素的中文显示名。渲染层 `OutlineView.tsx` 的 `BRIEF_FIELDS` 里有**同一组字**，
 * 两边并存是因为分层（引擎进不了渲染层），漂移由 `opening-brief-labels.test.ts` 锁住。
 */
export const OPENING_BRIEF_LABELS: Record<(typeof BRIEF_KEYS)[number], string> = {
  who: "谁",
  where: "在哪",
  goal: "目标",
  obstacle: "阻碍",
  turn: "转折",
  result: "结果",
  hook: "钩子",
};

/** 该章正文里点名到的一位角色（调用方用提及扫描算：名字 + 别名最长匹配，不是关键词表） */
export interface OpeningMentionRow {
  id: string;
  name: string;
}

export interface OpeningChapterRow {
  /** 章纲条目 id（`co-*`）：结论的主体 */
  outlineId: string;
  title: string;
  /** 全局序（1 起）：调用方把各卷章纲按卷序 + 卷内 idx 摊平后给出 */
  order: number;
  /** 已回填的正文章 id（`ch-*`）；没有 = 这一章还没建草稿 ⇒ 正文类判据跳过它（没有正文可扫） */
  chapterId?: string;
  /** 章纲七要素；整个不给 = 大纲没写这条，缺项不判（那是"还没开始"，不是"写坏了"） */
  brief?: Partial<Record<(typeof BRIEF_KEYS)[number], string>>;
  /** 章 frontmatter 登记的视角角色 id（R102 的写入点） */
  pov?: string;
  /** 视角角色的显示名，只为让结论能说"谁" */
  povName?: string;
  /** 该章正文点到的角色；只有 `chapterId` 存在时才解释为"扫过了" */
  mentionedCharacters?: readonly OpeningMentionRow[];
}

export interface OpeningCheckInput {
  chapters: readonly OpeningChapterRow[];
  /** 第 1 章具名角色上限（默认 3，来自 F02:76） */
  maxNamedCharacters?: number;
  /** 开局窗口章数（默认 3，来自"黄金三章"本身） */
  window?: number;
}

export interface OpeningFinding {
  rule: OpeningRuleId;
  severity: OpeningSeverity;
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

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

/** 视角角色显示名：没给就退回 id，不替作者编一个名字 */
function povLabel(row: OpeningChapterRow, id: string): string {
  return trim(row.povName) !== "" ? trim(row.povName) : id;
}

function namedList(names: readonly string[]): string {
  const head = names.slice(0, 6);
  return head.join("、") + (names.length > head.length ? `…（共 ${String(names.length)} 位）` : "");
}

function chapterLabel(row: OpeningChapterRow): string {
  return `第 ${String(row.order)} 章「${row.title}」`;
}

export function checkOpening(input: OpeningCheckInput): OpeningFinding[] {
  const window = input.window ?? OPENING_WINDOW_CHAPTERS;
  const limit = input.maxNamedCharacters ?? OPENING_MAX_NAMED_CHARACTERS;
  const rows = input.chapters
    .filter((row) => Number.isInteger(row.order) && row.order >= 1 && row.order <= window)
    .sort((a, b) => a.order - b.order || byCodePoint(a.outlineId, b.outlineId));

  const findings: OpeningFinding[] = [];
  /** 开局窗口内"上一个登记了视角的那章"——换出就在换过来的那一章报，一条一个根因 */
  let previous: { outlineId: string; order: number; id: string; label: string } | null = null;

  for (const row of rows) {
    const pov = trim(row.pov);
    /** 正文类判据的前提：这一章真建了草稿。没草稿 ⇒ 没有正文可扫，判了就是拿空数组当证据 */
    const hasDraft = row.chapterId !== undefined && trim(row.chapterId) !== "";
    const mentioned = hasDraft ? (row.mentionedCharacters ?? []) : [];

    if (hasDraft && row.order === 1 && mentioned.length > limit) {
      findings.push({
        rule: "open-cast-overload",
        severity: "warn",
        subject: row.outlineId,
        related: row.chapterId,
        message: `${chapterLabel(row)}点到 ${String(mentioned.length)} 个具名角色，超过黄金三章给的 ${String(limit)} 个（F02 说的"群像开场"）`,
        evidence: `本章点到的具名角色共 ${String(mentioned.length)} 位（阈值 ${String(limit)}，出自 F02:76）：${namedList(mentioned.map((item) => item.name))}`,
        fix: "开头只留主角和当章的冲突对手，其余人物挪到后面的章再露面；确认是刻意的群像开局就写进 config/consistency.yaml 记豁免并填理由（阈值 3 出自 F02:76，工程上调用方也能用 maxNamedCharacters 覆盖）。",
        origin: OPENING_CHECK_ORIGIN,
      });
    }

    if (row.brief !== undefined) {
      const missing = BRIEF_KEYS.filter((key) => trim(row.brief?.[key]) === "");
      if (missing.length > 0) {
        findings.push({
          rule: "open-brief-incomplete",
          severity: "info",
          subject: row.outlineId,
          ...(row.chapterId === undefined ? {} : { related: row.chapterId }),
          message: `${chapterLabel(row)}的章纲还有 ${String(missing.length)} 项空着：${missing.map((key) => OPENING_BRIEF_LABELS[key]).join("、")}`,
          evidence: `章纲七要素（${BRIEF_KEYS.map((key) => `${OPENING_BRIEF_LABELS[key]} ${key}`).join(" / ")}）里空着的是：${missing.map((key) => `${OPENING_BRIEF_LABELS[key]}（${key}）`).join("、")}——开局窗口内 F11 要求逐章必填，缺的那几项正是让读者留下来的东西`,
          fix: "在大纲页把空着的几项补上（钩子那一项是章末追读钩，最别省）；这一章确实还没打算细写就当作提示忽略。",
          origin: OPENING_CHECK_ORIGIN,
        });
      }
    }

    if (pov !== "") {
      if (previous !== null && previous.id !== pov) {
        findings.push({
          rule: "open-pov-switch-early",
          severity: "warn",
          subject: row.outlineId,
          related: row.chapterId,
          message: `${chapterLabel(row)}把视角从「${previous.label}」换成了「${povLabel(row, pov)}」——前三章换视角是 F02 明写的开局禁区`,
          evidence: `开局窗口内上一处登记的视角：第 ${String(previous.order)} 章（${previous.outlineId}）=「${previous.label}」${previous.id}；本章 =「${povLabel(row, pov)}」${pov}。这条管的是"开局该不该换"，与 \`pov-switch-gap\` 管切换速度不是同一件事`,
          fix: "开局把镜头钉在主角身上，第二条视角线挪到读者已经认全人之后再开；确实要群像开局就记豁免并写理由（换视角那一章最好同时把人名交代清楚）。",
          origin: OPENING_CHECK_ORIGIN,
        });
      }
      previous = { outlineId: row.outlineId, order: row.order, id: pov, label: povLabel(row, pov) };
    }

    if (hasDraft && row.order === 1 && pov !== "" && mentioned.length > 0 && !mentioned.some((item) => item.id === pov)) {
      findings.push({
        rule: "open-protagonist-absent",
        severity: "info",
        subject: row.outlineId,
        related: row.chapterId,
        message: `${chapterLabel(row)}登记的视角是「${povLabel(row, pov)}」，但整章正文没出现他这个名字或别名`,
        evidence: `章上登记的视角是「${povLabel(row, pov)}」${pov}，而本章点到的具名角色是：${namedList(mentioned.map((item) => item.name))}——里面没有他（F02:76 要第 1 章就把主角亮出来）`,
        fix: "要么这一章的视角其实不是他（去视角看板改成真正出场的那位），要么开篇确实拿第一人称『我』进场、故意不点名——后者属正常，记豁免并写理由即可。",
        origin: OPENING_CHECK_ORIGIN,
      });
    }
  }

  return findings;
}
