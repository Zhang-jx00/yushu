import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { YushuError, countWords } from "@yushu/core";
import {
  assembleExport,
  buildClipboardText,
  buildTxt,
  mergeWordlists,
  parseWordlist,
  scanSensitive,
  type ExportChapter,
  type MergedWordlistEntry,
  type Wordlist,
} from "@yushu/export";
import {
  OUTLINE_PATH,
  WORLD_CONFIG_PATH,
  chapterPath,
  parseOutline,
  parseWorldConfig,
  readChapterFile,
} from "@yushu/world-engine";
import type {
  ClipboardResult,
  ExportPreviewPayload,
  ExportRunPayload,
  ExportRunResult,
  SkippedWordlistPayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { repoRoot } from "./paths.js";

/**
 * 导出与敏感词自查（S6；T1-18/19/20）：
 * - 装配：按三级大纲卷序 → 章序汇总「已创建草稿章节」的正文（未创建的章纲不计入并计数提示）；
 * - 词库外置可更新：仓库内置 wordlists/ + 项目内 wordlists/（后者覆盖同词条）；
 * - 防手滑：导出前必须显式确认（UI 二次点击 + 服务端 confirmed 校验）；
 * - 干净剪贴板：去注释（默认）/ 去 AI 标识（可选），写入系统剪贴板由 IPC 层完成。
 */

const EXPORTS_DIR = "exports";
const PROJECT_WORDLIST_DIR = "wordlists";
/** 预览最多返回的命中条数（全量计数仍在 hitTotal） */
const HIT_PREVIEW_LIMIT = 300;

interface CollectedChapters {
  chapters: ExportChapter[];
  missingDrafts: number;
  bookTitle: string;
}

/** 按大纲装配章节（只收 chapter_id 已回填且文件存在的章节） */
async function collectChapters(gateway: ProjectGateway): Promise<CollectedChapters> {
  const outlineSnap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  const chapters: ExportChapter[] = [];
  let missingDrafts = 0;

  if (outlineSnap) {
    const outline = parseOutline(outlineSnap.content);
    for (let volumeIndex = 0; volumeIndex < outline.volumes.length; volumeIndex += 1) {
      const volume = outline.volumes[volumeIndex]!;
      for (const chapter of volume.chapters) {
        if (!chapter.chapter_id) {
          missingDrafts += 1;
          continue;
        }
        const path = chapterPath(volume.id, chapter.chapter_id);
        const snapshot = await gateway.readDoc(path).catch(() => null);
        if (!snapshot) {
          missingDrafts += 1;
          continue;
        }
        const { chapter: entity, body } = readChapterFile(snapshot.content);
        chapters.push({
          outlineRef: chapter.id,
          chapterId: entity.id,
          volumeId: volume.id,
          volumeTitle: volume.title,
          act: volume.act,
          volumeIndex,
          idx: chapter.idx,
          title: chapter.title,
          body,
          statedWordCount: entity.word_count,
        });
      }
    }
  }

  const worldSnap = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  const bookTitle = worldSnap ? parseWorldConfig(worldSnap.content).title : "未命名作品";
  return { chapters, missingDrafts, bookTitle };
}

interface LoadedWordlists {
  wordlists: Wordlist[];
  entries: MergedWordlistEntry[];
  skipped: SkippedWordlistPayload[];
  dirs: string[];
}

/**
 * 加载词库：内置（仓库 wordlists/）→ 项目内（项目 wordlists/，同名文件序覆盖内置词条）。
 * 单文件解析失败只记 skipped，不阻断（其余词库继续生效）。
 */
export async function loadWordlists(gateway: ProjectGateway): Promise<LoadedWordlists> {
  const wordlists: Wordlist[] = [];
  const skipped: SkippedWordlistPayload[] = [];

  const builtinDir = join(repoRoot, "wordlists");
  const builtinFiles = (await fs.readdir(builtinDir).catch(() => [] as string[]))
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  for (const name of builtinFiles) {
    try {
      wordlists.push(parseWordlist(await fs.readFile(join(builtinDir, name), "utf8"), name));
    } catch (err) {
      skipped.push({ path: `wordlists/${name}`, error: messageOf(err) });
    }
  }

  const tree = await gateway.listTree();
  const projectFiles = tree
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.path.startsWith(`${PROJECT_WORDLIST_DIR}/`) &&
        /\.ya?ml$/i.test(entry.path),
    )
    .map((entry) => entry.path)
    .sort();
  for (const path of projectFiles) {
    try {
      const snapshot = await gateway.readDoc(path);
      wordlists.push(parseWordlist(snapshot.content, basename(path)));
    } catch (err) {
      skipped.push({ path, error: messageOf(err) });
    }
  }

  return {
    wordlists,
    entries: mergeWordlists(wordlists),
    skipped,
    dirs: ["wordlists/（内置）", `${PROJECT_WORDLIST_DIR}/（项目内覆盖）`],
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 导出预览：统计 + 字数对账 + 敏感词命中 + 词库信息（T1-18/19） */
export async function previewExport(gateway: ProjectGateway): Promise<ExportPreviewPayload> {
  const { chapters, missingDrafts, bookTitle } = await collectChapters(gateway);
  const assembled = assembleExport({ chapters });
  const { entries, skipped, dirs } = await loadWordlists(gateway);
  const scan = scanSensitive(
    assembled.chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      chapterTitle: chapter.title,
      volumeTitle: chapter.volumeTitle,
      body: chapter.body,
    })),
    entries,
  );

  return {
    bookTitle,
    volumes: assembled.stats.volumes,
    chapters: assembled.stats.chapters,
    totalWords: assembled.stats.totalWords,
    missingDrafts,
    reconcile: assembled.reconcile,
    hits: scan.hits.slice(0, HIT_PREVIEW_LIMIT),
    hitTotal: scan.hits.length,
    bySeverity: scan.summary.bySeverity,
    wordlists: scan.summary.wordlists,
    wordEntryCount: scan.summary.wordCount,
    skippedWordlists: skipped,
    wordlistDirs: dirs,
  };
}

