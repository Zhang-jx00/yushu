import { countWords, makeId, YushuError } from "@yushu/core";
import {
  cleanImportedText,
  decodeImportedText,
  detectSourceEncoding,
  splitImportedChapters,
  type CleanReport,
  type CleanRule,
  type EncodingProbe,
  type SplitResult,
} from "@yushu/text";
import {
  OUTLINE_DOC_ID,
  OUTLINE_PATH,
  chapterPath,
  createChapterDraft,
  normalizeOutline,
  parseOutline,
  readChapterFile,
  serializeChapterFile,
  serializeOutline,
  type ChapterBrief,
  type Outline,
  type OutlineVolume,
} from "@yushu/world-engine";
import { importGate, type ImportGate } from "./import-gate.js";
import type { ProjectGateway } from "./file-gateway.js";
import { takePreDestructiveSnapshot } from "./snapshot-ops.js";
import type {
  ImportAppliedChapterPayload,
  ImportApplyPayload,
  ImportApplyResultPayload,
  ImportPickPayload,
  ImportPreviewPayload,
  ImportRulePayload,
} from "../shared/ipc.js";

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

/**
 * 导入章纲的细项一律留空。
 * 六个格子填什么是**作者的创作决策**，从一篇现成稿子里反推出来的是猜测——
 * 猜写进真源，以后就没人知道哪句是作者说的、哪句是工具编的。
 */
const EMPTY_BRIEF: ChapterBrief = {
  who: "",
  where: "",
  goal: "",
  obstacle: "",
  turn: "",
  result: "",
  hook: "",
};

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

/**
 * 预演与入库**共用**的那段计算：字节 → 探测 → 解码 → 清洗 → 分章 → 逐章字数。
 *
 * 只允许有一条管线。若入库另算一遍，"预演报的字数"与"落盘的字数"就对不上，
 * 而字数对账唯一的价值恰恰是拿两边比一下——两套算法等于自证无效。
 */
async function planFromTicket(
  ticket: string,
  gate: ImportGate,
  custom: CleanRule[],
): Promise<{
  name: string;
  bytes: number;
  encoding: EncodingProbe;
  report: CleanReport;
  split: SplitResult;
  chapters: { title: string; body: string; chars: number }[];
  preambleChars: number;
  totalChars: number;
}> {
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
  // 坏正则在引擎里就地抛错（由 wrap 还原成错误信封），这里不吞——吞掉等于作者以为清洗过了
  const { text, report } = cleanImportedText(decoded, { rules: [...DEFAULT_IMPORT_CLEAN_RULES, ...custom] });
  const split = splitImportedChapters(text);
  const chapters = split.chapters.map((chapter) => ({
    title: chapter.title,
    body: chapter.body,
    // 与编辑器 / 导出同一个 countWords 口径——对账要靠它对得上
    chars: countWords(chapter.body),
  }));
  const preambleChars = split.preamble === null ? 0 : countWords(split.preamble.body);
  return {
    name: baseName(path),
    bytes: bytes.length,
    encoding,
    report,
    split,
    chapters,
    preambleChars,
    totalChars: chapters.reduce((acc, chapter) => acc + chapter.chars, 0) + preambleChars,
  };
}

/** 预演：凭票读字节算编码 / 清洗 / 分章三份报告；零写入 */
export async function previewImport(
  ticket: string,
  options: { gate?: ImportGate; rules?: CleanRule[]; gateway?: ProjectGateway } = {},
): Promise<ImportPreviewPayload> {
  const gate = options.gate ?? importGate;
  const custom = options.rules ?? [];
  const plan = await planFromTicket(ticket, gate, custom);
  // 顺带回报大纲 hash：确认入库时要把它带回来做并发检测。
  // 为什么在这里读而不是让渲染层自己去读：渲染层不该知道大纲的路径字符串（那等于把真源路径
  // 抄进界面，改一次漏一处），而读一次不改任何东西 ⇒ 预演的"零写入"口径不受影响。
  const outlineHash =
    options.gateway === undefined
      ? null
      : await options.gateway.readDoc(OUTLINE_PATH).then((snap) => snap.hash).catch(() => null);
  const rules: ImportRulePayload[] = [
    ...DEFAULT_IMPORT_CLEAN_RULES.map((rule) => ({ ...rule, source: "builtin" as const })),
    ...custom.map((rule) => ({ id: rule.id, pattern: rule.pattern, source: "custom" as const })),
  ];
  return {
    name: plan.name,
    bytes: plan.bytes,
    outlineHash,
    encoding: {
      encoding: plan.encoding.encoding,
      bom: plan.encoding.bom,
      assumed: plan.encoding.assumed,
      ok: plan.encoding.ok,
      note: plan.encoding.note,
    },
    clean: plan.report,
    rules,
    split: {
      hardSplit: plan.split.hardSplit,
      note: plan.split.note,
      chapterCount: plan.split.chapters.length,
      volumeHints: plan.split.volumeHints,
      hasPreamble: plan.split.preamble !== null,
      preambleChars: plan.preambleChars,
    },
    // 正文不过 IPC：只给字数与摘录
    chapters: plan.chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      chars: chapter.chars,
      excerpt: excerptOf(chapter.body),
    })),
    totalChars: plan.totalChars,
  };
}

