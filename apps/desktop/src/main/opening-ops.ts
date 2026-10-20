/* SPDX-License-Identifier: Apache-2.0 */
import {
  OPENING_CHECK_ORIGIN,
  OPENING_WINDOW_CHAPTERS,
  OUTLINE_PATH,
  chapterPath,
  checkOpening,
  parseOutline,
  readChapterFile,
  type IndexEntityRow,
  type OpeningChapterRow,
  type OpeningMentionRow,
  type Outline,
  type ReportFinding,
} from "@yushu/world-engine";
import { mentionedEntityIds } from "@yushu/memory";
import type { OpeningUnreadablePayload } from "../shared/ipc.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 黄金三章核对的桌面侧（M4 / T4-2 第五批，R104）。
 *
 * 判定全在引擎（`opening-check.ts`，判据 F02 §5 + F11 §3），本模块只做引擎做不到的两件事：
 * ① **把前三章拼成一行行可判的数据**——大纲给顺序 / 标题 / 章纲七要素，章文件 frontmatter 给视角，
 *    正文给"这一章点到过谁"；
 * ② **只读开局窗口那几章**（默认三章），不为一本八千章的书把全书正文都扫一遍。
 *
 * 「具名角色 ≤3」这一条为什么可信：数的是**提及扫描**（`@yushu/memory` 的 `mentionedEntityIds`，
 * 名字 + 别名最长匹配）命中的**人物卡**，不是关键词表，也不是"出场章节"那种手工登记——
 * 登记会漏写，扫描不会假装。这也意味着它的口径是"卡上建过这个角色"：
 * 一篇写了五个没建卡的人名的稿子，扫出来只有两个。这条口径在结论的证据行里如实写着。
 *
 * 读不动的文件不静默丢掉：折成 `open-source-unreadable`（warn）逐份点名，
 * 与 `fs-ledger-unreadable` / `pov-config-unreadable` / `vis-card-unreadable` 同一条路子。
 */

/** 桌面侧的 id（引擎只吃解析好的行，不知道"有份文件读不动"）；与 fs/pov/vis 四条同族 */
export const OPEN_UNREADABLE_RULE = "open-source-unreadable";

function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 人物卡 targets（提及扫描的词典）：只有建过卡的角色才算"具名"，路人名不计数 */
function characterTargets(entities: readonly IndexEntityRow[]): { id: string; name: string; aliases: string[] }[] {
  return entities
    .filter((entity) => entity.type === "character" && entity.id !== "" && entity.name !== "")
    .map((entity) => ({ id: entity.id, name: entity.name, aliases: entity.aliases }))
    .sort((a, b) => byCodePoint(a.id, b.id));
}

interface OpeningSource {
  rows: OpeningChapterRow[];
  unreadable: OpeningUnreadablePayload[];
}

async function collectOpeningSource(
  gateway: ProjectGateway,
  entities: readonly IndexEntityRow[],
): Promise<OpeningSource> {
  const snap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (snap === null) return { rows: [], unreadable: [] };

  let outline: Outline;
  try {
    outline = parseOutline(snap.content);
  } catch (err) {
    return {
      rows: [],
      unreadable: [{ path: OUTLINE_PATH, error: err instanceof Error ? err.message : String(err) }],
    };
  }

  const targets = characterTargets(entities);
  const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));
  const rows: OpeningChapterRow[] = [];
  const unreadable: OpeningUnreadablePayload[] = [];
  let order = 0;

  for (const volume of outline.volumes) {
    for (const item of volume.chapters) {
      order += 1;
      /** 只看到开局窗口那几章：后面的章再大也不读，这是这条链的成本上限 */
      if (order > OPENING_WINDOW_CHAPTERS) break;
      const row: OpeningChapterRow = {
        outlineId: item.id,
        title: item.title,
        order,
        // 摊成对象字面量：ChapterBrief 是 interface，直接赋给引擎那侧的 Record 形状会缺隐式索引签名
        brief: { ...item.brief },
      };
      const draftId = item.chapter_id;
      if (typeof draftId === "string" && draftId !== "") {
        const path = chapterPath(volume.id, draftId);
        try {
          const chapterSnap = await gateway.readDoc(path);
          const parsed = readChapterFile(chapterSnap.content);
          row.chapterId = parsed.chapter.id;
          row.pov = parsed.chapter.pov;
          const mentionedIds = mentionedEntityIds(parsed.body, targets);
          const mentioned: OpeningMentionRow[] = mentionedIds.map((id) => ({
            id,
            name: nameById.get(id) ?? id,
          }));
          row.mentionedCharacters = mentioned;
        } catch (err) {
          /**
           * 章文件读不动 ⇒ 这一章**退回"没有草稿"**：宁可少判两条正文结论，
           * 也不能拿"扫了个空正文"当"这章一个角色都没出场"。
           * 退回要把已经写进 row 的那几样一起抹掉——只登记 unreadable 而留着半截数据，
           * 结论照发、警告也发，等于同时撒谎两次。
           */
          unreadable.push({ path, error: err instanceof Error ? err.message : String(err) });
          delete row.chapterId;
          delete row.pov;
          delete row.mentionedCharacters;
        }
      }
      if (row.pov !== undefined && row.pov.trim() !== "") {
        const label = nameById.get(row.pov.trim());
        if (label !== undefined) row.povName = label;
      }
      rows.push(row);
    }
    if (order > OPENING_WINDOW_CHAPTERS) break;
  }
  return { rows, unreadable };
}

export async function openingUnreadable(
  gateway: ProjectGateway,
  entities: readonly IndexEntityRow[],
): Promise<OpeningUnreadablePayload[]> {
  return (await collectOpeningSource(gateway, entities)).unreadable;
}

export async function openingReportFindings(
  gateway: ProjectGateway,
  entities: readonly IndexEntityRow[],
): Promise<ReportFinding[]> {
  const { rows, unreadable } = await collectOpeningSource(gateway, entities);
  if (rows.length === 0 && unreadable.length === 0) return [];

  const findings: ReportFinding[] = checkOpening({ chapters: rows }).map((row) => ({
    rule: row.rule,
    severity: row.severity,
    subject: row.subject,
    ...(row.related === undefined ? {} : { related: row.related }),
    evidence: row.evidence,
    fix: row.fix,
    origin: row.origin,
  }));
  const broken: ReportFinding[] = unreadable.map((file) => ({
    rule: OPEN_UNREADABLE_RULE,
    severity: "warn",
    subject: file.path,
    evidence: `${file.path} 读不动，开局窗口里这一章本轮没有参与核对：${file.error}`,
    fix: "按报错修 frontmatter（缺 id / volume / idx 这类必填项会整份拒绝）；修不好就去编辑器打开这一章看完整错误。大纲本身读不动时，去大纲页重新保存一次。",
    origin: OPENING_CHECK_ORIGIN,
  }));
  return [...findings, ...broken];
}
