/* SPDX-License-Identifier: Apache-2.0 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { YushuError, countWords } from "@yushu/core";
import {
  assembleExport,
  assessExportFormats,
  buildClipboardText,
  buildMarkdown,
  buildTxt,
  checkPlatformExport,
  epubGatePassed,
  formatChapterHead,
  mergeWordlists,
  parseWordlist,
  scanSensitive,
  stripLeadingChapterPrefix,
  templateAddsChapterPrefix,
  type ExportChapter,
  type ExportFormat,
  type ExportTooling,
  type MergedWordlistEntry,
  type PlatformExportPack,
  type PlatformFormatRow,
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
  ExportGatePayload,
  ExportPreviewPayload,
  ExportRunPayload,
  ExportRunResult,
  PlatformPackSummary,
  PlatformPreviewPayload,
  SkippedWordlistPayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import {
  convertWithPandoc,
  probeExportTooling,
  realToolDeps,
  onceTooling,
  validateEpub,
  type ToolDeps,
  type ToolingProbe,
} from "./export-tooling.js";
import {
  loadPlatformPack,
  platformPacksRoot,
  scanPlatformPacks,
  summaryOf,
  toSummary,
} from "./platform-ops.js";
import { repoRoot } from "./paths.js";

/**
 * 导出与敏感词自查（S6；T1-18/19/20）：
 * - 装配：按三级大纲卷序 → 章序汇总「已创建草稿章节」的正文（未创建的章纲不计入并计数提示）；
 * - 词库外置可更新：仓库内置 wordlists/ + 项目内 wordlists/（后者覆盖同词条）；
 * - 防手滑：导出前必须显式确认（UI 二次点击 + 服务端 confirmed 校验）；
 * - 干净剪贴板：去注释（默认）/ 去 AI 标识（可选），写入系统剪贴板由 IPC 层完成。
 */

// 设定集导出（R98 `bible-ops.ts`）与章节导出共用同一个落盘目录与同一套命名规则，
// 所以这几位助手是导出的**单源**：两处各写一份，早晚一份守得住冲突、另一份守不住。
export const EXPORTS_DIR = "exports";
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
    // 全书序号按**大纲**数，而不是按"已经写了正文的章"数：没建草稿的章在作者的书里同样占一个章号，
    // 跳过它会让后面每一章都往前挪一位（R94 查跨卷重号时发现的第二层）。
    let globalSeq = 0;
    for (let volumeIndex = 0; volumeIndex < outline.volumes.length; volumeIndex += 1) {
      const volume = outline.volumes[volumeIndex]!;
      for (const chapter of volume.chapters) {
        globalSeq += 1;
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
          seq: globalSeq,
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

/** 导出预览的可选注入（默认走现场探测；测试用它把"探测失败"变成可复现场景） */
export interface ExportPreviewOptions {
  probeTooling?: ToolingProbe | (() => Promise<ExportTooling>);
  /** 强制重探工具链：作者装完 PDF 引擎 / 备好 EPUBCheck jar 后点「重新核对」就该看到新结论 */
  refreshTooling?: boolean;
  /** 平台包 id（R94 / K11）：选了就把该平台的章节格式核对结果一并给出 */
  platform?: string;
  /** 平台包根目录；默认仓库 `packs/platforms/`（测试与将来的外接包目录用它） */
  platformRoot?: string;
}

/** 章头样例最多给几章（全书都按同一条模板，列完没意义） */
const TITLE_SAMPLE_LIMIT = 5;

/**
 * 按平台包算出**导出层真正会写出的那一行章头**（R94）。
 *
 * 预览、核对行、实际导出必须走同一个函数：三处各算各的，作者就会照着一句假话改稿。
 */
function platformChapterHead(chapter: ExportChapter, pack: PlatformExportPack): string {
  return formatChapterHead(chapter, pack.chapter_title_format);
}

/** 标题自带"第N章"前缀（平台模板会把它换成自己的编号） */
function carriesOwnPrefix(title: string): boolean {
  return stripLeadingChapterPrefix(title) !== title;
}

/** 平台核对的入参章节：序号用**全书序号**（投稿要的是它，不是卷内 idx） */
function platformCheckInput(chapters: ExportChapter[], pack: PlatformExportPack) {
  const rows = checkPlatformExport({
    pack,
    chapters: chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      idx: chapter.seq ?? chapter.idx,
      title: chapter.title,
    })),
    // 材料清单照抄包里的，但**不替作者判"缺哪几项"**：御书里没有可核对的项目内约定，
    // 报"还缺"就是编的。清单本身在摘要里给作者看（submissionMaterials）。
    materials: Object.fromEntries(pack.submission_materials.map((name) => [name, true])),
  });
  return {
    rows,
    strippedPrefixes: chapters.filter(
      (chapter) => templateAddsChapterPrefix(pack.chapter_title_format) && carriesOwnPrefix(chapter.title),
    ).length,
  };
}

