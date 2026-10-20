/* SPDX-License-Identifier: Apache-2.0 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { YushuError, codePointCompare, countWords, type Chapter } from "@yushu/core";
import {
  OUTLINE_PATH,
  PUBLISH_LEDGER_API_VERSION,
  PUBLISH_LEDGER_PATH,
  PUBLISH_ORIGIN,
  PUBLISH_REMINDER_ORIGIN,
  PUBLISH_WORD_ORIGIN,
  buildPublishEvent,
  canTransition,
  chapterPath,
  checkWordGate,
  parseOutline,
  parsePublishLedger,
  parsePublishRules,
  planPublishReminders,
  publishTransitionGuide,
  readChapterFile,
  serializeChapterFile,
  serializePublishLedger,
  type PublishEvent,
  type PublishRules,
  type PublishStatus,
} from "@yushu/world-engine";
import type {
  PublishBoardPayload,
  PublishChapterRow,
  PublishSchedulePayload,
  PublishScheduleResult,
  PublishSetStatusPayload,
  PublishSetStatusResult,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { packsRoot } from "./paths.js";

/**
 * 发布状态机（R105 / M5 T5-6）的桌面侧。
 *
 * **三条口径**（判据在引擎侧 `world-engine/src/publish.ts`，这里只做引擎做不到的事）：
 * ① **不查平台、不代替作者发布**——`status` 记的是作者自己登记的本地状态；
 *    定时发布是**本地提醒队列**（I01 §3.7），到点提醒一句，不替作者按发布键；
 * ② **状态与留痕要么都成、要么都没成**——一次迁移要写两处（章 frontmatter 的 status +
 *    `config/publish.yaml` 的台账），台账先写、章节后写；章节写失败就把台账那一条**撤回去**
 *    （补偿写），不留"留痕说有、状态没改"的半截状态（那种半截状态会让当日字数口径静默算错）；
 * ③ **读不动的账不许当空账**——台账坏了就把原因摊出来（`rulesError` / `ledgerError`），
 *    不降级成"没有留痕"（那会让作者以为从没发生过回退）。
 */

/** 平台口径包文件名（与 `platform-export.yaml` 同目录，两片各管各的字段） */
export const PLATFORM_RULES_FILE = "platform-rules.yaml";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 本地时刻（带时区偏移）：日期部分要与作者所在时区一致，否则"今日已发布字数"会算到隔壁那天 */
export function localIsoNow(date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/* ---------------- 口径包（番茄等）：读第一份可用的 ---------------- */

interface RulesBundle {
  rules: PublishRules | null;
  error: string;
}

/**
 * 扫 `packs/platforms` 各平台目录下的 `platform-rules.yaml`，取**第一份能解析的**（按 id 码点序）。
 *
 * 坏包不静默丢：解析失败时把原因带出来，界面显示"口径包读不了，本轮不判字数"，
 * 而不是悄悄按没有阈值处理（那等于显示"一切正常"）。
 */
export async function loadPublishRules(root = join(packsRoot, "platforms")): Promise<RulesBundle> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => codePointCompare(a, b));
  const problems: string[] = [];
  for (const id of dirs) {
    const text = await fs.readFile(join(root, id, PLATFORM_RULES_FILE), "utf8").catch(() => null);
    if (text === null) continue;
    try {
      return { rules: parsePublishRules(text), error: "" };
    } catch (err) {
      problems.push(`${id}：${messageOf(err)}`);
    }
  }
  return {
    rules: null,
    error:
      problems.length > 0
        ? problems.join("；")
        : `没有可用的平台口径包（packs/platforms 下各平台的 ${PLATFORM_RULES_FILE}）——字数闸本轮不判`,
  };
}

/* ---------------- 台账 ---------------- */

interface LedgerBundle {
  events: PublishEvent[];
  /** 原始文本（补偿写要按原样写回去） */
  raw: string;
  exists: boolean;
  hash: string;
  error: string;
}

