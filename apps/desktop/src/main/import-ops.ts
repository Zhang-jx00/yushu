import { countWords } from "@yushu/core";
import {
  cleanImportedText,
  decodeImportedText,
  detectSourceEncoding,
  splitImportedChapters,
  type CleanRule,
} from "@yushu/text";
import { importGate, type ImportGate } from "./import-gate.js";
import type { ImportPreviewPayload, ImportPickPayload, ImportRulePayload } from "../shared/ipc.js";

/**
 * 存量导入的桌面侧「挑文件 + 预演」（M5 / T5-7，R77 第二段）。
 *
 * 两条硬口径写在这里，不在渲染层长第二套：
 * ① **路径不出主进程**：`pickImportSource` 把原生对话框的结果交给闸门登记，只把票据交回去
 *    （连文件名都只给 basename）。渲染层任何时候都不持有、也不传回绝对路径——否则 R77 第一段
 *    那道闸门等于白立，红线 5 的护栏被这条通道自己拆掉。
 * ② **这一段一个字节都不写**：预演只读外部字节、只算报告。建卷建章与字数对账是下一段
 *    （R78，`import:apply` 走 `wrapWrite`），所以这两个通道注册在只读 `wrap` 上是有意的，
 *    并被 `ipc-write-wrappers.test.ts` 的 NON_WRITE 清单钉住。
 *
 * 载荷刻意**不携带正文全文**：一部 32MB 的稿子整篇过 IPC 会让渲染进程卡死，而入库时主进程
 * 可以凭同一张票重新读出、重新切分（同票可读两次正是为此）。界面要看的只是字数与摘录。
 */

/** 摘录上限（字符）：够作者认出"这是哪一章"，不够把整篇正文塞进 IPC */
const EXCERPT_MAX = 80;

/**
 * 默认清洗规则——保守到"几乎不可能误伤正文"，且每条删掉的行都会在报告里留计数与一个样例，
 * 作者核对后再入库（静默改稿是最坏的一种"帮忙"）。
 *
 * 一条已知风险写在这儿而不是藏起来：规则正则允许调用方追加（任务文本要求"可配正则"），
 * 而 JavaScript 的正则不能带超时——一条灾难性回溯的正则（`(a+)+$` 之类）会把主进程卡住。
 * 这里的威胁模型是"作者自己写错"而不是外部注入（票据与 32MB 上限都还在），
 * 因此只加数量与长度上限做限流，真正的挂起保护要等 worker 化（未做，别当成已解决）。
 */
export const DEFAULT_IMPORT_CLEAN_RULES: CleanRule[] = [
  { id: "pure-url", pattern: "^\\s*(?:https?://|www\\.)\\S+\\s*$" },
  { id: "page-hint", pattern: "本章未完|点击下一页|继续阅读更多|无弹窗" },
  { id: "aggregator-watermark", pattern: "笔趣阁|顶点小说|飘天文学|书海阁|妙笔阁" },
];

/** 自定义规则的两条限流：条数与单条长度（防的是手滑，不是攻击） */
const MAX_CUSTOM_RULES = 20;
const MAX_PATTERN_LENGTH = 200;

/** Electron `showOpenDialog` 的最小形状（不 import electron，好让这条路径能被单测驱动） */
export type PickDialog = () => Promise<{ canceled: boolean; filePaths: string[] }>;

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function excerptOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX);
}

/**
 * 弹出原生"选文件"对话框并把结果登记进闸门。
 * 取消 ⇒ 返回 null 且**不发票**；选中的东西不合格 ⇒ 闸门的错误原样抛出（不静默变 null，
 * 那会让界面显示"没反应"而不是"这个文件不行，原因是……"）。
 */
export async function pickImportSource(
  open: PickDialog,
  gate: ImportGate = importGate,
): Promise<ImportPickPayload | null> {
  const result = await open();
  const picked = result.filePaths[0];
  if (result.canceled || !picked) return null;
  const registered = await gate.register(picked);
  return { ticket: registered.ticket, name: registered.name, bytes: registered.bytes };
}

/** 凭票预演：探测 → 解码 → 清洗（带报告）→ 分章（带说明）；零写入 */
export async function previewImport(
  ticket: string,
  options: { gate?: ImportGate; rules?: CleanRule[] } = {},
): Promise<ImportPreviewPayload> {
  const gate = options.gate ?? importGate;
  const custom = options.rules ?? [];
  if (custom.length > MAX_CUSTOM_RULES) {
    throw new Error(`E_IMPORT_RULES：自定义清洗规则 ${String(custom.length)} 条，超过上限 ${String(MAX_CUSTOM_RULES)} 条`);
  }
  for (const rule of custom) {
    if (rule.pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`E_IMPORT_RULES：规则「${rule.id}」的正则长 ${String(rule.pattern.length)} 字符，超过上限`);
    }
  }

  const { path, bytes } = await gate.readTicket(ticket);
  const encoding = detectSourceEncoding(bytes);
  const decoded = decodeImportedText(bytes, encoding);
  // 坏正则在引擎里就地抛错（E_IMPORT_CLEAN 由 wrap 还原成错误信封），这里不吞——吞掉等于作者以为清洗过了
  const { text, report } = cleanImportedText(decoded, { rules: [...DEFAULT_IMPORT_CLEAN_RULES, ...custom] });
  const split = splitImportedChapters(text);

  const rules: ImportRulePayload[] = [
    ...DEFAULT_IMPORT_CLEAN_RULES.map((rule) => ({ ...rule, source: "builtin" as const })),
    ...custom.map((rule) => ({ id: rule.id, pattern: rule.pattern, source: "custom" as const })),
  ];
  const chapters = split.chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    // 与编辑器 / 导出对账同一个 countWords 口径——R78 的字数对账要靠它才对得上
    chars: countWords(chapter.body),
    excerpt: excerptOf(chapter.body),
  }));
  const preambleChars = split.preamble === null ? 0 : countWords(split.preamble.body);

  return {
    name: baseName(path),
    bytes: bytes.length,
    encoding: {
      encoding: encoding.encoding,
      bom: encoding.bom,
      assumed: encoding.assumed,
      ok: encoding.ok,
      note: encoding.note,
    },
    clean: report,
    rules,
    split: {
      hardSplit: split.hardSplit,
      note: split.note,
      chapterCount: split.chapters.length,
      volumeHints: split.volumeHints,
      hasPreamble: split.preamble !== null,
      preambleChars,
    },
    chapters,
    totalChars: chapters.reduce((acc, chapter) => acc + chapter.chars, 0) + preambleChars,
  };
}

/** 用户放弃这次导入：把票作废，别让票据在进程里悬到 TTL 结束 */
export function cancelImport(ticket: string, gate: ImportGate = importGate): void {
  gate.revoke(ticket);
}