/** 导出预览：统计 + 字数对账 + 敏感词命中 + 词库信息 + 本机能力矩阵（T1-18/19、T5-4） */
export async function previewExport(
  gateway: ProjectGateway,
  options: ExportPreviewOptions = {},
): Promise<ExportPreviewPayload> {
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

  // 探测失败只让能力矩阵留空，不把整页预览打死：作者依然能看到章数、字数与敏感词命中。
  // 留空 + 一句"探测失败"比硬凑一份"看起来合理"的矩阵诚实——后者会让人以为本机没有/有某能力。
  let capabilities: ExportPreviewPayload["capabilities"] = [];
  let capabilitiesNote: string | null = null;
  try {
    const probe = options.probeTooling ?? probeTooling;
    // 「重新核对」的语义包含"工具链也重问一遍"：否则装完引擎不重启应用就永远看到旧结论
    if (options.refreshTooling) (probe as ToolingProbe).reset?.();
    capabilities = assessExportFormats(await probe());
  } catch (err) {
    capabilitiesNote = `本机工具链探测失败：${messageOf(err)}；能力矩阵本轮不给结论（这不等于这些格式都不能用）`;
  }

  // 平台格式（R94 / K11）：清单永远给（有多少包就说多少），选中才核对；
  // 找不到包 / 包不合规只让面板留白 + 一句原话，不把整页预览打死。
  const platformRoot = options.platformRoot ?? platformPacksRoot();
  const scanned = await scanPlatformPacks(platformRoot);
  const platforms: PlatformPackSummary[] = scanned.map(toSummary);
  let platform: PlatformPreviewPayload | null = null;
  let platformNote: string | null = null;
  if (options.platform !== undefined && options.platform !== "") {
    try {
      const { pack } = await loadPlatformPack(options.platform, platformRoot);
      const { rows, strippedPrefixes } = platformCheckInput(assembled.chapters, pack);
      platform = {
        pack: { ...summaryOf(options.platform, pack), parseError: null },
        rows,
        titles: assembled.chapters.slice(0, TITLE_SAMPLE_LIMIT).map((chapter) => ({
          chapterId: chapter.chapterId,
          title: chapter.title,
          head: platformChapterHead(chapter, pack),
        })),
        checkedChapters: assembled.chapters.length,
        strippedPrefixes,
      };
    } catch (err) {
      platformNote = messageOf(err);
    }
  }

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
    capabilities,
    capabilitiesNote,
    wordlistDirs: dirs,
    platforms,
    platform,
    platformNote,
  };
}

/**
 * 工具链探测的进程内缓存（R87）。
 *
 * 探测要 spawn 十条外部命令（pandoc --version / --list-output-formats / 七个引擎存在性 / jar），
 * 每次预览都跑一遍会把"打开导出页"变成一件慢事；工具链在一次会话里不会变，所以只探一次。
 * 语义由 `onceTooling` 承担并有单测（成功只探一次 / 失败不缓存），这里只负责接上真实探测。
 */
const probeTooling = onceTooling(() => probeExportTooling(realToolDeps()));

export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "未命名作品" : cleaned.slice(0, 40);
}

export function timeStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** 多格式导出的可注入面（测试喂假 pandoc 与假工具链；默认走现场探测 + 真实 spawn） */
export interface ExportRunDeps {
  tooling?: ExportTooling;
  run?: ToolDeps["run"];
  exists?: ToolDeps["exists"];
  /** 平台包根目录（默认仓库 packs/platforms/）；测试用它喂坏包 */
  platformRoot?: string;
}

/** 找一个没被占用的导出基名（同名自动追加序号，绝不覆盖既有导出） */
export async function freeExportBase(gateway: ProjectGateway, base: string, extensions: string[]): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    let free = true;
    for (const ext of extensions) {
      if (await gateway.readDoc(`${EXPORTS_DIR}/${base}${suffix}.${ext}`).catch(() => null)) {
        free = false;
        break;
      }
    }
    if (free) return `${base}${suffix}`;
  }
  throw new YushuError("E_EXPORT_NAME", "导出文件名冲突过多，请稍后重试或修改书名");
}

/**
 * 导出（T1-18 / T5-4）：TXT 由御书自己装配；EPUB / DOCX / PDF 走 pandoc。
 * 防手滑：confirmed 必须显式为 true（服务端校验，UI 另有二次确认）。
 *
 * 三条要紧的口径：
 * ① **产不出的格式在落笔之前就拒**——先写一个 `.md` 再报错，等于把半成品留在作者项目里；
 * ② pandoc 失败时**中途写下的 `.md` 会被清掉**，并把 pandoc 的原始错误带回去（不吞、不改写）；
 * ③ 回执里的 `format` 是**实际产出的格式**，UI 直接照它说话，不许"点了 EPUB 结果拿到 TXT"。
 */