/**
 * 入库（R79）：把预演过的那份稿件写成**一卷 + 章纲 + 章节草稿**。
 *
 * 次序是这条通道全部的风险所在，逐步固定下来：
 * ① 先算（同一条管线，坏正则 / 空文件在这一步就抛，盘上什么都没发生）；
 * ② 再判（没切开要显式确认、幕名认不出就报错列出可选——**不替作者猜结构**）；
 * ③ 冲突预检（大纲 hash 不一致直接拒，连快照都不做，免得留一份"什么都没改"的快照）；
 * ④ 破坏前快照（拿不到就阻断，撤销窗口必须在写之前存在）；
 * ⑤ **先写大纲、后写草稿**：宁可留下"大纲有章纲、草稿还没建"（稿件总览里看得见、
 *    可以照着补建），也不留"草稿躺在盘上而大纲不认"的孤儿文件——后者在界面上根本不存在；
 * ⑥ 逐章读回对账（写进去的字数与预演报的字数一比），对不上一律点名，不静默算成功；
 * ⑦ 全部成功才作废票据：中途失败时票据仍在，作者修一修可以原地重试。
 *
 * 楔子（首章之前的内容）**不入库**也不静默丢：结果里给出字数与摘录，界面上点名，
 * 让作者自己决定挪去哪儿——把它塞进第一章等于替作者改了书的开头。
 */