async function readLedger(gateway: ProjectGateway): Promise<LedgerBundle> {
  const snapshot = await gateway.readDoc(PUBLISH_LEDGER_PATH).catch(() => null);
  if (snapshot === null) {
    return { events: [], raw: "", exists: false, hash: "", error: "" };
  }
  try {
    const ledger = parsePublishLedger(snapshot.content);
    return { events: ledger.events, raw: snapshot.content, exists: true, hash: snapshot.hash, error: "" };
  } catch (err) {
    return { events: [], raw: snapshot.content, exists: true, hash: snapshot.hash, error: messageOf(err) };
  }
}

/* ---------------- 章节枚举 ---------------- */

interface ChapterRow extends PublishChapterRow {
  hash: string;
}

async function readChapters(gateway: ProjectGateway): Promise<ChapterRow[]> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (snapshot === null) return [];
  const outline = parseOutline(snapshot.content);
  const rows: ChapterRow[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      const path = chapterPath(volume.id, chapter.chapter_id);
      const file = await gateway.readDoc(path).catch(() => null);
      if (file === null) continue;
      try {
        const { chapter: entity, body } = readChapterFile(file.content);
        const publishAt = typeof entity.publish_at === "string" ? entity.publish_at : "";
        rows.push({
          id: entity.id,
          title: chapter.title,
          path,
          status: entity.status,
          wordCount: entity.word_count > 0 ? entity.word_count : countWords(body),
          publishAt,
          due: false,
          hash: file.hash,
        });
      } catch {
        // 章节文件损坏：这一章不进发布面板（编辑器打开时会给出解析错误），不猜它的状态
      }
    }
  }
  return rows;
}

/* ---------------- 读看板 ---------------- */

export async function readPublishBoard(gateway: ProjectGateway, now = localIsoNow()): Promise<PublishBoardPayload> {
  const [rows, ledger, bundle] = await Promise.all([readChapters(gateway), readLedger(gateway), loadPublishRules()]);

  const reminders = planPublishReminders(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      wordCount: row.wordCount,
      ...(row.publishAt === "" ? {} : { publishAt: row.publishAt }),
    })),
    now,
  );
  const dueIds = new Set(reminders.map((item) => item.id));
  const chapters: PublishChapterRow[] = rows.map((row) => ({ ...row, due: dueIds.has(row.id) }));

  const groups = { draft: 0, revised: 0, published: 0 };
  for (const row of rows) groups[row.status] += 1;

  // 账实不符：章节当前状态与台账最后一条对不上（留痕丢了或被手改过）——摊出来，不静默
  const latestByChapter = new Map<string, PublishEvent>();
  for (const event of ledger.events) {
    const previous = latestByChapter.get(event.chapterId);
    if (previous === undefined || event.at >= previous.at) latestByChapter.set(event.chapterId, event);
  }
  const mismatches: string[] = [];
  for (const row of rows) {
    const latest = latestByChapter.get(row.id);
    if (latest === undefined) continue;
    if (latest.to !== row.status) {
      mismatches.push(`${row.title}（台账最后一条是 ${latest.to}，章节当前是 ${row.status}）`);
    }
  }

  const emptyWord = {
    count: 0,
    total: 0,
    min: 0,
    max: 0,
    median: 0,
    perChapterFloorDeclared: false,
    belowFloor: [] as { id: string; title: string; wordCount: number }[],
  };
  const word = bundle.rules
    ? checkWordGate(
        rows.map((row) => ({ id: row.id, title: row.title, wordCount: row.wordCount })),
        bundle.rules,
        ledger.events,
        now,
      )
    : emptyWord;

  return {
    platform: bundle.rules?.platform ?? "",
    platformVersion: bundle.rules?.version ?? "",
    effectiveDate: bundle.rules?.effectiveDate ?? "",
    sourceUrls: bundle.rules?.sourceUrls ?? [],
    validWordRule: bundle.rules?.validWordRule ?? "",
    origins: {
      status: PUBLISH_ORIGIN,
      reminder: PUBLISH_REMINDER_ORIGIN,
      word: PUBLISH_WORD_ORIGIN,
    },
    rulesError: bundle.error,
    chapters,
    reminders: reminders.map((item) => ({
      id: item.id,
      title: item.title,
      publishAt: item.publishAt,
      dueMs: item.dueMs,
      wordCount: item.wordCount,
    })),
    groups,
    word,
    ledgerEvents: ledger.events.length,
    ledgerError: ledger.error,
    transitionGuide: publishTransitionGuide(),
    mismatches,
  };
}

