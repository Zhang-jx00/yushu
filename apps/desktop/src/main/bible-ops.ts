/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError, codePointCompare } from "@yushu/core";
import {
  BIBLE_VISIBILITY_LEAK_RULE,
  assembleWorldBible,
  type BibleAssembly,
  type BibleCard,
} from "@yushu/export";
import { CARDS_DIR, WORLD_CONFIG_PATH, parseWorldConfig, readCardFile } from "@yushu/world-engine";
import { LAYER_ORDER, LAYER_TITLES } from "../shared/layer-titles.js";
import type {
  BibleEntryPayload,
  BibleLayerPayload,
  BiblePreviewPayload,
  BiblePreviewRequest,
  BibleRunPayload,
  BibleRunResult,
  BibleUnreadablePayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { EXPORTS_DIR, freeExportBase, sanitizeFileName, timeStamp } from "./export-ops.js";

/**
 * 世界圣经（设定集）一键导出的宿主侧（M5 / T5-5，R98）。
 *
 * 编排规则全在 `@yushu/export/bible.ts`（纯函数），这一层只干四件宿主该干的事：
 * ① 从 `world/cards/*.md` 读卡；② 读 `world/world.yaml` 决定默认选哪些层；
 * ③ 落盘前把"不该写的"拦住；④ 把结果整理成面板与回执能显示的形状。
 *
 * 两条与 R94 同一族的口径，写在这里是因为它们只能在宿主这侧成立：
 * **坏卡不静默丢掉**（读不了的卡进 `unreadable` 点名，其余照常编——悄悄少一张，
 * 作者会以为设定集里就是这么多）；**warn 不阻断**（K11 把可见性外泄定级 warn，
 * 所以照样产出，但回执与面板都要报出条数：安静地导出一份会剧透的设定集是最坏的结果，
 * 而"warn 就拒"又会让作者根本拿不到东西）。
 */

/** 预览返回的 markdown 上限（整本可能几十万字，面板只给前段，全文落盘才看得到） */
const PREVIEW_LIMIT = 6000;

interface BibleWorldView {
  bookTitle: string;
  /** 层级开关：没有 world.yaml 时全开（不猜作者关了哪层） */
  enabled: Record<string, boolean>;
}

async function readWorldView(gateway: ProjectGateway): Promise<BibleWorldView> {
  const snap = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snap) return { bookTitle: "", enabled: {} };
  const world = parseWorldConfig(snap.content);
  return {
    bookTitle: world.title,
    enabled: world.layers as unknown as Record<string, boolean>,
  };
}

interface CollectedCards {
  cards: BibleCard[];
  unreadable: BibleUnreadablePayload[];
  total: number;
}

/** 读全部设定卡；解析失败的卡**留着点名**，不当它不存在 */
export async function collectBibleCards(gateway: ProjectGateway): Promise<CollectedCards> {
  const tree = await gateway.listTree();
  const paths = tree
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.path.startsWith(`${CARDS_DIR}/`) &&
        entry.path.endsWith(".md"),
    )
    .map((entry) => entry.path)
    .sort(codePointCompare);

  const cards: BibleCard[] = [];
  const unreadable: BibleUnreadablePayload[] = [];
  for (const path of paths) {
    try {
      const snap = await gateway.readDoc(path);
      const { card, body } = readCardFile(snap.content);
      cards.push({
        path,
        id: card.id,
        type: card.type,
        name: card.name,
        layer: card.layer,
        visibility: card.visibility,
        aliases: card.aliases,
        sourceChapters: card.source_chapters,
        body,
      });
    } catch (err) {
      unreadable.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { cards, unreadable, total: paths.length };
}

function toEntryPayload(entry: {
  id: string;
  name: string;
  type: string;
  path: string;
  visibility: string;
  words: number;
}): BibleEntryPayload {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    path: entry.path,
    visibility: entry.visibility,
    words: entry.words,
  };
}