export async function runExport(
  gateway: ProjectGateway,
  payload: ExportRunPayload,
  deps: ExportRunDeps = {},
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
  const format: ExportFormat = payload.format ?? "txt";

  // 平台格式（R94）：**先核对再落笔**。包不合规（比如声明的编码与导出实际写的对不上）
  // 就在写任何文件之前拒掉——先写下 .md 源再报错，等于把半成品留在作者项目里。
  let titleFormat: string | undefined;
  let platformReceipt: ExportRunResult["platform"];
  if (payload.platform !== undefined && payload.platform !== "") {
    const { pack } = await loadPlatformPack(
      payload.platform,
      deps.platformRoot ?? platformPacksRoot(),
    );
    const { rows, strippedPrefixes } = platformCheckInput(assembled.chapters, pack);
    const errors = rows.filter((row: PlatformFormatRow) => row.severity === "error");
    if (errors.length > 0) {
      throw new YushuError(
        "E_EXPORT_PLATFORM_GATE",
        `不按 ${payload.platform} 的格式导出：${errors[0]!.detail}（error 级共 ${errors.length} 条）；未落笔，项目里不会留下半成品`,
      );
    }
    titleFormat = pack.chapter_title_format;
    platformReceipt = {
      id: payload.platform,
      chapterTitleFormat: pack.chapter_title_format,
      errors: errors.length,
      warnings: rows.filter((row: PlatformFormatRow) => row.severity === "warn").length,
      infos: rows.filter((row: PlatformFormatRow) => row.severity === "info").length,
      strippedPrefixes,
    };
  }
  const tooling = deps.tooling ?? (await probeTooling());
  const base = `${sanitizeFileName(bookTitle)}-${timeStamp()}`;

  let path = "";
  let sourcePath: string | undefined;
  let hash = "";

  if (format === "txt") {
    const text = buildTxt(assembled.chapters, {
      bookTitle,
      includeToc: payload.includeToc ?? true,
      stripMarkers: payload.stripMarkers ?? true,
      ...(titleFormat === undefined ? {} : { titleFormat }),
    });
    const named = await freeExportBase(gateway, base, ["txt"]);
    path = `${EXPORTS_DIR}/${named}.txt`;
    hash = (await gateway.writeDoc(path, text)).hash;
  } else {
    // 先看能力，再动笔：这一句顺序就是这一轮的全部意义
    const capability = assessExportFormats(tooling).find((item) => item.format === format);
    if (!capability || !capability.available) {
      throw new YushuError(
        "E_EXPORT_FORMAT_UNAVAILABLE",
        `不产出 ${format.toUpperCase()}：${capability?.reason ?? "未知原因"}（未落笔，项目里不会留下半成品；也不会退而求其次给别的格式）`,
      );
    }
    const markdown = buildMarkdown(assembled.chapters, {
      bookTitle,
      stripMarkers: payload.stripMarkers ?? true,
      ...(titleFormat === undefined ? {} : { titleFormat }),
    });
    const named = await freeExportBase(gateway, base, ["md", format]);
    sourcePath = `${EXPORTS_DIR}/${named}.md`;
    path = `${EXPORTS_DIR}/${named}.${format}`;
    hash = (await gateway.writeDoc(sourcePath, markdown)).hash;

    const toolDeps: ToolDeps = {
      run: deps.run ?? realToolDeps().run,
      exists: deps.exists ?? realToolDeps().exists,
    };
    const converted = await convertWithPandoc(toolDeps, {
      tooling,
      // 给外部命令的必须是**绝对路径**：spawn 出来的 pandoc 用的是主进程的 cwd（开发态是 apps/desktop），
      // 传 `exports/x.md` 它就去那儿找，报"文件不存在"。回执里给 UI 的仍是项目内相对路径。
      sourcePath: join(gateway.root, sourcePath),
      targetPath: join(gateway.root, path),
      format,
      title: bookTitle,
      toc: payload.includeToc ?? true,
    });
    if (!converted.ok) {
      // 半成品不清走就是噪音；清不掉也要把路径说清楚，别让作者自己去找
      const cleaned = await gateway.deleteDoc(sourcePath).then(() => true).catch(() => false);
      throw new YushuError(
        "E_EXPORT_CONVERT",
        `${converted.message}（源文件 ${sourcePath} ${cleaned ? "已清理" : "未清理成功，请手动删除"}）`,
      );
    }
  }

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

  // EPUB 才有质量门禁：EPUBCheck 不在 ⇒ ran:false 且 passed:false，理由写"未校验"
  let gate: ExportGatePayload | undefined;
  if (format === "epub") {
    const toolDeps: ToolDeps = {
      run: deps.run ?? realToolDeps().run,
      exists: deps.exists ?? realToolDeps().exists,
    };
    const report = await validateEpub(toolDeps, { tooling, epubPath: path });
    const verdict = epubGatePassed(report);
    gate = {
      ran: report.ran,
      passed: verdict.passed,
      reason: verdict.reason,
      ...(report.ran
        ? {
            detail: {
              fatalErrors: report.fatalErrors,
              errors: report.errors,
              warnings: report.warnings,
              messages: report.messages.slice(0, 20),
            },
          }
        : {}),
    };
  }

  return {
    path,
    // 非 TXT 时这是 `.md` 源的 hash：EPUB / DOCX 是二进制，没有文本 hash 可给
    hash,
    chapters: assembled.stats.chapters,
    words: assembled.stats.totalWords,
    clean: scan.summary.bySeverity.error === 0,
    format,
    ...(platformReceipt === undefined ? {} : { platform: platformReceipt }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(gate === undefined ? {} : { gate }),
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