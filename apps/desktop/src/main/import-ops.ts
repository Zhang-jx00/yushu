/* SPDX-License-Identifier: Apache-2.0 */
import { countWords, makeId, YushuError } from "@yushu/core";
import {
  applyImportCorrections,
  cleanImportedText,
  decodeImportedText,
  detectSourceEncoding,
  detectMiscuts,
  findChapterCandidates,
  isStrictChapterTitle,
  splitImportedChapters,
  splitImportedChaptersAt,
  type ChapterCandidate,
  type CleanReport,
  type CleanRule,
  type EncodingProbe,
  type ImportCorrection,
  type MiscutRow,
  type SplitResult,
} from "@yushu/text";
import {
  IMPORT_JOB_API_VERSION,
  IMPORT_JOB_FORMAT_VERSION,
  OUTLINE_DOC_ID,
  OUTLINE_PATH,
  chapterPath,
  createChapterDraft,
  isResumableImportJob,
  normalizeOutline,
  parseOutline,
  readChapterFile,
  serializeChapterFile,
  serializeOutline,
  type ChapterBrief,
  type ImportJob,
  type Outline,
  type OutlineVolume,
} from "@yushu/world-engine";
import { importGate, type ImportGate, type ImportPlanContext } from "./import-gate.js";
import {
  fromJobPlan,
  isSameSource,
  listImportJobs,
  newImportJobId,
  readImportJob,
  resumableJobs,
  sourceFingerprint,
  toJobChapters,
  toJobPlan,
  writeImportJob,
} from "./import-job-ops.js";
import type { ProjectGateway } from "./file-gateway.js";
import { takePreDestructiveSnapshot } from "./snapshot-ops.js";
import type {
  ImportAppliedChapterPayload,
  ImportApplyPayload,
  ImportApplyResultPayload,
  ImportMiscutPayload,
  ImportPickPayload,
  ImportPreviewPayload,
  ImportResumePayload,
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
  /**
   * 计划上下文覆盖（续跑时用）：新选一张票 ⇒ 票上没有上次的计划（AI 筛过哪些、作者校正过什么），
   * 续跑必须**重放同一份切分**，否则算出来的章与上次不是同一批，续跑等于把两本书接在一起。
   */
  contextOverride?: ImportPlanContext,
): Promise<{
  name: string;
  bytes: number;
  /** 源文件 sha256（续跑时核对是不是同一份稿子用） */
  sha256: string;
  encoding: EncodingProbe;
  report: CleanReport;
  split: SplitResult;
  chapters: { title: string; body: string; chars: number }[];
  preambleChars: number;
  totalChars: number;
  /** 海选候选（AI 筛与人工校正的共同依据） */
  candidates: ChapterCandidate[];
  /** 严筛认下的候选序号（面板要能说清"这几条已经是确定的章标题"） */
  strictIndexes: number[];
  /** AI 筛过后保留的候选序号（undefined = 还没让 AI 筛过） */
  keeps: number[] | undefined;
  /** AI 筛选那一次的出处与丢弃 / 回退说明 */
  aiState: ImportPlanContext["ai"];
  /** 已应用的人工校正条数 */
  correctionCount: number;
}> {
  if (custom.length > MAX_CUSTOM_RULES) {
    throw new Error(`E_IMPORT_RULES：自定义清洗规则 ${String(custom.length)} 条，超过上限 ${String(MAX_CUSTOM_RULES)} 条`);
  }
  for (const rule of custom) {
    if (rule.pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`E_IMPORT_RULES：规则「${rule.id}」的正则长 ${String(rule.pattern.length)} 字符，超过上限`);
    }
  }
  // 计划上下文**同步**先取：它是纯内存的票上状态，不会中途变；
  // 放在异步读字节之前 ⇒ 少一个"读到一半票被作废"的失败面
  const context = contextOverride ?? gate.planOf(ticket);
  const { path, bytes } = await gate.readTicket(ticket);
  const encoding = detectSourceEncoding(bytes);
  const decoded = decodeImportedText(bytes, encoding);
  const fingerprint = sourceFingerprint(baseName(path), bytes);
  // 坏正则在引擎里就地抛错（由 wrap 还原成错误信封），这里不吞——吞掉等于作者以为清洗过了
  const { text, report } = cleanImportedText(decoded, { rules: [...DEFAULT_IMPORT_CLEAN_RULES, ...custom] });

  // 海选（I09 §3.4 的前半段）：捞出疑似章节标题的行；严筛再从中挑出"确定的章标题"
  const candidates = findChapterCandidates(text);
  const textLines = text.split("\n");
  const strictIndexes = candidates
    .map((item, index) => (isStrictChapterTitle(textLines[item.line - 1] ?? "") ? index : -1))
    .filter((index) => index >= 0);

  // 计划上下文跟着票据走（AI 筛过的结果 + 作者的校正）——预演与入库必须是同一份；
  // 续跑时由任务记录提供（票是新的，上面没有上次的计划）
  const keeps = context.keeps;
  const aiLines =
    keeps === undefined
      ? undefined
      : keeps.map((index) => candidates[index]?.line).filter((line): line is number => line !== undefined);
  const split = aiLines === undefined ? splitImportedChapters(text) : splitImportedChaptersAt(text, aiLines);
  const corrected = applyImportCorrections(split.chapters, context.corrections);
  const chapters = corrected.map((chapter) => ({
    title: chapter.title,
    body: chapter.body,
    // 与编辑器 / 导出同一个 countWords 口径——对账要靠它对得上
    chars: countWords(chapter.body),
  }));
  const preambleChars = split.preamble === null ? 0 : countWords(split.preamble.body);
  return {
    name: baseName(path),
    bytes: bytes.length,
    /** 源文件指纹（续跑时核对是不是同一份稿子用） */
    sha256: fingerprint.sha256,
    encoding,
    report,
    split,
    chapters,
    preambleChars,
    totalChars: chapters.reduce((acc, chapter) => acc + chapter.chars, 0) + preambleChars,
    candidates,
    strictIndexes,
    keeps,
    aiState: context.ai,
    correctionCount: context.corrections.length,
  };
}