function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "未命名作品" : cleaned.slice(0, 40);
}

function timeStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 导出 TXT（T1-18）：写项目内 exports/<书名>-<时间戳>.txt；同名自动追加序号（不覆盖既有导出）。
 * 防手滑：confirmed 必须显式为 true（服务端校验，UI 另有二次确认）。
 */
export async function runExport(
  gateway: ProjectGateway,
  payload: ExportRunPayload,
): Promise<ExportRunResult> {
  if (payload.confirmed !== true) {
    throw new YushuError(
      "E_CONFIRM_REQUIRED",
      "导出前需显式确认（防手滑）：请先核对章数 / 字数 / 敏感词命中，再点击「确认导出」",
    );
  }
  const { chapters, bookTitle } = await collectChapters(gateway);
  if (chapters.length === 0) {
    throw new YushuError(
      "E_EMPTY_EXPORT",
      "没有可导出的章节：请先在「三级大纲」创建草稿章节并写入正文",
    );
  }

  const assembled = assembleExport({ chapters });
  const text = buildTxt(assembled.chapters, {
    bookTitle,
    includeToc: payload.includeToc ?? true,
    stripMarkers: payload.stripMarkers ?? true,
  });

  const base = `${sanitizeFileName(bookTitle)}-${timeStamp()}`;
  let path = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${EXPORTS_DIR}/${base}${attempt === 0 ? "" : `-${attempt + 1}`}.txt`;
    const exists = await gateway.readDoc(candidate).catch(() => null);
    if (!exists) {
      path = candidate;
      break;
    }
  }
  if (path === "") {
    throw new YushuError("E_EXPORT_NAME", "导出文件名冲突过多，请稍后重试或修改书名");
  }

  const written = await gateway.writeDoc(path, text);
  const { entries } = await loadWordlists(gateway);
  const scan = scanSensitive(
    assembled.chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      chapterTitle: chapter.title,
      volumeTitle: chapter.volumeTitle,
      body: chapter.body,
    })),
    entries,
  );

  return {
    path,
    hash: written.hash,
    chapters: assembled.stats.chapters,
    words: assembled.stats.totalWords,
    clean: scan.summary.bySeverity.error === 0,
  };
}

/** 干净剪贴板文本（T1-20）：由 IPC 层写入系统剪贴板 */
export async function buildClipboardResult(
  gateway: ProjectGateway,
  options: { stripComments?: boolean; stripAiMarks?: boolean } = {},
): Promise<{ result: ClipboardResult; text: string }> {
  const { chapters } = await collectChapters(gateway);
  if (chapters.length === 0) {
    throw new YushuError("E_EMPTY_EXPORT", "没有可复制的章节：请先创建草稿章节并写入正文");
  }
  const text = buildClipboardText(chapters, {
    stripComments: options.stripComments ?? true,
    stripAiMarks: options.stripAiMarks ?? false,
  });
  return {
    text,
    result: {
      chapters: chapters.length,
      words: countWords(text),
      preview: text.slice(0, 160),
      target: "系统剪贴板",
    },
  };
}