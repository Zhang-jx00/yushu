/* SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { ImportCorrection } from "@yushu/text";
import {
  isResumableImportJob,
  parseImportJob,
  serializeImportJob,
  type ImportJob,
  type ImportJobChapter,
  type ImportJobPlan,
} from "@yushu/world-engine";

/**
 * 导入任务的落盘层（M5 / T5-7 第三段，R108；判据回源 I09 §2.7 / §3.1 / §5）。
 *
 * 记什么、为什么这么记，理由写在引擎侧（`@yushu/world-engine/import-job.ts`）的注释里；
 * 这一层只管三件事：**写到哪里**、**怎么读回来**、**源文件是不是同一份**。
 *
 * 两条口径：
 * ① **落 `.yushu/imports/`，不走 FileGateway**——那一片是网关的**写禁区**
 *    （索引、密文、usage、日志都在那）。任务记录是**运行期产物**不是项目内容：
 *    迁移包不该因为它多出一个文件，删掉它也不丢作者的东西（已导进去的章在大纲与草稿里，那才是真源）。
 * ② **源文件只留指纹，不留绝对路径**——路径永远只从原生对话框来（红线 5），
 *    把它写进任何文件等于把"传路径"的能力又还回去。续跑时作者重新选一次，主进程按指纹核对。
 */

/** 任务记录目录（`.yushu/` 下面） */
export const IMPORT_JOBS_DIR = ".yushu/imports";

/** 任务记录的文件名（id 由 `makeId("imp")` 生成） */
export function importJobPath(id: string): string {
  return `${IMPORT_JOBS_DIR}/job-${id}.yaml`;
}

/**
 * 新任务 id（`imp-xxxx`，与 I09 §5 的 `imp-0007` 同一形状）。
 *
 * **不用 `makeId`**：那本 id 词表是**项目实体**的（世界 / 卡 / 章 / 卷…），
 * 导入任务不是项目实体（它在 `.yushu/` 下，不是真源）⇒ 不去扩实体词表——
 * 扩了会让 `imp-xxx` 突然变成"合法实体 id"，某些校验会开始拿它当卡/章看。
 */
export function newImportJobId(): string {
  return `imp-${randomBytes(4).toString("hex")}`;
}

/** 源文件指纹：basename + 字节数 + sha256 */
export function sourceFingerprint(name: string, bytes: Uint8Array): {
  name: string;
  size_bytes: number;
  sha256: string;
} {
  return {
    name,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** 是不是同一份稿子（续跑的第一道闸：把两本书接在一起比续跑失败更坏） */
export function isSameSource(
  job: ImportJob,
  fingerprint: { name: string; size_bytes: number; sha256: string },
): boolean {
  return (
    job.source.sha256 === fingerprint.sha256 &&
    job.source.size_bytes === fingerprint.size_bytes &&
    job.source.name === fingerprint.name
  );
}

/** 写一份任务记录（原子：先写临时文件再改名——崩在半路不会留半份记录） */
export async function writeImportJob(root: string, job: ImportJob): Promise<void> {
  const abs = join(root, ...importJobPath(job.id).split("/"));
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, serializeImportJob(job), "utf8");
  await fs.rename(tmp, abs);
}

/** 读一份任务记录；没有就是 null（**读坏了要抛错**，不当成"没有任务"） */
export async function readImportJob(root: string, id: string): Promise<ImportJob | null> {
  const abs = join(root, ...importJobPath(id).split("/"));
  const content = await fs.readFile(abs, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (content === null) return null;
  return parseImportJob(content);
}

/** 列出全部任务记录（按 id 排序；坏的那份跳过并记一笔，不让一份坏记录挡住其余） */
export async function listImportJobs(root: string): Promise<ImportJob[]> {
  const dir = join(root, ...IMPORT_JOBS_DIR.split("/"));
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const jobs: ImportJob[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith("job-") || !name.endsWith(".yaml")) continue;
    const abs = join(dir, name);
    const content = await fs.readFile(abs, "utf8").catch(() => null);
    if (content === null) continue;
    try {
      jobs.push(parseImportJob(content));
    } catch {
      // 坏记录读不了就跳过（这份不参与续跑），但**不删**——删掉的是作者的东西
    }
  }
  return jobs;
}

/** 可续跑的任务（状态在允许名单里 + 断点自己说可续） */
export function resumableJobs(jobs: readonly ImportJob[]): ImportJob[] {
  return jobs.filter((job) => isResumableImportJob(job));
}

/** 计划上下文 → 任务记录里的 plan（存下来，续跑时重放同一份切分） */
export function toJobPlan(plan: { keeps?: number[]; corrections: ImportCorrection[] }): ImportJobPlan {
  return {
    ...(plan.keeps === undefined ? {} : { keeps: [...plan.keeps] }),
    corrections: plan.corrections.map((item) =>
      item.kind === "split"
        ? { kind: item.kind, at: item.at, line: item.line, ...(item.title === undefined ? {} : { title: item.title }) }
        : { ...item },
    ),
  };
}

/** 任务记录里的 plan → 计划上下文（续跑时注入回去） */
export function fromJobPlan(plan: ImportJobPlan): { keeps?: number[]; corrections: ImportCorrection[] } {
  return {
    ...(plan.keeps === undefined ? {} : { keeps: [...plan.keeps] }),
    corrections: plan.corrections.map((item) =>
      item.kind === "split"
        ? { kind: item.kind, at: item.at, line: item.line, ...(item.title === undefined ? {} : { title: item.title }) }
        : { ...item },
    ),
  };
}

/** 计划里的几章 → 任务记录里的 chapters（章 id 必须持久化：重算会换 id，续跑会写错地方） */
export function toJobChapters(rows: readonly ImportJobChapter[]): ImportJobChapter[] {
  return rows.map((row) => ({ ...row }));
}