/** 误切清单（I09 §3.5 的三类校验）→ 面板载荷 */
function toMiscutPayload(rows: MiscutRow[]): ImportMiscutPayload[] {
  return rows.map((row) => ({
    index: row.index,
    title: row.title,
    chars: row.chars,
    issues: row.issues.map((issue) => ({ code: issue.code, message: issue.message })),
  }));
}

/** 预演：凭票读字节算编码 / 清洗 / 分章三份报告；零写入 */
export async function previewImport(
  ticket: string,
  options: { gate?: ImportGate; rules?: CleanRule[]; gateway?: ProjectGateway } = {},
): Promise<ImportPreviewPayload> {
  const gate = options.gate ?? importGate;
  const custom = options.rules ?? [];
  let plan = await planFromTicket(ticket, gate, custom);
  // 续跑线索：**主进程按源文件指纹核对**（渲染层不自己判是不是同一份）
  const resume = await findResumeFor(options.gateway, plan);
  if (resume !== null) {
    // 有可续跑的任务 ⇒ 预演必须显示**续跑真正会写的那份**：续跑重放的是任务记录里的计划
    // （AI 筛过哪些候选、作者校正过什么），而新选的票上什么都没有。
    // 不重算的话，界面上显示的是"正则切的 40 章"、续跑写的是"上次的 12 章" ⇒ 作者点下去必被那道闸拒。
    const job = await readImportJob((options.gateway as ProjectGateway).root, resume.job_id);
    if (job !== null) {
      plan = await planFromTicket(ticket, gate, custom, { ...fromJobPlan(job.plan) });
    }
  }
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
      // **用校正后的章数**（`plan.chapters`），不是原始切分的章数：
      // 人工合并 / 拆分 / 重排都只改计划，界面上那个"分章预演：N 章"必须跟着变——
      // 数字不动 ⇒ 作者以为自己合并了，其实什么都没发生（R107 预演当场抓到过这个）。
      chapterCount: plan.chapters.length,
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
    // 海选候选：AI 只能指认这批的序号；作者也靠它挑"该在这里切开"的位置
    candidates: plan.candidates.map((item, index) => ({
      index,
      line: item.line,
      text: item.text,
      rule: item.rule,
      strict: plan.strictIndexes.includes(index),
    })),
    // 误切清单：三类校验的异常，逐条点名
    miscuts: toMiscutPayload(detectMiscuts(plan.chapters)),
    ai: {
      used: plan.keeps !== undefined,
      provider_id: plan.aiState?.provider_id ?? "",
      model: plan.aiState?.model ?? "",
      kept: plan.keeps === undefined ? 0 : plan.keeps.length,
      rejected: plan.aiState?.rejected ?? [],
      fallback: plan.aiState?.fallback ?? "",
      corrections: plan.correctionCount,
    },
    // 续跑线索：**主进程按源文件指纹核对**（渲染层不自己判是不是同一份）
    resume,
  };
}

