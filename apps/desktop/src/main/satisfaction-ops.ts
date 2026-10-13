import {
  SATISFACTION_PATH,
  buildSatisfactionBoard,
  parseSatisfactionFile,
  type SatisfactionThresholds,
} from "@yushu/world-engine";
import type { SatisfactionBoardPayload, SatisfactionBoardRequestPayload } from "../shared/ipc.js";
import { readOutlineSafe } from "./doc-readers.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 爽点与期待感看板的桌面接线（M4 / T4-10，R73）：**只读，且只读真源**。
 *
 * 判定全在引擎（`world-engine/satisfaction.ts`），这里只做三件事：读 `world/satisfaction.yaml`、
 * 从三级大纲拿**有序章清单**、把看板投影成可序列化载荷。通道走 `wrap`——真源没动。
 *
 * 两条不静默：
 * - 台账读不了（严格解析拒了未知键 / 非法枚举 / 越界 intensity）⇒ 给 note 并**不出结论**，
 *   不退回"空台账"：那等于把作者的 20 个爽点显示成 0 个，然后告诉作者"没有节奏问题"；
 * - 阈值不传 ⇒ 引擎把对应规则放进 `notEvaluated`，面板照原样列出，**不拿默认值冒充定标**。
 */

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

const EMPTY = {
  hits: 0,
  scenes: 0,
  advanceRate: null,
  openPromises: 0,
  strongestStreak: 0,
} as const;

function pickThresholds(raw: SatisfactionThresholdsPayloadInput | undefined): SatisfactionThresholds | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: SatisfactionThresholds = {};
  for (const key of [
    "same_type_streak_max",
    "release_interval_max",
    "strong_intensity",
    "suppress_streak_max",
    "promise_open_max",
    "no_advance_streak",
  ] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      (out as unknown as Record<string, number>)[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type SatisfactionThresholdsPayloadInput = Record<string, unknown> | undefined;

export async function satisfactionBoard(
  gateway: ProjectGateway,
  request: SatisfactionBoardRequestPayload = {},
): Promise<SatisfactionBoardPayload> {
  const chapters = await chapterOrder(gateway);
  const currentChapter: string | null =
    request.currentChapter ?? (chapters.length > 0 ? (chapters[chapters.length - 1] ?? null) : null);
  const base = {
    path: SATISFACTION_PATH,
    chapterTotal: chapters.length,
    currentChapter,
    rows: [],
    promises: [],
    findings: [],
    notEvaluated: [],
    stats: { ...EMPTY },
  };
  const snapshot = await gateway.readDoc(SATISFACTION_PATH).catch(() => null);
  if (snapshot === null) {
    return {
      ...base,
      exists: false,
      note: "项目还没有爽点台账：登记爽点（哪一章、什么类型、强度几）与承诺清单，才谈得上期待感曲线",
    };
  }
  let ledger;
  try {
    ledger = parseSatisfactionFile(snapshot.content);
  } catch (err) {
    return {
      ...base,
      exists: true,
      note: `台账读不了，本次不出结论（不静默按空台账显示）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const thresholds = pickThresholds(request.thresholds as SatisfactionThresholdsPayloadInput);
  const board = buildSatisfactionBoard(ledger, {
    chapters,
    ...(currentChapter === null ? {} : { currentChapter }),
    ...(thresholds ? { thresholds } : {}),
  });
  return {
    path: SATISFACTION_PATH,
    exists: true,
    note: `读到 ${String(ledger.hits.length)} 个爽点 · ${String(ledger.promises.length)} 条承诺 · `
      + `${String(ledger.scenes.length)} 个场景声明；当前进度按「${currentChapter ?? "（无章）"}」算`,
    chapterTotal: chapters.length,
    currentChapter,
    rows: board.rows,
    promises: board.promises,
    findings: board.findings,
    notEvaluated: board.notEvaluated,
    stats: board.stats,
  };
}
