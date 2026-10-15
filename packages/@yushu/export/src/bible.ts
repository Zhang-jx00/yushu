/* SPDX-License-Identifier: Apache-2.0 */
import {
  LAYER_KEYS,
  VISIBILITIES,
  codePointCompare,
  countWords,
  type Visibility,
} from "@yushu/core";

/**
 * 世界圣经（设定集）自动汇编（M5 / T5-5，R98）。纯函数，不碰 fs——
 * 读卡与落盘由宿主 `apps/desktop/src/main/bible-ops.ts` 负责（与 assemble.ts 同一分工）。
 *
 * 判据出处 docs/research/K11-导出与发布.md（§2.5 / §3.6 / 规则草案）：
 * 「把设定卡汇编为设定集：**按世界构建金字塔层级编排目录**、实体卡转章节、**按叙事可见性脱敏**」，
 * 规则 `export-bible-visibility-leak`＝"设定集导出含『叙事可见性=未揭示』条目且未勾选脱敏 → warn"。
 * K11 还写了"关系图 / 时间线 / 地图作插图"与"设定集导读 / 术语索引"——**本轮没做**，
 * 因为插图需要图谱先出图、导读需要 AI 生成，都不该在这里假装完成（留给后续轮并在台账写明）。
 *
 * 三条口径是本文件的裁决（不是 K11 原文），改它们要连同测试与 docs/04 的注记一起改：
 * ① **层内顺序取码点序**（`codePointCompare`，红线 5）。设定集是要落盘复跑的工件，
 *    "同一份卡重跑两次逐字一致"比"按拼音排得好看"重要；也因此这里不许出现 `localeCompare`。
 * ② **脱敏＝整条不进**，连条目名都不出。"这里有 1 条隐藏设定"这句话本身就是剧透，
 *    所以产物里既不写名字也不写条数；被剔除的清单只回到应用（作者看得见，外发物里看不见）。
 * ③ **除 `revealed` 外都算未揭示**，含 `foreshadowed`——伏笔是"埋着"不是"揭示过"。
 */

/** K11 规则草案里的规则 id（进体检报告与豁免清单时用它） */
export const BIBLE_VISIBILITY_LEAK_RULE = "export-bible-visibility-leak";

/** 未揭示的可见性取值（③ 那条口径的落点；与 core 的枚举对照，多一个少一个都要红） */
export const BIBLE_UNREVEALED_VISIBILITIES: readonly Visibility[] = [
  "written_unrevealed",
  "foreshadowed",
  "hidden",
];

/** 调用方没给书名时的标题：不留空标题，也不猜一个项目名 */
export const BIBLE_DEFAULT_TITLE = "设定集";

/** 一张设定卡的汇编输入（主进程从 `world/cards/*.md` 读出来后传进来） */
export interface BibleCard {
  /** 项目内相对路径，用于点名（warn 的 related、应用的跳转） */
  path: string;
  id: string;
  type: string;
  name: string;
  /** 必须是 `LAYER_KEYS` 之一；不认识就整本拒编 */
  layer: string;
  /** 必须是 `VISIBILITIES` 之一；脱敏判定靠它，不能默认放行 */
  visibility: string;
  aliases: readonly string[];
  sourceChapters: readonly string[];
  body: string;
}

export interface BibleAssemblyOptions {
  /** 设定集标题（一般传书名；空或不给 ⇒ `BIBLE_DEFAULT_TITLE`） */
  title?: string;
  /** 层级选取：不给＝全部十一层；给了就是"只导这几层" */
  layers?: readonly string[];
  /** 脱敏开关：true ⇒ 未揭示条目整条不进产物 */
  maskUnrevealed?: boolean;
  /** 层级显示名（展示口径归应用；引擎不发明中文名，缺省回退层键） */
  layerTitles?: Readonly<Record<string, string>>;
}

export interface BibleEntry {
  id: string;
  name: string;
  type: string;
  path: string;
  visibility: string;
  /** 正文字数（去空白字符数，与导出对账同口径） */
  words: number;
}

export interface BibleSection {
  layer: string;
  /** 章节标题：`layerTitles[layer]` 或层键 */
  heading: string;
  entries: BibleEntry[];
}

export interface BibleFinding {
  rule: string;
  severity: "warn";
  message: string;
  /** 指向出问题的卡文件 */
  related: string;
}

export interface BibleAssembly {
  markdown: string;
  sections: BibleSection[];
  /** 进了产物的条目数 */
  included: number;
  /** 因层级选取被排除的卡数（应用要显示，不能让用户以为"没了"） */
  excludedByLayer: number;
  /** 因脱敏被剔除的条目（只回给应用，不进产物） */
  masked: BibleEntry[];
  findings: BibleFinding[];
  wordCount: number;
  error: string | null;
}

function isUnrevealed(visibility: string): boolean {
  return BIBLE_UNREVEALED_VISIBILITIES.includes(visibility as Visibility);
}

function rejected(reason: string): BibleAssembly {
  return {
    markdown: "",
    sections: [],
    included: 0,
    excludedByLayer: 0,
    masked: [],
    findings: [],
    wordCount: 0,
    error: reason,
  };
}

function toEntry(card: BibleCard): BibleEntry {
  return {
    id: card.id,
    name: card.name,
    type: card.type,
    path: card.path,
    visibility: card.visibility,
    words: countWords(card.body.trim()),
  };
}

/** 层内排序：类型 → 名称 → ID，全部码点序（同输入同序，改名会重排，改 ID 不会） */
function byCardOrder(a: BibleCard, b: BibleCard): number {
  return (
    codePointCompare(a.type, b.type) ||
    codePointCompare(a.name, b.name) ||
    codePointCompare(a.id, b.id)
  );
}

