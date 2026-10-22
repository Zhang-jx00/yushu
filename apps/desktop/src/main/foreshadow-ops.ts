/* SPDX-License-Identifier: Apache-2.0 */
import {
  buildForeshadowBoard,
  parseForeshadowLedger,
  FORESHADOW_PATH,
  type ConsistencySpan,
} from "@yushu/world-engine";
import type { ForeshadowBoardPayload, SummaryRow } from "../shared/ipc.js";
import { readOutlineSafe } from "./doc-readers.js";
import type { ProjectGateway } from "./file-gateway.js";
import { locateLedgerEntrySpan } from "./ledger-spans.js";

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
      summary: [],
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
      summary: [],
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
    // 汇总的**结构化行**（R127）：原先界面里是「读到 N 条伏笔；…；共 N 条 · 未回收 N · 已回收 N · …」
    // 一长串 ⇒ 窄栏里折成三四行；结构**由后端给**（不切那串自由文本）
    summary: [
      { label: "伏笔", value: `${String(board.stats.total ?? 0)} 条` },
      { label: "未回收", value: `${String(board.stats.open ?? 0)} 条` },
      { label: "已回收", value: `${String(board.stats.paid ?? 0)} 条` },
      { label: "已放弃", value: `${String(board.stats.abandoned ?? 0)} 条` },
      { label: "红鲱鱼", value: `${String(board.stats.redHerring ?? 0)} 条` },
      { label: "逾期", value: `${String(board.stats.overdue ?? 0)} 条` },
      { label: "当前章", value: currentChapter ?? "（无章）" },
    ],
    chapterTotal: chapters.length,
    currentChapter,
    rows: board.rows,
    findings: board.findings,
    stats: board.stats,
  };
}

/** 投影成体检报告条目的形状（与 `ReportFinding` 结构兼容，由调用点并入同表） */
export interface ForeshadowReportFinding {
  rule: string;
  severity: "error" | "warn" | "info";
  subject: string;
  evidence: string;
  fix: string;
  origin: string;
  /** 定位不到就**不给这个键**（报告侧会退回按主体找卡；绝不塞 0-0 的假区间） */
  span?: ConsistencySpan;
}

/**
 * 伏笔结论并入全书体检（M4 / T4-2，R75）：**判定一行都不重写**。
 *
 * `buildForeshadowBoard` 已经是伏笔判定的唯一出处（R65 立的），这里只做两件事：
 * 把结论换上报告条目的形状、并按条目 id 去 `world/foreshadow.yaml` 里定位原文区间
 * （定位不到给 `null`，不给 0-0 的假区间）。
 *
 * 台账读不懂时**如实报一条 `fs-ledger-unreadable`**，而不是静默贡献零条结论——
 * "伏笔这块没报问题"必须能区分"查过没问题"与"根本没查"（同 R74 参与表的口径）。
 * 台账文件不存在则确实没有结论可报，返回空数组。
 */
export async function foreshadowReportFindings(gateway: ProjectGateway): Promise<ForeshadowReportFinding[]> {
  const snap = await gateway.readDoc(FORESHADOW_PATH).catch(() => null);
  if (snap === null) return [];
  const origin = `伏笔台账（${FORESHADOW_PATH}）`;
  let ledger;
  try {
    ledger = parseForeshadowLedger(snap.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{
      rule: "fs-ledger-unreadable",
      severity: "warn",
      subject: FORESHADOW_PATH,
      evidence: `台账读不了，本次没有伏笔结论：${message}`,
      fix: "按提示修好 world/foreshadow.yaml（未知键 / 非法枚举 / 重复 id 都会整份拒绝）；要看完整报错去「世界观档案」页的伏笔看板",
      origin,
    }];
  }
  const board = buildForeshadowBoard(ledger, { chapters: await chapterOrder(gateway) });
  return board.findings.map((finding) => {
    // 全局结论（id 为 "-"）没有对应条目；定位不到也不给假区间——那个键干脆不出现
    const span = finding.id === "-" ? null : locateLedgerEntrySpan(snap.content, FORESHADOW_PATH, finding.id);
    return {
      rule: finding.rule,
      severity: finding.severity,
      // "-" 是全局结论（如章清单为空），没有对应条目 ⇒ 主体落在台账文件本身
      subject: finding.id === "-" ? FORESHADOW_PATH : finding.id,
      evidence: finding.message,
      fix: "改法在台账本身：编辑该条的埋设章 / 预期回收章 / 状态或回收章；确认是刻意留白就写进 config/consistency.yaml 并记理由",
      origin,
      ...(span ? { span } : {}),
    };
  });
}