/** 编排一本设定集：读卡 + 定标题 + 定选取层，预览与落盘两条路共用这同一个函数 */
async function buildBible(
  gateway: ProjectGateway,
  request: BiblePreviewRequest,
): Promise<{
  world: BibleWorldView;
  collected: CollectedCards;
  assembly: BibleAssembly;
  selected: string[];
  layerRows: BibleLayerPayload[];
  title: string;
}> {
  const [world, collected] = await Promise.all([readWorldView(gateway), collectBibleCards(gateway)]);
  const cardsPerLayer = new Map<string, number>();
  for (const card of collected.cards) {
    cardsPerLayer.set(card.layer, (cardsPerLayer.get(card.layer) ?? 0) + 1);
  }

  // 默认选取 = 开着的层（docs/03 §5.1：未启用层不参与校验与传播，设定集同理默认不编）；
  // 但**显式选了就要编**——关层是"默认不编"，不是"不许编"。
  const requested = request.layers ?? [];
  const selected =
    requested.length > 0
      ? LAYER_ORDER.filter((layer) => requested.includes(layer))
      : LAYER_ORDER.filter((layer) => world.enabled[layer] !== false);

  const rawTitle = request.title?.trim() ?? "";
  const title =
    rawTitle !== ""
      ? rawTitle
      : world.bookTitle !== ""
        ? `${world.bookTitle} 设定集`
        : "设定集";

  const assembly = assembleWorldBible(collected.cards, {
    title,
    layers: selected,
    ...(request.maskUnrevealed === undefined ? {} : { maskUnrevealed: request.maskUnrevealed }),
    layerTitles: LAYER_TITLES as unknown as Readonly<Record<string, string>>,
  });

  const layerRows: BibleLayerPayload[] = LAYER_ORDER.map((layer) => ({
    key: layer,
    title: LAYER_TITLES[layer as keyof typeof LAYER_TITLES] ?? layer,
    cards: cardsPerLayer.get(layer) ?? 0,
    enabled: world.enabled[layer] !== false,
    selected: selected.includes(layer),
  }));

  return { world, collected, assembly, selected, layerRows, title };
}

/** 设定集预览（只读，不落盘） */
export async function previewBible(
  gateway: ProjectGateway,
  request: BiblePreviewRequest,
): Promise<BiblePreviewPayload> {
  const { world, collected, assembly, layerRows, title } = await buildBible(gateway, request);
  const full = assembly.markdown;
  return {
    title,
    bookTitle: world.bookTitle,
    sections: assembly.sections.map((section) => ({
      layer: section.layer,
      heading: section.heading,
      entries: section.entries.map(toEntryPayload),
    })),
    layers: layerRows,
    included: assembly.included,
    excludedByLayer: assembly.excludedByLayer,
    masked: assembly.masked.map(toEntryPayload),
    findings: assembly.findings,
    wordCount: assembly.wordCount,
    cardTotal: collected.total,
    unreadable: collected.unreadable,
    markdown: full.length > PREVIEW_LIMIT ? `${full.slice(0, PREVIEW_LIMIT)}\n…（预览截断，全文见落盘产物）` : full,
    truncated: full.length > PREVIEW_LIMIT,
    maskUnrevealed: request.maskUnrevealed === true,
    error: assembly.error,
  };
}

/**
 * 设定集落盘（写 `exports/<书名> 设定集-<时间>.md`）。
 *
 * 落笔前的三道闸：没确认 ⇒ 拒；引擎说不清 ⇒ 拒；一条都编不出来 ⇒ 拒。
 * 三道都在 `writeDoc` 之前，所以项目里不会出现"半本设定集"。
 */
export async function runBibleExport(
  gateway: ProjectGateway,
  payload: BibleRunPayload,
): Promise<BibleRunResult> {
  if (payload.confirmed !== true) {
    throw new YushuError(
      "E_CONFIRM_REQUIRED",
      "导出设定集前需显式确认：请先核对条目数 / 略过条数 / 未揭示条数，再点击「导出设定集」",
    );
  }
  const { collected, assembly, selected, title } = await buildBible(gateway, payload);
  if (assembly.error !== null) {
    throw new YushuError(
      "E_BIBLE_UNASSEMBLABLE",
      `设定集没能编排出来：${assembly.error}（未落笔，项目里不会留下半成品）`,
    );
  }
  if (assembly.included === 0) {
    throw new YushuError(
      "E_BIBLE_EMPTY",
      "没有可编入设定集的条目：请先建设定卡，或放宽层级选取 / 取消脱敏（未落笔，项目里不会留下空产物）",
    );
  }

  const base = `${sanitizeFileName(title)}-${timeStamp()}`;
  const named = await freeExportBase(gateway, base, ["md"]);
  const path = `${EXPORTS_DIR}/${named}.md`;
  const hash = (await gateway.writeDoc(path, assembly.markdown)).hash;

  return {
    path,
    hash,
    title,
    included: assembly.included,
    wordCount: assembly.wordCount,
    maskedCount: assembly.masked.length,
    leakCount: assembly.findings.filter((row) => row.rule === BIBLE_VISIBILITY_LEAK_RULE).length,
    // 读不了的卡数必须进回执：只报"编了几条"会让作者以为设定集完整
    unreadableCount: collected.unreadable.length,
    maskUnrevealed: payload.maskUnrevealed === true,
    layers: selected,
  };
}
