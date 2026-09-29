import { parse as parseYaml } from "yaml";
import { YushuError } from "@yushu/core";
import type {
  MergedWordlistEntry,
  SensitiveHit,
  SensitiveScanResult,
  SensitiveSeverity,
  Wordlist,
  WordlistEntry,
} from "./types.js";

/**
 * 敏感词自查流水线（T1-19）：词库外置可更新（带来源与版本号）。
 * - 扫描返回命中位置与上下文与替换建议；M1 只建议、不自动改写正文；
 * - 多词库合并时后加载的词库同词条优先（项目内词库覆盖内置）。
 */

export class WordlistError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_WORDLIST", message, options);
  }
}

const SEVERITIES: SensitiveSeverity[] = ["error", "warn", "info"];

function assertSeverity(value: unknown): SensitiveSeverity {
  if (SEVERITIES.includes(value as SensitiveSeverity)) return value as SensitiveSeverity;
  throw new WordlistError(`词条 severity 非法：${String(value)}（应为 error/warn/info）`);
}

/** 解析词库文件文本（yushu.wordlist/v1） */
export function parseWordlist(text: string, fallbackId = "wordlist"): Wordlist {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new WordlistError("词库 YAML 解析失败", { cause: err });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new WordlistError("词库内容非法（应为 YAML 映射）");
  }
  const record = data as Record<string, unknown>;
  if (record["apiVersion"] !== "yushu.wordlist/v1") {
    throw new WordlistError(`词库 apiVersion 必须为 yushu.wordlist/v1，实际为 ${String(record["apiVersion"])}`);
  }
  const entriesRaw = record["entries"];
  if (!Array.isArray(entriesRaw)) {
    throw new WordlistError("词库缺少 entries 数组");
  }
  const entries: WordlistEntry[] = [];
  for (const raw of entriesRaw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const word = item["word"];
    if (typeof word !== "string" || word.trim() === "") continue;
    const severity = item["severity"] === undefined ? "warn" : assertSeverity(item["severity"]);
    entries.push({
      word: word.trim(),
      severity,
      ...(typeof item["suggestion"] === "string" && item["suggestion"] !== ""
        ? { suggestion: item["suggestion"] }
        : {}),
      ...(typeof item["note"] === "string" && item["note"] !== "" ? { note: item["note"] } : {}),
      ...(Array.isArray(item["platforms"])
        ? {
            platforms: item["platforms"].filter((p): p is string => typeof p === "string"),
          }
        : {}),
    });
  }
  const id = typeof record["id"] === "string" && record["id"] !== "" ? record["id"] : fallbackId;
  return {
    apiVersion: "yushu.wordlist/v1",
    id,
    version: typeof record["version"] === "string" ? record["version"] : "0.0.0",
    ...(typeof record["source"] === "string" && record["source"] !== ""
      ? { source: record["source"] }
      : {}),
    ...(typeof record["updated_at"] === "string" && record["updated_at"] !== ""
      ? { updated_at: record["updated_at"] }
      : {}),
    ...(typeof record["title"] === "string" && record["title"] !== ""
      ? { title: record["title"] }
      : {}),
    entries,
  };
}

/** 合并多个词库（按输入顺序加载；后加载覆盖同词条——项目内词库优先） */
export function mergeWordlists(wordlists: Wordlist[]): MergedWordlistEntry[] {
  const merged = new Map<string, MergedWordlistEntry>();
  for (const wordlist of wordlists) {
    for (const entry of wordlist.entries) {
      merged.set(entry.word, {
        ...entry,
        wordlistId: wordlist.id,
        wordlistVersion: wordlist.version,
        ...(wordlist.source ? { wordlistSource: wordlist.source } : {}),
      });
    }
  }
  return [...merged.values()];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTEXT_RADIUS = 12;

/**
 * 扫描一章正文中的命中（大小写不敏感；同一词在文中多处命中均返回）。
 * 命中位置按正文字符下标给出（T1-19 命中定位）。
 */
export function scanChapter(
  body: string,
  chapter: { chapterId: string; chapterTitle: string; volumeTitle: string },
  entries: MergedWordlistEntry[],
): SensitiveHit[] {
  if (entries.length === 0 || body === "") return [];
  const lower = body.toLowerCase();
  const hits: SensitiveHit[] = [];
  for (const entry of entries) {
    const needle = entry.word.toLowerCase();
    const regex = new RegExp(escapeRegExp(needle), "g");
    for (const match of lower.matchAll(regex)) {
      const index = match.index ?? 0;
      const start = Math.max(0, index - CONTEXT_RADIUS);
      const end = Math.min(body.length, index + needle.length + CONTEXT_RADIUS);
      hits.push({
        word: entry.word,
        severity: entry.severity,
        ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.platforms ? { platforms: entry.platforms } : {}),
        wordlistId: entry.wordlistId,
        wordlistVersion: entry.wordlistVersion,
        chapterId: chapter.chapterId,
        chapterTitle: chapter.chapterTitle,
        volumeTitle: chapter.volumeTitle,
        index,
        context: body.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return hits.sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.index - b.index);
}

/** 扫描全书（多章），返回命中 + 汇总（词库信息、按严重级计数） */
export function scanSensitive(
  chapters: { chapterId: string; chapterTitle: string; volumeTitle: string; body: string }[],
  entries: MergedWordlistEntry[],
): SensitiveScanResult {
  const hits: SensitiveHit[] = [];
  for (const chapter of chapters) {
    hits.push(...scanChapter(chapter.body, chapter, entries));
  }
  const bySeverity: Record<SensitiveSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const hit of hits) bySeverity[hit.severity] += 1;
  const wordlistMap = new Map<string, { id: string; version: string; source?: string; entries: number }>();
  for (const entry of entries) {
    const key = `${entry.wordlistId}@${entry.wordlistVersion}`;
    const existing = wordlistMap.get(key);
    if (existing) existing.entries += 1;
    else {
      wordlistMap.set(key, {
        id: entry.wordlistId,
        version: entry.wordlistVersion,
        ...(entry.wordlistSource ? { source: entry.wordlistSource } : {}),
        entries: 1,
      });
    }
  }
  return {
    hits,
    summary: {
      totalHits: hits.length,
      bySeverity,
      wordCount: entries.length,
      wordlists: [...wordlistMap.values()],
    },
  };
}