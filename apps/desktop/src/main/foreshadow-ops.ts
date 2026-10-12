import { buildForeshadowBoard, parseForeshadowLedger, FORESHADOW_PATH } from "@yushu/world-engine";
import type { ForeshadowBoardPayload } from "../shared/ipc.js";
import { readOutlineSafe } from "./doc-readers.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 伏笔台账的桌面接线（M4 / T4-6，R66）：**只读**。
 *
 * 判定全在引擎（`world-engine/foreshadow.ts`），这里只做三件事：读 `world/foreshadow.yaml`、
 * 从三级大纲拿**有序章清单**、把看板投影成可序列化载荷。所以通道走 `wrap` 而不是 `wrapWrite`
 * ——真源没动，索引与一致性结论都不该因此过期（R59 那道写通道源码锁同时管"该用的"和"不该用的"两侧）。
 *
 * 两条不静默：
 * - 台账**读不了**（严格解析拒了未知键 / 非法枚举 / 重复 id）⇒ 如实给 note 并**不出结论**，
 *   不退回"空台账"——那等于把作者的 12 条伏笔显示成 0 条；
 * - 章清单为空 ⇒ 交给引擎报 `fs-no-chapters`，不自己编一个进度。
 */

const EMPTY_STATS: Record<string, number> = {
  total: 0,
  open: 0,
  closed: 0,
  planted: 0,
  reinforced: 0,
  due: 0,
  paid: 0,
  abandoned: 0,
  redHerring: 0,
  overdue: 0,
};

/** 有序章清单：已建草稿的章用 chapter_id，没建的用章纲 id（顺序就是叙事顺序，不重排） */
async function chapterOrder(gateway: ProjectGateway): Promise<string[]> {
  const outline = await readOutlineSafe(gateway);
  if (!outline) return [];
  const out: string[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) out.push(chapter.chapter_id ?? chapter.id);
  }
  return out;
}

export async function foreshadowBoard(gateway: ProjectGateway): Promise<ForeshadowBoardPayload> {
  const chapters = await chapterOrder(gateway);
  const currentChapter: string | null = chapters.length > 0 ? (chapters[chapters.length - 1] ?? null) : null;
  const snapshot = await gateway.readDoc(FORESHADOW_PATH).catch(() => null);
  if (snapshot === null) {
    return {
      path: FORESHADOW_PATH,
      exists: false,
      note: "项目还没有伏笔台账：登记一条（id / promise / 埋设章 / 预期回收章）才谈得上未回收看板",
      chapterTotal: chapters.length,
      currentChapter,
      rows: [],
      findings: [],
      stats: { ...EMPTY_STATS },
    };
  }
  let ledger;
  try {
    ledger = parseForeshadowLedger(snapshot.content);
  } catch (err) {
    return {
      path: FORESHADOW_PATH,
      exists: true,
      note: `台账读不了，本次不出结论（不静默按空台账显示）：${err instanceof Error ? err.message : String(err)}`,
      chapterTotal: chapters.length,
      currentChapter,
      rows: [],
      findings: [],
      stats: { ...EMPTY_STATS },
    };
  }
  const board = buildForeshadowBoard(ledger, { chapters });
  return {
    path: FORESHADOW_PATH,
    exists: true,
    note: `读到 ${ledger.entries.length} 条伏笔；当前进度按最后一章「${currentChapter ?? "（无章）"}」算`,
    chapterTotal: chapters.length,
    currentChapter,
    rows: board.rows,
    findings: board.findings,
    stats: board.stats,
  };
}