/**
 * 这份稿子有没有一份**可续跑**的任务记录。
 *
 * 判据是**源文件指纹**（basename + 字节数 + sha256）：只有同一份稿子才谈得上续跑。
 * 找不到就返回 null（没有就是没有，不给作者一条"可能是"的线索）。
 */
async function findResumeFor(
  gateway: ProjectGateway | undefined,
  plan: { name: string; bytes: number; sha256: string },
): Promise<ImportResumePayload | null> {
  if (gateway === undefined) return null;
  const jobs = resumableJobs(await listImportJobs(gateway.root));
  const match = jobs.find((job) =>
    isSameSource(job, { name: plan.name, size_bytes: plan.bytes, sha256: plan.sha256 }),
  );
  if (match === undefined) return null;
  return {
    job_id: match.id,
    source_name: match.source.name,
    last_chapter: match.checkpoint.last_chapter,
    total_chapters: match.chapters.length,
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
  // 登记"正在入库"：**要在第一个 await 之前**——取消通道的回执靠它答"这次是让入库停下还是放弃"
  activeApplies.add(request.ticket);
  try {
    return await runImport(gateway, request, gate);
  } finally {
    activeApplies.delete(request.ticket);
  }
}

async function runImport(
  gateway: ProjectGateway,
  request: ImportApplyPayload,
  gate: ImportGate,
): Promise<ImportApplyResultPayload> {
  // 续跑：凭任务记录接着写。源文件与切分都要**核对过**才认（见下面的三道闸）
  const resumeJob =
    request.jobId === undefined ? null : await loadResumeJob(gateway, request.jobId);
  const plan = await planFromTicket(
    request.ticket,
    gate,
    request.rules ?? [],
    resumeJob === null ? undefined : { ...fromJobPlan(resumeJob.plan) },
  );
  if (plan.chapters.length === 0 || plan.totalChars === 0) {
    throw new YushuError("E_IMPORT_EMPTY", "没有可入库的正文（空文件，或清洗规则把内容全删掉了）");
  }
  if (!plan.split.hardSplit && request.confirmSingleChapter !== true) {
    throw new YushuError(
      "E_IMPORT_CONFIRM",
      `这篇稿子没被切成章（整篇 ${String(plan.totalChars)} 字将作为一章入库），需要显式确认后再入库`,
    );
  }
  if (resumeJob !== null) assertResumeMatches(resumeJob, plan);

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

  // 续跑用任务记录里的卷 id 与章 id（重算会换 id ⇒ 续跑会写到别的地方去）
  const volumeId = resumeJob?.volume_id ?? makeId("vol");
  const drafts = plan.chapters.map((chapter, index) => {
    const stored = resumeJob?.chapters[index];
    const outlineId = stored?.outline_id ?? makeId("co");
    const draft = createChapterDraft({
      volume: volumeId,
      idx: index + 1,
      // 标题为空只发生在"没切开"那一章：拿文件名兜底，不编一个"第 N 章"
      title: chapter.title.trim() !== "" ? chapter.title : fallbackTitle,
      outlineRef: outlineId,
    });
    const path = chapterPath(volumeId, draft.id);
    // 章 id 与路径是**由卷 id + 章纲 id 确定性派生**的：续跑时重算出来必须与记录里的一致，
    // 不一致说明生成规则变了 ⇒ 旧记录里的路径已经失效，宁可拒也别写到别的地方。
    if (stored !== undefined && (stored.chapter_id !== draft.id || stored.path !== path)) {
      throw new YushuError(
        "E_IMPORT_RESUME_ID",
        `章 id / 路径的生成方式与这份任务记录对不上（第 ${String(index + 1)} 章）——` +
          "请取消续跑、重新导入一次",
      );
    }
    return {
      outlineId,
      chapterId: draft.id,
      title: draft.title,
      expectedChars: chapter.chars,
      path,
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
  // 续跑：卷可能**已经在盘上了**（上次写过大纲）⇒ 这次不重写大纲，也不把同一卷加两遍。
  // 重写会把作者在大纲上的改动覆盖掉（作者可能已经改过章纲）。
  const alreadyInOutline = existing !== null && existing.volumes.some((item) => item.id === volumeId);
  const next: Outline = alreadyInOutline
    ? outline
    : { ...outline, volumes: [...outline.volumes, volume] };
  // normalizeOutline 返回新对象（不改入参）：卷内 idx 从 1 重编号、缺 id 补齐、id 唯一性断言
  const normalized = normalizeOutline(next);
  const outlineText = serializeOutline(normalized);

  if (!alreadyInOutline && outlineSnap !== null && request.baseHash !== undefined && outlineSnap.hash !== request.baseHash) {
    throw new YushuError(
      "E_DOC_CONFLICT",
      `大纲并发冲突：${OUTLINE_PATH} 的 hash 与确认时不一致，导入已取消（请重新预演再确认）`,
    );
  }
  if (!alreadyInOutline && outlineSnap === null && request.baseHash !== undefined) {
    throw new YushuError("E_DOC_CONFLICT", `大纲并发冲突：确认时读过 ${OUTLINE_PATH}，现在它不存在了，导入已取消`);
  }

  const pre = await takePreDestructiveSnapshot(gateway);
  const written: string[] = [];
  // 两层并发保护：调用方带了确认时的 hash 就用它（挡"作者看报告那几十秒里有人改了大纲"），
  // 没带就用本次自己读到的 hash（挡写入竞态，也满足网关"已存在的文件不许无 baseHash 盲写"这条硬规矩）。
  const writeBaseHash = request.baseHash ?? outlineSnap?.hash;
  // 续跑且卷已在 ⇒ **不重写大纲**（作者可能改过它）；否则按新卷写
  const outlineWritten = alreadyInOutline
    ? outlineSnap
    : await gateway.writeDoc(OUTLINE_PATH, outlineText, writeBaseHash);
  if (outlineWritten === null) {
    throw new YushuError("E_IMPORT_EMPTY", "大纲写不进去：导入已取消（盘上没有可写的大纲）");
  }

  // 任务记录：落盘之后才算"有这次导入"——**先落记录再写盘**，
  // 反过来的话（先写盘后落记录）崩在中间就没人知道上次导到哪了。
  const job: ImportJob = resumeJob ?? {
    apiVersion: IMPORT_JOB_API_VERSION,
    format_version: IMPORT_JOB_FORMAT_VERSION,
    id: newImportJobId(),
    source: {
      name: plan.name,
      size_bytes: plan.bytes,
      sha256: plan.sha256,
      detected_encoding: plan.encoding.encoding,
    },
    status: "pending",
    checkpoint: { last_chapter: 0, resumable: true },
    volume_id: volumeId,
    plan: toJobPlan({
      ...(plan.keeps === undefined ? {} : { keeps: plan.keeps }),
      corrections: gate.planOf(request.ticket).corrections,
    }),
    chapters: toJobChapters(
      drafts.map((row) => ({
        outline_id: row.outlineId,
        chapter_id: row.chapterId,
        path: row.path,
        title: row.title,
        expected_chars: row.expectedChars,
      })),
    ),
  };
  await writeImportJob(gateway.root, { ...job, status: "running" });

  let stopped = false;
  try {
    for (const [index, row] of drafts.entries()) {
      // 取消：作者点了「取消入库」⇒ 在**章的边界**上停（半章写进去是半个章）
      if (isImportCancelRequested(request.ticket)) {
        stopped = true;
        break;
      }
      const clash = await gateway.readDoc(row.path).catch(() => null);
      if (clash !== null) {
        // 续跑：这一章上次已经写过了 ⇒ 跳过（**不覆盖**：作者可能手工改过它，
        // 覆盖掉等于毁掉作者的东西；对账会把字数对不上的那条点名出来）
        if (resumeJob !== null) {
          written.push(row.path);
          continue;
        }
        throw new YushuError("E_DOC_CONFLICT", `章节草稿已存在，拒绝覆盖：${row.path}`);
      }
      await gateway.writeDoc(row.path, row.text);
      written.push(row.path);
      // 断点：每写完一章就记一次（I09 §2.7「最后成功章号」）
      await writeImportJob(gateway.root, {
        ...job,
        status: "running",
        checkpoint: { last_chapter: index + 1, resumable: true },
      });
    }
  } catch (err) {
    await writeImportJob(gateway.root, {
      ...job,
      status: "failed",
      checkpoint: { last_chapter: written.length, resumable: true },
      note: `写到第 ${String(written.length)} 章时出错：${err instanceof Error ? err.message : String(err)}`,
    });
    throw new YushuError(
      "E_IMPORT_PARTIAL",
      `大纲已写入，但章节草稿只写了 ${String(written.length)}/${String(drafts.length)} 份——` +
        `可用导入前的快照「${pre.snapshot?.id ?? "（无 id）"}」撤销：` +
        `也可留着断点续跑（任务记录 ${job.id}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (stopped) {
    await writeImportJob(gateway.root, {
      ...job,
      status: "needs_review",
      checkpoint: { last_chapter: written.length, resumable: true },
      note: `作者中途取消：已写入 ${String(written.length)}/${String(drafts.length)} 章，可续跑`,
    });
    // 取消不作废票据：作者可能想接着跑（重选同一份稿子即可续跑）
    return {
      volumeId,
      volumeTitle,
      act,
      outlinePath: OUTLINE_PATH,
      outlineHash: outlineWritten.hash,
      snapshotId: pre.snapshot?.id ?? null,
      created: [],
      mismatched: [],
      jobId: job.id,
      stopped: true,
      writtenChapters: written.length,
      totalChapters: drafts.length,
      preamble:
        plan.split.preamble === null
          ? null
          : { chars: plan.preambleChars, excerpt: excerptOf(plan.split.preamble.body) },
      totalExpectedChars: plan.chapters.reduce((acc, row) => acc + row.chars, 0),
      totalWrittenWords: 0,
      note: `已按你的要求停下：写入了 ${String(written.length)}/${String(drafts.length)} 章，剩下的可以续跑（任务记录 ${job.id}）`,
    };
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
  clearImportCancel(request.ticket);

  // 任务收尾：done（不可续跑）；对账的差值照实记（I09 §5 的 reconcile 三元组）
  const chapterCharsSum = created.reduce((acc, row) => acc + row.writtenWords, 0);
  await writeImportJob(gateway.root, {
    ...job,
    status: "done",
    checkpoint: { last_chapter: drafts.length, resumable: false },
    reconcile: {
      source_chars: plan.totalChars,
      chapter_chars_sum: chapterCharsSum,
      delta: chapterCharsSum - plan.totalChars,
    },
    note: `已入库 ${String(created.length)} 章`,
  });

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
    jobId: job.id,
    stopped: false,
    writtenChapters: written.length,
    totalChapters: drafts.length,
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

/* ---------------- 取消（可中断的那一半） ---------------- */

/**
 * 取消标记：键是**票据**（渲染层唯一能拿到的把手）。
 *
 * 为什么是票据不是任务 id：作者点「取消入库」的时候，入库还在跑、任务 id 还没回到界面上，
 * 渲染层手上只有票。票据同时也是闸门的把手 ⇒ 一条通道能同时表达"停下"与"作废"两件事。
 */
const cancelRequests = new Set<string>();

/**
 * 正在入库的票（键同取消标记）。
 *
 * 为什么要有这张表：取消通道的回执必须答对"**这次取消是让入库停下，还是放弃这次导入**"。
 * 只看"取消标记在不在"会答错——第一次点「停下」时标记是刚写进去的，回执会说"没在入库"，
 * 面板就会把这次导入当成"放弃"（把预演清空），而入库其实还在跑、还会停下来。
 */
const activeApplies = new Set<string>();

/** 这个票是不是正在入库 */
export function isImportActive(ticket: string): boolean {
  return activeApplies.has(ticket);
}

/** 记一次取消请求（入库循环在**章的边界**上检查它） */
export function requestImportCancel(ticket: string): void {
  cancelRequests.add(ticket);
}

/** 取消请求在不在 */
export function isImportCancelRequested(ticket: string): boolean {
  return cancelRequests.has(ticket);
}

/** 清掉取消标记（一次入库结束后必须清，否则下一张票会一上来就"被取消"） */
export function clearImportCancel(ticket: string): void {
  cancelRequests.delete(ticket);
}

/**
 * 用户放弃这次导入：把票作废，别让票据在进程里悬到 TTL 结束；**若正在入库，同时记一次取消**。
 *
 * R99 死代码审计点名它"尚未接线"（登记在 `test/dead-exports.test.ts` 的名单里），R108 把它接上了：
 * 界面有了「取消导入」的入口（R108 预演 step70 取证）。
 * 留着而不删，是因为它表达的是闸门已有能力的正确用法（`gate.revoke`），删了反而会让那条路重新被发明一遍。
 */
export function cancelImport(ticket: string, gate: ImportGate = importGate): void {
  requestImportCancel(ticket);
  gate.revoke(ticket);
}

/**
 * 「取消」这件事的**决策**（IPC 处理器只做转发，决策在这里——好让单测能驱动它）。
 *
 * 两种语义，不能混：
 * ① **正在入库** ⇒ 只记取消标记，**绝不作废票据**——作废了这次入库自己就再也读不到票
 *    （E_IMPORT_TICKET），一次"停下"会把整批导入变成失败（这条是预演 step70 当场撞出来的）；
 * ② **没有在入库** ⇒ 放弃这次导入：作废票据（选中过的文件不会再被读到）+ 也记一次取消。
 */
export function decideImportCancel(
  ticket: string,
  gate: ImportGate = importGate,
): { stopped: boolean; revoked: boolean; note: string } {
  if (isImportActive(ticket)) {
    requestImportCancel(ticket);
    return {
      stopped: true,
      revoked: false,
      note: "已请求停下：正在入库的话会在写完当前这一章后停，剩下的可以续跑",
    };
  }
  cancelImport(ticket, gate);
  return {
    stopped: false,
    revoked: true,
    note: "已放弃这次导入：票据作废了，选中过的文件不会再被读到",
  };
}

/* ---------------- 续跑（可续的那一半） ---------------- */

/** 读一份任务记录并确认它可续；不可续就说清为什么 */
async function loadResumeJob(gateway: ProjectGateway, jobId: string): Promise<ImportJob> {
  const job = await readImportJob(gateway.root, jobId);
  if (job === null) {
    throw new YushuError(
      "E_IMPORT_RESUME",
      `找不到任务记录「${jobId}」：它可能已经被删了（任务记录在 .yushu/imports/ 下，不是项目内容）`,
    );
  }
  if (!isResumableImportJob(job)) {
    throw new YushuError(
      "E_IMPORT_RESUME",
      `任务「${jobId}」已经不能续跑了（状态 ${job.status}，断点可续=${String(job.checkpoint.resumable)}）`,
    );
  }
  return job;
}

/**
 * 续跑的三道闸：**同一份稿子**、**同一份切分**、**同一份字数**。
 *
 * 三道缺一道都不放行：把两本书接在一起，比续跑失败更坏——
 * 作者看到的是"导入成功"，盘上却是一本拼起来的书。
 */
function assertResumeMatches(job: ImportJob, plan: { name: string; bytes: number; sha256: string; chapters: { chars: number }[] }): void {
  if (!isSameSource(job, { name: plan.name, size_bytes: plan.bytes, sha256: plan.sha256 })) {
    throw new YushuError(
      "E_IMPORT_RESUME_SOURCE",
      `你选的稿子与上次不是同一份（上次是「${job.source.name}」，${String(job.source.size_bytes)} 字节）——` +
        "续跑只认同一份稿子，请选回同一个文件，或取消续跑重新导入",
    );
  }
  if (plan.chapters.length !== job.chapters.length) {
    throw new YushuError(
      "E_IMPORT_RESUME_PLAN",
      `这次的切分与上次不一样（上次 ${String(job.chapters.length)} 章，这次 ${String(plan.chapters.length)} 章）——` +
        "续跑要求重放同一份切分，请用上次的清洗规则重来",
    );
  }
  const sumNow = plan.chapters.reduce((acc, item) => acc + item.chars, 0);
  const sumThen = job.chapters.reduce((acc, item) => acc + item.expected_chars, 0);
  if (sumNow !== sumThen) {
    throw new YushuError(
      "E_IMPORT_RESUME_PLAN",
      `这次的字数与上次不一样（上次共 ${String(sumThen)} 字，这次 ${String(sumNow)} 字）——` +
        "续跑要求重放同一份切分，请用上次的清洗规则重来",
    );
  }
}

/** 可续跑的任务清单（面板上要让作者看见"上次那稿子没导完"） */
export async function listResumableImportJobs(gateway: ProjectGateway): Promise<ImportJob[]> {
  return resumableJobs(await listImportJobs(gateway.root));
}
