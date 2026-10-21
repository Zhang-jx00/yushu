/* SPDX-License-Identifier: Apache-2.0 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 导入任务（import job）的 schema 与状态机（M5 / T5-7 第三段，R108；判据回源 I09 §2.7 / §3.1 / §5）。
 *
 * I09 §2.7 说的是"**大文件性能与可中断恢复**"：百万~三百万字级导入必须**分块 + 增量 + 断点续跑**，
 * 任务状态要**持久化**（章节进度、最后成功章号），中断后可续跑。§3.1 把这条落成状态机：
 * `pending → running → needs_review → done/failed`；§5 给了 import-job 的 schema 形状。
 *
 * 这一层是**纯函数**：不读盘、不写盘、不读墙钟。时刻一律由调用方给。
 *
 * 三条设计决定（每一条都是"看起来是小事、其实会毁掉续跑"的那种）：
 *
 * ① **断点记的是"最后成功落盘的章号"**，不是"处理到哪一行"——
 *    半章写进去是半个章：草稿文件要么完整要么不存在，续跑时按章补齐才对得上。
 * ② **任务记录不是项目内容**（御书的真源是 Markdown+YAML 文件树）⇒ 落 `.yushu/imports/`，
 *    那一片是网关的**写禁区**（索引、密文、usage、日志都在那）⇒ 迁移包不会因为它多出一个文件。
 *    删掉它不丢作者的东西：已经导进去的章在大纲与草稿里（那才是真源），代价只是重导一遍。
 * ③ **源文件只留指纹（文件名 + 字节数 + sha256），不留绝对路径**——
 *    路径永远只从原生对话框来（红线 5），把它写进项目文件等于把"传路径"的能力又还回去。
 *    续跑时作者**重新选一次**源文件，主进程按指纹比对是不是同一份：不是同一份就拒
 *    （把两本书接在一起，比续跑失败更坏）。
 */
export const IMPORT_JOB_API_VERSION = "yushu.import-job/v1" as const;
export const IMPORT_JOB_FORMAT_VERSION = 1;

/** 导入任务的状态（I09 §3.1 的五个） */
export type ImportJobStatus = "pending" | "running" | "needs_review" | "done" | "failed";

export const IMPORT_JOB_STATUSES: readonly ImportJobStatus[] = [
  "pending",
  "running",
  "needs_review",
  "done",
  "failed",
];

/** 人工校正的动作种类（与 `@yushu/text` 的 `ImportCorrection` 一一对应；两边的种类集合由一条锁盯着） */
export const IMPORT_JOB_CORRECTION_KINDS = ["merge", "split", "move"] as const;

/** 一条人工校正（存进任务记录里，续跑时按它重放同一份切分） */
export type ImportJobCorrection =
  | { kind: "merge"; at: number }
  | { kind: "split"; at: number; line: number; title?: string }
  | { kind: "move"; from: number; to: number };

/** 源文件指纹：只留 basename + 指纹，不留绝对路径 */
export interface ImportJobSource {
  name: string;
  size_bytes: number;
  sha256: string;
  /** 探测出来的编码（"这是猜的"那种也照实记） */
  detected_encoding: string;
}

/** 断点：最后成功落盘的章号 + 能不能续 */
export interface ImportJobCheckpoint {
  /** 已成功落盘的最后章序号（1 起；0 = 一章都没写成） */
  last_chapter: number;
  /** 能不能从断点接着跑 */
  resumable: boolean;
}

/** 计划里的一章（续跑时按它补齐缺的草稿——章 id 必须持久化，重算会换 id） */
export interface ImportJobChapter {
  outline_id: string;
  chapter_id: string;
  path: string;
  title: string;
  expected_chars: number;
}

/** 切分计划（续跑时重放：AI 筛过哪些候选、作者校正过什么） */
export interface ImportJobPlan {
  /** AI 筛过后保留的候选序号（undefined = 没让 AI 筛过，仍是正则切） */
  keeps?: number[];
  /** 作者的人工校正（按顺序应用） */
  corrections: ImportJobCorrection[];
}

export interface ImportJob {
  apiVersion: typeof IMPORT_JOB_API_VERSION;
  format_version: number;
  id: string;
  source: ImportJobSource;
  status: ImportJobStatus;
  checkpoint: ImportJobCheckpoint;
  /** 这次导入建的卷 id（续跑时写进同一卷） */
  volume_id: string;
  plan: ImportJobPlan;
  /** 计划写哪几章（顺序即章序） */
  chapters: ImportJobChapter[];
  /** 迁移前后的字数对账（done 时才有意义） */
  reconcile?: { source_chars: number; chapter_chars_sum: number; delta: number };
  /** 作者可见的备注（回执原话） */
  note?: string;
}

/* ---------------- 状态机 ---------------- */

