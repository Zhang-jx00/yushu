import { LAYER_KEYS, type LayerKey } from "@yushu/core";
import { loadPackTaboos } from "@yushu/genre-engine";
import type { ChatMessage } from "@yushu/llm";
import {
  OUTLINE_PATH,
  PROJECT_CONFIG_PATH,
  WORLD_CONFIG_PATH,
  chapterPath,
  parseOutline,
  parseProjectConfig,
  parseWorldConfig,
  readCardFile,
  readChapterFile,
  type OutlineChapter,
  type OutlineVolume,
} from "@yushu/world-engine";
import type { ContextPreviewPayload, ContextSlotPayload, DraftHintPayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { loadPacksByIds } from "./project-ops.js";

/**
 * 世界约束注入与上下文组装（T1-13 / T1-14 的最小实现）：
 * - 稳定前缀（system_prompt → world_core → world_constraints）置头，易变槽位置尾，
 *   对齐包内 prompt 模板 `cache.breakpoint_after: world_constraints`（J02，为 M3 prompt caching 预留）；
 * - 槽位带 source / chars / truncated，供上下文预览器展示"真实发给模型的内容"（J03）；
 * - analyzeDraft 为生成后的轻提示启发（重型规则校验留待 M4）。
 * M3 将升级为 @yushu/memory 的分层记忆与 Token 预算；M1 以字符数作粗预算。
 */

/** 槽位粗预算（字符；M3 替换为 token 预算） */
const SLOT_CAPS: Record<string, number> = {
  system_prompt: 1200,
  world_core: 3000,
  world_constraints: 1600,
  outline_chapter: 1500,
  recent_prose: 2000,
};

const STABLE_SLOTS = ["system_prompt", "world_core", "world_constraints"] as const;

interface CardDetail {
  id: string;
  name: string;
  aliases: string[];
  layer: string;
  visibility: string;
  type: string;
  body: string;
}

function truncate(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: `${text.slice(0, cap)}\n……（已按 M1 粗预算截断）`, truncated: true };
}

/** 读取全部设定卡（含正文，供 world_core 槽位与轻提示使用），按世界层级自上而下排序 */
export async function readAllCards(gateway: ProjectGateway): Promise<CardDetail[]> {
  const tree = await gateway.listTree();
  const paths = tree
    .filter(
      (entry) =>
        entry.type === "file" && entry.path.startsWith("world/cards/") && entry.path.endsWith(".md"),
    )
    .map((entry) => entry.path);

  const cards: CardDetail[] = [];
  for (const path of paths) {
    try {
      const snapshot = await gateway.readDoc(path);
      const { card, body } = readCardFile(snapshot.content);
      cards.push({
        id: card.id,
        name: card.name,
        aliases: card.aliases,
        layer: card.layer,
        visibility: card.visibility,
        type: card.type,
        body,
      });
    } catch {
      // 解析失败的单卡跳过（世界观档案中仍可见并可修复）
    }
  }
  const layerOrder = (layer: string) => {
    const index = LAYER_KEYS.indexOf(layer as LayerKey);
    return index === -1 ? LAYER_KEYS.length : index;
  };
  return cards.sort((a, b) => layerOrder(a.layer) - layerOrder(b.layer) || a.name.localeCompare(b.name, "zh"));
}

/** 收集派系包禁忌与规则文件清单（约束文本来源） */
async function collectPackConstraints(packIds: string[]): Promise<{ taboos: string[]; ruleFiles: string[] }> {
  if (packIds.length === 0) return { taboos: [], ruleFiles: [] };
  const taboos: string[] = [];
  const ruleFiles: string[] = [];
  try {
    const packs = await loadPacksByIds(packIds);
    for (const pack of packs) {
      taboos.push(...loadPackTaboos(pack).map((item) => item.desc));
      for (const file of pack.resolvedFiles["rules"] ?? []) {
        ruleFiles.push(file.split(/[\\/]/).pop() ?? file);
      }
    }
  } catch {
    // 包加载失败时约束槽位降级为内置硬约束
  }
  return { taboos, ruleFiles };
}

export interface ContextTarget {
  volumeId: string;
  chapterId: string;
}

interface TargetInfo {
  volume: OutlineVolume;
  chapter: OutlineChapter;
  chapterPath: string;
  hasProse: boolean;
  prose: string;
}

async function findTarget(gateway: ProjectGateway, target: ContextTarget): Promise<TargetInfo> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snapshot.content);
  const volume = outline.volumes.find((item) => item.id === target.volumeId);
  if (!volume) throw new Error(`找不到卷纲：${target.volumeId}`);
  const chapter = volume.chapters.find((item) => item.id === target.chapterId);
  if (!chapter) throw new Error(`找不到章纲：${target.chapterId}`);
  // 章节路径用 Chapter 实体 ID（chapter_id）推导；未回填时视为尚未创建草稿章节
  const path = chapter.chapter_id ? chapterPath(volume.id, chapter.chapter_id) : "";
  const file = path ? await gateway.readDoc(path).catch(() => null) : null;
  const prose = file ? readChapterFile(file.content).body : "";
  return { volume, chapter, chapterPath: path, hasProse: prose.trim() !== "", prose };
}

