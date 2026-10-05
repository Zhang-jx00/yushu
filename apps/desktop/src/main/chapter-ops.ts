import { countWords } from "@yushu/core";
import { readChapterFile, serializeChapterFile } from "@yushu/world-engine";
import type {
  ChapterReadResult,
  ChapterSidecarPayload,
  ChapterSidecarResult,
  ChapterWritePayload,
  ChapterWriteResult,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { countEffectiveChars, recordChapterDelta } from "./stats-ops.js";

/**
 * 章节正文读写（M2 / T2-1 切片 A：源码形态编辑器）：
 * - 编辑器只编辑「正文」，frontmatter 由系统维护；
 * - 保存时同步回 `word_count`（与导出对账、AI 采纳共用 countWords 口径），避免"编辑后对账失配"；
 * - 写入携带 baseHash：外部改动过即以 E_DOC_CONFLICT 拒绝，绝不盲覆盖。
 */

export async function readChapter(gateway: ProjectGateway, path: string): Promise<ChapterReadResult> {
  const snapshot = await gateway.readDoc(path);
  const { chapter, body } = readChapterFile(snapshot.content);
  return {
    path,
    title: chapter.title,
    body,
    wordCount: chapter.word_count > 0 ? chapter.word_count : countWords(body),
    hash: snapshot.hash,
  };
}

export async function writeChapterBody(
  gateway: ProjectGateway,
  payload: ChapterWritePayload,
): Promise<ChapterWriteResult> {
  const snapshot = await gateway.readDoc(payload.path);
  const { chapter, body: oldBody } = readChapterFile(snapshot.content);
  const wordCount = countWords(payload.body);
  const text = serializeChapterFile({ ...chapter, word_count: wordCount }, payload.body);
  const written = await gateway.writeDoc(payload.path, text, payload.baseHash);
  // T2-9 码字统计：按章节净增字数记账（frontmatter 记录值为旧值，缺失时回算正文）；
  // 切片 B：同时记平台口径有效字数净增（去空白换算；失败不阻断保存）
  const oldWords = chapter.word_count > 0 ? chapter.word_count : countWords(oldBody);
  await recordChapterDelta(gateway, {
    path: payload.path,
    oldWords,
    newWords: wordCount,
    oldEffective: countEffectiveChars(oldBody),
    newEffective: countEffectiveChars(payload.body),
  }).catch(() => undefined);
  return { path: payload.path, hash: written.hash, wordCount };
}

function timeStamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 冲突旁路（T2-6 切片）：把当前编辑内容写入 `<章节>.conflict-<时间戳>.md`（同目录，便于对比），
 * 主文件不动 —— 绝不静默覆盖（docs/04 T2-6）；由用户比对后自行取舍。
 */
export async function writeChapterSidecar(
  gateway: ProjectGateway,
  payload: ChapterSidecarPayload,
): Promise<ChapterSidecarResult> {
  const snapshot = await gateway.readDoc(payload.path);
  const { chapter } = readChapterFile(snapshot.content);
  const wordCount = countWords(payload.body);
  const sidecarPath = `${payload.path}.conflict-${timeStamp()}.md`;
  const text = serializeChapterFile({ ...chapter, word_count: wordCount }, payload.body);
  const written = await gateway.writeDoc(sidecarPath, text);
  return { sidecarPath, hash: written.hash, wordCount };
}