export async function applyImport(
  gateway: ProjectGateway,
  request: ImportApplyPayload,
  gate: ImportGate = importGate,
): Promise<ImportApplyResultPayload> {
  const plan = await planFromTicket(request.ticket, gate, request.rules ?? []);
  if (plan.chapters.length === 0 || plan.totalChars === 0) {
    throw new YushuError("E_IMPORT_EMPTY", "没有可入库的正文（空文件，或清洗规则把内容全删掉了）");
  }
  if (!plan.split.hardSplit && request.confirmSingleChapter !== true) {
    throw new YushuError(
      "E_IMPORT_CONFIRM",
      `这篇稿子没被切成章（整篇 ${String(plan.totalChars)} 字将作为一章入库），需要显式确认后再入库`,
    );
  }

  const trimmed = (value?: string): string => value?.trim() ?? "";
  const fallbackTitle = plan.name.replace(/\.[^.]+$/, "");
  const volumeTitle = trimmed(request.volumeTitle) !== "" ? trimmed(request.volumeTitle) : `导入·${fallbackTitle}`;
  const outlineSnap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  const existing = outlineSnap === null ? null : parseOutline(outlineSnap.content);

  let outline: Outline;
  let act: string;
  if (existing === null) {
    // 项目还没有大纲：自己建一份最小的。**存量导入是冷启动入口，
    // 不能要求作者先跑一遍 AI 生成大纲——AI 关掉时这条路就该自己能走通。**
    act = trimmed(request.act) !== "" ? trimmed(request.act) : "导入";
    outline = {
      apiVersion: "yushu.outline/v1",
      format_version: 1,
      id: OUTLINE_DOC_ID,
      master: {
        title: volumeTitle,
        logline: "",
        theme: "",
        notes: "由存量稿件导入创建：章纲六项（谁 / 何地 / 目标 / 障碍 / 转折 / 结果 / 钩子）留空待补",
        acts: [{ name: act, desc: "存量导入的卷都挂在这一幕" }],
      },
      volumes: [],
    };
  } else {
    const acts = existing.master.acts.map((item) => item.name);
    act = trimmed(request.act) !== "" ? trimmed(request.act) : (acts[0] ?? "");
    if (!acts.includes(act)) {
      throw new YushuError(
        "E_IMPORT_ACT",
        `总纲里没有这一幕：「${act}」，可选：${acts.length > 0 ? acts.join("、") : "（总纲没有任何一幕）"}`,
      );
    }
    outline = existing;
  }

  const volumeId = makeId("vol");
  const drafts = plan.chapters.map((chapter, index) => {
    const outlineId = makeId("co");
    const draft = createChapterDraft({
      volume: volumeId,
      idx: index + 1,
      // 标题为空只发生在"没切开"那一章：拿文件名兜底，不编一个"第 N 章"
      title: chapter.title.trim() !== "" ? chapter.title : fallbackTitle,
      outlineRef: outlineId,
    });
    return {
      outlineId,
      chapterId: draft.id,
      title: draft.title,
      expectedChars: chapter.chars,
      path: chapterPath(volumeId, draft.id),
      text: serializeChapterFile({ ...draft, word_count: chapter.chars }, chapter.body),
    };
  });

  const volume: OutlineVolume = {
    id: volumeId,
    title: volumeTitle,
    act,
    desc: `由存量导入创建（源文件 ${plan.name}，${String(plan.bytes)} 字节）；章纲细项待补`,
    chapters: drafts.map((row) => ({
      id: row.outlineId,
      idx: 0,
      title: row.title,
      brief: { ...EMPTY_BRIEF },
      chapter_id: row.chapterId,
      scene_ids: [],
    })),
  };
  const next: Outline = { ...outline, volumes: [...outline.volumes, volume] };
  // normalizeOutline 返回新对象（不改入参）：卷内 idx 从 1 重编号、缺 id 补齐、id 唯一性断言
  const normalized = normalizeOutline(next);
  const outlineText = serializeOutline(normalized);

  if (outlineSnap !== null && request.baseHash !== undefined && outlineSnap.hash !== request.baseHash) {
    throw new YushuError(
      "E_DOC_CONFLICT",
      `大纲并发冲突：${OUTLINE_PATH} 的 hash 与确认时不一致，导入已取消（请重新预演再确认）`,
    );
  }
  if (outlineSnap === null && request.baseHash !== undefined) {
    throw new YushuError("E_DOC_CONFLICT", `大纲并发冲突：确认时读过 ${OUTLINE_PATH}，现在它不存在了，导入已取消`);
  }

  const pre = await takePreDestructiveSnapshot(gateway);
  const written: string[] = [];
  // 两层并发保护：调用方带了确认时的 hash 就用它（挡"作者看报告那几十秒里有人改了大纲"），
  // 没带就用本次自己读到的 hash（挡写入竞态，也满足网关"已存在的文件不许无 baseHash 盲写"这条硬规矩）。
  const writeBaseHash = request.baseHash ?? outlineSnap?.hash;
  const outlineWritten = await gateway.writeDoc(OUTLINE_PATH, outlineText, writeBaseHash);
  try {
    for (const row of drafts) {
      const clash = await gateway.readDoc(row.path).catch(() => null);
      if (clash !== null) {
        throw new YushuError("E_DOC_CONFLICT", `章节草稿已存在，拒绝覆盖：${row.path}`);
      }
      await gateway.writeDoc(row.path, row.text);
      written.push(row.path);
    }
  } catch (err) {
    throw new YushuError(
      "E_IMPORT_PARTIAL",
      `大纲已写入，但章节草稿只写了 ${String(written.length)}/${String(drafts.length)} 份——` +
        `可用导入前的快照「${pre.snapshot?.id ?? "（无 id）"}」撤销：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 逐章读回对账：写进去的字数必须等于预演报的字数
  const created: ImportAppliedChapterPayload[] = [];
  const mismatched: string[] = [];
  for (const row of drafts) {
    const back = await gateway.readDoc(row.path);
    const { chapter } = readChapterFile(back.content);
    const reconciled = chapter.word_count === row.expectedChars;
    if (!reconciled) mismatched.push(`${row.title}（预演 ${String(row.expectedChars)} 字 / 落盘 ${String(chapter.word_count)} 字）`);
    created.push({
      outlineId: row.outlineId,
      chapterId: row.chapterId,
      path: row.path,
      title: row.title,
      expectedChars: row.expectedChars,
      writtenWords: chapter.word_count,
      reconciled,
    });
  }

  // 成功才作废：失败时票据留着，作者改一改可以原地重试（重新选文件太折腾）
  gate.revoke(request.ticket);

  const totalWrittenWords = created.reduce((acc, row) => acc + row.writtenWords, 0);
  return {
    volumeId,
    volumeTitle,
    act,
    outlinePath: OUTLINE_PATH,
    outlineHash: outlineWritten.hash,
    snapshotId: pre.snapshot?.id ?? null,
    created,
    mismatched,
    preamble:
      plan.split.preamble === null
        ? null
        : { chars: plan.preambleChars, excerpt: excerptOf(plan.split.preamble.body) },
    totalExpectedChars: plan.chapters.reduce((acc, row) => acc + row.chars, 0),
    totalWrittenWords,
    note:
      `已入库 ${String(created.length)} 章 · ${String(totalWrittenWords)} 字` +
      (mismatched.length === 0 ? "（逐章字数对账通过）" : `（${String(mismatched.length)} 章对不上，见清单）`) +
      (plan.split.preamble === null ? "" : `；另有 ${String(plan.preambleChars)} 字在首章之前，未入库`),
  };
}

/** 用户放弃这次导入：把票作废，别让票据在进程里悬到 TTL 结束 */
export function cancelImport(ticket: string, gate: ImportGate = importGate): void {
  gate.revoke(ticket);
}