/**
 * 组装上下文槽位（固定顺序 + 粗预算裁剪）。
 * 返回结构即"上下文预览器"的数据源（槽位 / 来源 / 字符数 / 是否截断）。
 */
export async function buildContextPreview(
  gateway: ProjectGateway,
  target?: ContextTarget,
): Promise<ContextPreviewPayload> {
  const worldSnap = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  const world = worldSnap ? parseWorldConfig(worldSnap.content) : null;
  const projectSnap = await gateway.readDoc(PROJECT_CONFIG_PATH).catch(() => null);
  const packIds = projectSnap ? parseProjectConfig(projectSnap.content).genre.packs : [];
  const cards = await readAllCards(gateway);
  const { taboos, ruleFiles } = await collectPackConstraints(packIds);
  const targetInfo = target ? await findTarget(gateway, target) : null;

  const worldTitle = world?.title ?? "未命名作品";
  const axes = world?.genre_axes;
  const romance = axes?.romance_mode_default ? `，感情线：${axes.romance_mode_default}` : "";

  const slots: ContextSlotPayload[] = [];

  // 1) system_prompt（stable）
  slots.push({
    slot: "system_prompt",
    stable: true,
    source: "内置写作助手人设 + 四维题材",
    ...build("system_prompt", () =>
      [
        `你是《${worldTitle}》的写作助手。严格遵守世界约束：不得越级战斗、不得引入设定外实体、不得说破"已写未揭示"的设定（冰山原则）。`,
        axes
          ? `题材：${axes.channel.join("+")} · ${axes.world.join("+")} · ${axes.technique.join("+")}；基调：${axes.tone.join("+")}${romance}`
          : "",
        "输出要求：只输出正文，不要解释、不要复述设定原文。",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  });

  // 2) world_core（stable）：设定卡按层级自上而下（常驻注入最小版）
  const cardLines = cards.map((card) => {
    const alias = card.aliases.length > 0 ? `（别名：${card.aliases.join("、")}）` : "";
    const excerpt = card.body.replace(/\s+/g, " ").trim().slice(0, 160);
    return `【${card.type}｜${card.layer}】${card.name}${alias}${excerpt ? `：${excerpt}` : ""}`;
  });
  slots.push({
    slot: "world_core",
    stable: true,
    source: `world.yaml + ${cards.length} 张设定卡`,
    ...build("world_core", () => (cardLines.length > 0 ? cardLines.join("\n") : "（尚无设定卡）")),
  });

  // 3) world_constraints（stable）：派系包禁忌 + 规则包 + 层级开关提示（T1-14 约束文本）
  const constraints: string[] = [
    "不得越级战斗、不得引入设定外实体",
    "不得说破 visibility=hidden 的设定（冰山原则）",
    ...taboos.map((item) => `派系包禁忌：${item}`),
  ];
  const closedLayers = world
    ? (Object.entries(world.layers) as [string, boolean][])
        .filter(([, enabled]) => !enabled)
        .map(([layer]) => layer)
    : [];
  const constraintLines = [
    ...constraints,
    ...(ruleFiles.length > 0 ? [`生效规则包：${ruleFiles.join("、")}（一致性引擎 M4 接入）`] : []),
    ...(closedLayers.length > 0
      ? [`未启用层级：${closedLayers.join("、")}——本世界不存在该层设定，禁止引用`]
      : []),
  ];
  slots.push({
    slot: "world_constraints",
    stable: true,
    source: `派系包 taboos ${taboos.length} 条 + 层级开关`,
    ...build("world_constraints", () => constraintLines.join("\n")),
  });

  // 4) outline_chapter（unstable）：本章细纲（七要素）
  if (targetInfo) {
    const { volume, chapter } = targetInfo;
    const brief = chapter.brief;
    const briefLines = (
      [
        ["谁", brief.who],
        ["在哪", brief.where],
        ["目标", brief.goal],
        ["阻碍", brief.obstacle],
        ["转折", brief.turn],
        ["结果", brief.result],
        ["钩子", brief.hook],
      ] as const
    )
      .filter(([, value]) => value.trim() !== "")
      .map(([label, value]) => `${label}：${value}`);
    slots.push({
      slot: "outline_chapter",
      stable: false,
      source: `章纲 ${chapter.id}（${volume.title}·${volume.act}）`,
      ...build("outline_chapter", () =>
        [
          `【所属卷】${volume.title}（${volume.act}）${volume.climax ? `｜卷末高潮：${volume.climax}` : ""}${volume.hook ? `｜卷末钩子：${volume.hook}` : ""}`,
          `【本章】${chapter.title}`,
          ...(briefLines.length > 0 ? briefLines : ["（本章细纲尚未填写，请在三级大纲中补充七要素）"]),
        ].join("\n"),
      ),
    });
  } else {
    slots.push({
      slot: "outline_chapter",
      stable: false,
      source: "未选择章纲",
      chars: 0,
      truncated: false,
      text: "",
    });
  }

  // 5) recent_prose（unstable）：已有正文尾部（衔接用）
  const prose = targetInfo?.prose ?? "";
  const tail = prose.length > SLOT_CAPS["recent_prose"]! ? prose.slice(-SLOT_CAPS["recent_prose"]!) : prose;
  slots.push({
    slot: "recent_prose",
    stable: false,
    source: targetInfo ? `${targetInfo.chapterPath}（${prose.length} 字）` : "未选择章节",
    chars: tail.length,
    truncated: prose.length > tail.length,
    text: tail,
  });

  const stableChars = slots
    .filter((slot) => slot.stable)
    .reduce((sum, slot) => sum + slot.chars, 0);
  const totalChars = slots.reduce((sum, slot) => sum + slot.chars, 0);

  return {
    slots,
    stableChars,
    totalChars,
    cacheBreakpointAfter: "world_constraints",
    worldTitle,
    layers: world ? (world.layers as unknown as Record<string, boolean>) : {},
    cardIndex: cards.map((card) => ({
      id: card.id,
      name: card.name,
      aliases: card.aliases,
      visibility: card.visibility,
      layer: card.layer,
    })),
    constraints,
    ...(targetInfo
      ? {
          target: {
            volumeId: targetInfo.volume.id,
            chapterId: targetInfo.chapter.id,
            title: targetInfo.chapter.title,
            chapterPath: targetInfo.chapterPath,
            hasProse: targetInfo.hasProse,
          },
        }
      : {}),
  };
}

function build(slot: string, compose: () => string): Pick<ContextSlotPayload, "text" | "chars" | "truncated"> {
  const { text, truncated } = truncate(compose(), SLOT_CAPS[slot] ?? 2000);
  return { text, chars: text.length, truncated };
}

export interface DraftTask {
  kind: "draft-first" | "continue";
  instruction?: string;
  targetWords?: number;
}

/**
 * 组装 chat messages：稳定前缀独立成 system 消息置头（prompt caching 断点后不再变动），
 * 易变上下文与任务指令进 user 消息（对齐包内 prompts/continue.yaml 的槽位顺序）。
 */
export function assembleMessages(preview: ContextPreviewPayload, task: DraftTask): ChatMessage[] {
  const slotText = (name: string) => preview.slots.find((slot) => slot.slot === name)?.text ?? "";
  const stablePrefix = STABLE_SLOTS.map((name) => slotText(name))
    .filter((text) => text.trim() !== "")
    .join("\n\n");

  const targetWords = task.targetWords ?? 2000;
  const outline = slotText("outline_chapter");
  const recent = slotText("recent_prose");
  const taskText = [
    `【本章细纲】\n${outline || "（未提供细纲）"}`,
    recent.trim() !== "" ? `【最近正文（供衔接，禁止重复照抄）】\n${recent}` : "",
    task.kind === "continue"
      ? `【任务】沿最近正文续写约 ${targetWords} 字，衔接自然，结尾留下追读钩子。`
      : `【任务】按本章细纲写出本章初稿约 ${targetWords} 字，结尾留下追读钩子。`,
    task.instruction?.trim() ? `【附加要求】${task.instruction.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: stablePrefix },
    { role: "user", content: taskText },
  ];
}

/**
 * 生成后的轻提示启发（T1-14 最小版；重型规则校验留待 M4）：
 * - 命中 visibility=hidden 的设定卡名 → 疑似提前揭示（冰山原则）；
 * - 命中已关闭层级的设定卡名 → 引用了本世界不存在的层级；
 * - 未引用任何设定卡 → 提醒人工确认是否符合世界约束。
 */
export function analyzeDraft(
  text: string,
  cardIndex: ContextPreviewPayload["cardIndex"],
  layers: Record<string, boolean>,
): DraftHintPayload {
  const referenced: string[] = [];
  const hints: string[] = [];

  for (const card of cardIndex) {
    const names = [card.name, ...card.aliases].filter((name) => name.trim() !== "");
    if (!names.some((name) => text.includes(name))) continue;
    referenced.push(card.name);
    if (card.visibility === "hidden") {
      hints.push(`疑似提前揭示隐藏设定「${card.name}」（visibility=hidden，请人工确认冰山原则）`);
    }
    if (layers[card.layer] === false) {
      hints.push(`引用了已关闭层级的设定「${card.name}」（layer=${card.layer} 在本世界未启用）`);
    }
  }

  if (referenced.length === 0) {
    hints.push("输出未引用任何已建档设定，请人工确认是否符合世界约束");
  }
  return { referenced, hints };
}