function renderEntry(card: BibleCard): string[] {
  const lines: string[] = [`### ${card.name}`, "", `- 类型：${card.type}`, `- ID：${card.id}`];
  const aliases = card.aliases.map((alias) => alias.trim()).filter((alias) => alias !== "");
  if (aliases.length > 0) lines.push(`- 别名：${aliases.join("、")}`);
  const sources = card.sourceChapters.map((item) => item.trim()).filter((item) => item !== "");
  if (sources.length > 0) lines.push(`- 出场：${sources.join("、")}`);
  const body = card.body.trim();
  lines.push("", body === "" ? "（本卡无正文）" : body);
  return lines;
}

/** 渲染用的节：结构与 `BibleSection` 同形，多带一份已经排好版的行 */
interface RenderSection extends BibleSection {
  lines: string[];
}

function renderMarkdown(title: string, sections: readonly RenderSection[]): string {
  const out: string[] = [`# ${title}`, ""];
  if (sections.length === 0) {
    out.push("（本项目暂无设定卡：设定集里没有条目。）", "");
    return out.join("\n");
  }
  for (const section of sections) {
    out.push(`## ${section.heading}`, "", ...section.lines, "");
  }
  return out.join("\n");
}

/**
 * 汇编一本设定集。
 *
 * 任何"说不清"的情形都返回 `error` 且不产出 markdown（跟 `parsePowerLog` 同一口径）：
 * 层级不认识、可见性不认识、同一张卡进两次、选取清单里有不存在的层——
 * 硬凑一本出来会让"编不出来"看起来像"编好了"，那是最坏的一种安静。
 */
export function assembleWorldBible(
  cards: readonly BibleCard[],
  options: BibleAssemblyOptions = {},
): BibleAssembly {
  const rawTitle = options.title?.trim() ?? "";
  const title = rawTitle === "" ? BIBLE_DEFAULT_TITLE : rawTitle;
  const maskUnrevealed = options.maskUnrevealed === true;
  const layerTitles = options.layerTitles ?? {};

  let selected: readonly string[] = LAYER_KEYS;
  if (options.layers !== undefined) {
    const unknown = options.layers.filter((layer) => !(LAYER_KEYS as readonly string[]).includes(layer));
    if (unknown.length > 0) {
      return rejected(
        `层级选取里有不认识的层级「${unknown[0]}」：可选的是 ${LAYER_KEYS.join(" / ")}（静默忽略等于少导一层，所以整本不编）`,
      );
    }
    selected = options.layers;
  }
  const selectedSet = new Set(selected);

  const seenIds = new Map<string, string>();
  for (const card of cards) {
    if (!(LAYER_KEYS as readonly string[]).includes(card.layer)) {
      return rejected(
        `设定卡「${card.name}」（${card.path}）的层级「${card.layer}」不在世界构建的十一层里：目录靠层级编排，不猜它该排哪儿`,
      );
    }
    if (!(VISIBILITIES as readonly string[]).includes(card.visibility)) {
      return rejected(
        `设定卡「${card.name}」（${card.path}）的可见性「${card.visibility}」不是 ${VISIBILITIES.join(" / ")} 之一：脱敏判定靠这个字段，默认放行等于把隐藏设定当已揭示`,
      );
    }
    const previous = seenIds.get(card.id);
    if (previous !== undefined) {
      return rejected(
        `设定 ID「${card.id}」出现两次（${previous} 与 ${card.path}）：同一张卡在设定集里出现两遍，读者会当成两处设定`,
      );
    }
    seenIds.set(card.id, card.path);
  }

  const renderSections: RenderSection[] = [];
  const findings: BibleFinding[] = [];
  const masked: BibleEntry[] = [];
  let excludedByLayer = 0;
  let included = 0;
  let wordCount = 0;

  for (const layer of LAYER_KEYS) {
    if (!selectedSet.has(layer)) continue;
    const inLayer = cards.filter((card) => card.layer === layer).sort(byCardOrder);
    if (inLayer.length === 0) continue;
    const entries: BibleEntry[] = [];
    const lines: string[] = [];
    for (const card of inLayer) {
      const entry = toEntry(card);
      if (maskUnrevealed && isUnrevealed(card.visibility)) {
        masked.push(entry);
        continue;
      }
      if (isUnrevealed(card.visibility)) {
        findings.push({
          rule: BIBLE_VISIBILITY_LEAK_RULE,
          severity: "warn",
          related: card.path,
          message:
            `设定集含未揭示条目「${card.name}」（visibility=${card.visibility}）且没勾选脱敏：` +
            `这份设定集一旦外发就等于提前揭示。要外发就勾「按可见性脱敏」，确定要留就当作明知`,
        });
      }
      entries.push(entry);
      lines.push(...renderEntry(card));
      included += 1;
      wordCount += entry.words;
    }
    // 整层都被脱敏掉了 ⇒ 目录里不留空章节（空章节会泄露"这层本来有东西"）
    if (entries.length === 0) continue;
    renderSections.push({ layer, heading: layerTitles[layer] ?? layer, entries, lines });
  }

  const sections: BibleSection[] = renderSections.map(({ layer, heading, entries }) => ({
    layer,
    heading,
    entries,
  }));

  for (const card of cards) {
    if (!selectedSet.has(card.layer)) excludedByLayer += 1;
  }

  return {
    markdown: renderMarkdown(title, renderSections),
    sections,
    included,
    excludedByLayer,
    masked,
    findings,
    wordCount,
    error: null,
  };
}
