/* SPDX-License-Identifier: Apache-2.0 */
import {
  OUTLINE_PATH,
  VISIBILITY_CHECK_ORIGIN,
  checkVisibility,
  parseOutline,
  readCardFile,
  type ReportFinding,
  type VisibilityCardRow,
} from "@yushu/world-engine";
import type { VisibilityUnreadablePayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 信息可见性核对的桌面侧（M4 / T4-2 第四批·第一段，R103）。
 *
 * 判定全在引擎（`visibility-check.ts`，判据 docs/01 §4.2 冰山原则 + A08 §3/§5 + K05:80 的合法形状），
 * 本模块只做两件引擎做不了的事：
 * ① **把卡上的 `source_chapters` 读出来**——它既不在 `CardSummary`（列表摘要）里，
 *    也不在索引的实体行里，所以这条链必须自己走一遍真源。否则核对拿到的永远是空数组，
 *    结论就变成"没人登记过出处"那条 info——**用一次空扫描冒充"检查跑过了"是最坏的假绿灯**；
 * ② 章序只认大纲回填的 `chapter_id`（不读章节正文：这条链的判据不需要正文）。
 *
 * 坏卡不静默丢掉：进 `visibilityUnreadable` 逐张点名，并折成一条 `vis-card-unreadable`（warn）
 * 进体检表——与 `fs-ledger-unreadable` / `pov-config-unreadable` 同一条路子。
 */

/** 桌面侧的 id（引擎只吃解析好的行，不知道"有张卡读不了"）；与 fs/pov 两条同族 */
export const VIS_UNREADABLE_RULE = "vis-card-unreadable";

const CARD_PREFIX = "world/cards/";

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function scanCards(
  gateway: ProjectGateway,
): Promise<{ rows: VisibilityCardRow[]; unreadable: VisibilityUnreadablePayload[] }> {
  const tree = await gateway.listTree();
  const paths = tree
    .filter((entry) => entry.type === "file" && entry.path.startsWith(CARD_PREFIX) && entry.path.endsWith(".md"))
    .map((entry) => entry.path)
    .sort(byCodePoint);
  const rows: VisibilityCardRow[] = [];
  const unreadable: VisibilityUnreadablePayload[] = [];
  for (const path of paths) {
    try {
      const snapshot = await gateway.readDoc(path);
      const { card } = readCardFile(snapshot.content);
      rows.push({
        id: card.id,
        name: card.name,
        visibility: card.visibility,
        sourceChapters: card.source_chapters ?? [],
      });
    } catch (err) {
      unreadable.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, unreadable };
}

/** 章序：大纲里已回填 chapter_id 的那些章，按卷内顺序摊平（未建草稿的章纲没有 id 可指） */
async function chapterOrder(gateway: ProjectGateway): Promise<string[]> {
  const snap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (snap === null) return [];
  const outline = parseOutline(snap.content);
  const ids: string[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      const id = chapter.chapter_id;
      if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** 读不动的卡（面板与结论都要点名它，不能让它消失在"零结论"里） */
export async function visibilityUnreadable(gateway: ProjectGateway): Promise<VisibilityUnreadablePayload[]> {
  return (await scanCards(gateway)).unreadable;
}

export async function visibilityReportFindings(gateway: ProjectGateway): Promise<ReportFinding[]> {
  const { rows, unreadable } = await scanCards(gateway);
  if (rows.length === 0 && unreadable.length === 0) return [];
  const findings = checkVisibility({ cards: rows, chapterOrder: await chapterOrder(gateway) }).map((row) => ({
    rule: row.rule,
    severity: row.severity,
    subject: row.subject,
    ...(row.related === undefined ? {} : { related: row.related }),
    evidence: row.evidence,
    fix: row.fix,
    origin: row.origin,
  }));
  const broken: ReportFinding[] = unreadable.map((card) => ({
    rule: VIS_UNREADABLE_RULE,
    severity: "warn",
    subject: card.path,
    evidence: `${card.path} 读不动，本轮可见性核对没有看它一眼：${card.error}`,
    fix: "按报错修 frontmatter（未知键、非法可见性、坏 YAML 都会整份拒绝）；修不好就去档案页重开这张卡。",
    origin: VISIBILITY_CHECK_ORIGIN,
  }));
  return [...findings, ...broken];
}