/** 合法迁移表（引擎给，界面按它渲染按钮——渲染层不自己抄一份表） */
export const IMPORT_JOB_TRANSITIONS: Readonly<Record<ImportJobStatus, readonly ImportJobStatus[]>> = Object.freeze({
  pending: ["running", "failed"],
  running: ["needs_review", "done", "failed"],
  needs_review: ["running", "failed"],
  done: [],
  failed: ["pending"],
});

export interface ImportJobTransition {
  ok: boolean;
  /** 非法时给理由（界面上要看得见，不能只说"不行"） */
  reason: string;
}

/** 能不能从 `from` 走到 `to`；不能时把理由说出来 */
export function canTransitionImportJob(from: ImportJobStatus, to: ImportJobStatus): ImportJobTransition {
  if (from === to) {
    return { ok: false, reason: `状态已经是「${from}」，不需要再走一次` };
  }
  const allowed = IMPORT_JOB_TRANSITIONS[from];
  if (allowed.includes(to)) return { ok: true, reason: "" };
  const toText = allowed.length === 0 ? "（终态，不能再走）" : allowed.join(" / ");
  return { ok: false, reason: `不能从「${from}」走到「${to}」：这一刻允许的是 ${toText}` };
}

/**
 * 断点续跑允许的**起始状态**。
 *
 * 为什么 `running` 也在里面：进程在写盘途中没了（崩溃 / 被杀 / 断电），
 * 没人来得及把记录改成 `needs_review` ⇒ 盘上停的就是 `running`。
 * **那恰恰是最该能续跑的状态**，不能因为"记录状态和目标状态一样"就判它不可续。
 * 迁移表管的是**主动**的动作（不许把同一状态当成一次迁移），续跑是另一回事，单独立这一份。
 */
export const IMPORT_JOB_RESUMABLE_STATUSES: readonly ImportJobStatus[] = ["running", "needs_review"];

/** 能不能从断点续跑（断点自己说可续 + 状态在允许名单里） */
export function isResumableImportJob(job: ImportJob): boolean {
  if (!job.checkpoint.resumable) return false;
  return IMPORT_JOB_RESUMABLE_STATUSES.includes(job.status);
}

/* ---------------- 解析与序列化 ---------------- */

function fail(message: string): never {
  throw new Error(`E_IMPORT_JOB：${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") fail(`${where} 必须是非空字符串`);
  return value;
}

function asInt(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${where} 必须是整数`);
  return value;
}

function asBool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(`${where} 必须是布尔`);
  return value;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} 必须是数组`);
  return value;
}

/** 未知键一律拒（读不了的键名说明这份记录不是我们写的，宁可报错也不当没看见） */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${where} 出现未知键「${key}」（允许：${allowed.join(" / ")}）`);
  }
}

function parseCorrections(value: unknown): ImportJobCorrection[] {
  const items = asArray(value, "plan.corrections");
  return items.map((item, index) => {
    const where = `plan.corrections[${String(index)}]`;
    const record = asRecord(item, where);
    const kind = asString(record["kind"], `${where}.kind`);
    if (kind === "merge") {
      rejectUnknownKeys(record, ["kind", "at"], where);
      return { kind, at: asInt(record["at"], `${where}.at`) };
    }
    if (kind === "split") {
      rejectUnknownKeys(record, ["kind", "at", "line", "title"], where);
      const title = record["title"];
      return {
        kind,
        at: asInt(record["at"], `${where}.at`),
        line: asInt(record["line"], `${where}.line`),
        ...(title === undefined ? {} : { title: asString(title, `${where}.title`) }),
      };
    }
    if (kind === "move") {
      rejectUnknownKeys(record, ["kind", "from", "to"], where);
      return { kind, from: asInt(record["from"], `${where}.from`), to: asInt(record["to"], `${where}.to`) };
    }
    fail(`${where}.kind 是未知动作「${kind}」（允许：${IMPORT_JOB_CORRECTION_KINDS.join(" / ")}）`);
  });
}