/* ---------------- 写：改发布状态 ---------------- */

export async function setChapterPublishStatus(
  gateway: ProjectGateway,
  payload: PublishSetStatusPayload,
): Promise<PublishSetStatusResult> {
  const snapshot = await gateway.readDoc(payload.path);
  const { chapter, body } = readChapterFile(snapshot.content);
  const wordCount = chapter.word_count > 0 ? chapter.word_count : countWords(body);

  const check = canTransition(chapter.status, payload.to);
  if (!check.ok) {
    throw new YushuError(
      check.code === "E_PUBLISH_STATUS_UNKNOWN" ? "E_PUBLISH_STATUS_UNKNOWN" : "E_PUBLISH_TRANSITION_INVALID",
      check.reason,
    );
  }

  const ledger = await readLedger(gateway);
  if (ledger.error !== "") {
    throw new YushuError("E_PUBLISH_LEDGER", `发布台账读不了，本轮不写状态（免得留痕与状态对不上）：${ledger.error}`);
  }

  const at = localIsoNow();
  const event = buildPublishEvent({
    chapterId: chapter.id,
    from: chapter.status,
    to: payload.to,
    at,
    wordCount,
    ...(payload.note === undefined || payload.note.trim() === "" ? {} : { note: payload.note.trim() }),
  });

  // ① 台账先留痕（append 语义，baseHash 防并发）
  const nextLedger = { apiVersion: PUBLISH_LEDGER_API_VERSION, events: [...ledger.events, event] };
  const ledgerWritten = await gateway.writeDoc(
    PUBLISH_LEDGER_PATH,
    serializePublishLedger(nextLedger),
    ledger.exists ? ledger.hash : undefined,
  );

  // ② 再改章节状态
  try {
    const text = serializeChapterFile({ ...chapter, status: payload.to }, body);
    await gateway.writeDoc(payload.path, text, payload.baseHash);
  } catch (err) {
    // 补偿：把刚写的那条留痕撤回去——不留"留痕说有、状态没改"的半截状态
    // （那种半截状态会让当日字数口径静默算错，而且是静默的）
    await (ledger.exists
      ? gateway.writeDoc(PUBLISH_LEDGER_PATH, ledger.raw, ledgerWritten.hash)
      : gateway.deleteDoc(PUBLISH_LEDGER_PATH, ledgerWritten.hash)
    ).catch(() => undefined);
    throw err;
  }

  return {
    path: payload.path,
    from: chapter.status,
    to: payload.to,
    at,
    rollback: event.rollback,
    ledgerEvents: nextLedger.events.length,
    wordCount,
  };
}

/* ---------------- 写：设定 / 清除定时发布 ---------------- */

export async function scheduleChapterPublish(
  gateway: ProjectGateway,
  payload: PublishSchedulePayload,
): Promise<PublishScheduleResult> {
  const snapshot = await gateway.readDoc(payload.path);
  const { chapter, body } = readChapterFile(snapshot.content);
  const raw = payload.publishAt.trim();
  if (raw !== "" && Number.isNaN(Date.parse(raw))) {
    throw new YushuError("E_PUBLISH_SCHEDULE_INVALID", `发布时刻不是可解析的时刻：${payload.publishAt}`);
  }
  const next: Chapter = { ...chapter };
  if (raw === "") {
    delete next.publish_at;
  } else {
    next.publish_at = raw;
  }
  const text = serializeChapterFile(next, body);
  await gateway.writeDoc(payload.path, text, payload.baseHash);
  return { path: payload.path, publishAt: raw };
}