/** 解析一份任务记录；读不懂就抛错（不静默当成"没有任务"——那会让作者以为能重跑，其实续跑不了） */
export function parseImportJob(content: string): ImportJob {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    fail(`YAML 读不了：${err instanceof Error ? err.message : String(err)}`);
  }
  const record = asRecord(raw, "任务记录");
  rejectUnknownKeys(
    record,
    [
      "apiVersion",
      "format_version",
      "id",
      "source",
      "status",
      "checkpoint",
      "volume_id",
      "plan",
      "chapters",
      "reconcile",
      "note",
    ],
    "任务记录",
  );
  if (record["apiVersion"] !== IMPORT_JOB_API_VERSION) {
    fail(`apiVersion 不认：${String(record["apiVersion"])}（期望 ${IMPORT_JOB_API_VERSION}）`);
  }
  const source = asRecord(record["source"], "source");
  rejectUnknownKeys(source, ["name", "size_bytes", "sha256", "detected_encoding"], "source");
  const status = asString(record["status"], "status");
  if (!IMPORT_JOB_STATUSES.includes(status as ImportJobStatus)) {
    fail(`status 不认：${status}（允许：${IMPORT_JOB_STATUSES.join(" / ")}）`);
  }
  const checkpoint = asRecord(record["checkpoint"], "checkpoint");
  rejectUnknownKeys(checkpoint, ["last_chapter", "resumable"], "checkpoint");
  const plan = asRecord(record["plan"], "plan");
  rejectUnknownKeys(plan, ["keeps", "corrections"], "plan");
  const keepsRaw = plan["keeps"];
  const chapters = asArray(record["chapters"], "chapters").map((item, index) => {
    const where = `chapters[${String(index)}]`;
    const row = asRecord(item, where);
    rejectUnknownKeys(row, ["outline_id", "chapter_id", "path", "title", "expected_chars"], where);
    return {
      outline_id: asString(row["outline_id"], `${where}.outline_id`),
      chapter_id: asString(row["chapter_id"], `${where}.chapter_id`),
      path: asString(row["path"], `${where}.path`),
      title: asString(row["title"], `${where}.title`),
      expected_chars: asInt(row["expected_chars"], `${where}.expected_chars`),
    };
  });
  const reconcileRaw = record["reconcile"];
  const noteRaw = record["note"];
  return {
    apiVersion: IMPORT_JOB_API_VERSION,
    format_version: asInt(record["format_version"], "format_version"),
    id: asString(record["id"], "id"),
    source: {
      name: asString(source["name"], "source.name"),
      size_bytes: asInt(source["size_bytes"], "source.size_bytes"),
      sha256: asString(source["sha256"], "source.sha256"),
      detected_encoding: asString(source["detected_encoding"], "source.detected_encoding"),
    },
    status: status as ImportJobStatus,
    checkpoint: {
      last_chapter: asInt(checkpoint["last_chapter"], "checkpoint.last_chapter"),
      resumable: asBool(checkpoint["resumable"], "checkpoint.resumable"),
    },
    volume_id: asString(record["volume_id"], "volume_id"),
    plan: {
      ...(keepsRaw === undefined || keepsRaw === null
        ? {}
        : { keeps: asArray(keepsRaw, "plan.keeps").map((item, index) => asInt(item, `plan.keeps[${String(index)}]`)) }),
      corrections: parseCorrections(plan["corrections"]),
    },
    chapters,
    ...(reconcileRaw === undefined || reconcileRaw === null
      ? {}
      : {
          reconcile: (() => {
            const row = asRecord(reconcileRaw, "reconcile");
            rejectUnknownKeys(row, ["source_chars", "chapter_chars_sum", "delta"], "reconcile");
            return {
              source_chars: asInt(row["source_chars"], "reconcile.source_chars"),
              chapter_chars_sum: asInt(row["chapter_chars_sum"], "reconcile.chapter_chars_sum"),
              delta: asInt(row["delta"], "reconcile.delta"),
            };
          })(),
        }),
    ...(noteRaw === undefined || noteRaw === null ? {} : { note: asString(noteRaw, "note") }),
  };
}

/** 序列化（确定性：键序固定，便于逐字比对） */
export function serializeImportJob(job: ImportJob): string {
  const record: Record<string, unknown> = {
    apiVersion: IMPORT_JOB_API_VERSION,
    format_version: job.format_version,
    id: job.id,
    source: {
      name: job.source.name,
      size_bytes: job.source.size_bytes,
      sha256: job.source.sha256,
      detected_encoding: job.source.detected_encoding,
    },
    status: job.status,
    checkpoint: {
      last_chapter: job.checkpoint.last_chapter,
      resumable: job.checkpoint.resumable,
    },
    volume_id: job.volume_id,
    plan: {
      ...(job.plan.keeps === undefined ? {} : { keeps: job.plan.keeps }),
      corrections: job.plan.corrections,
    },
    chapters: job.chapters.map((row) => ({
      outline_id: row.outline_id,
      chapter_id: row.chapter_id,
      path: row.path,
      title: row.title,
      expected_chars: row.expected_chars,
    })),
    ...(job.reconcile === undefined
      ? {}
      : {
          reconcile: {
            source_chars: job.reconcile.source_chars,
            chapter_chars_sum: job.reconcile.chapter_chars_sum,
            delta: job.reconcile.delta,
          },
        }),
    ...(job.note === undefined ? {} : { note: job.note }),
  };
  return stringifyYaml(record, { lineWidth: 0 });
}
