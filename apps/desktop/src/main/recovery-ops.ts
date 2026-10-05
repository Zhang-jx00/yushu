import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { countWords, YushuError } from "@yushu/core";
import { readChapterFile } from "@yushu/world-engine";
import type { RecoveryEntry, RecoveryWritePayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 编辑日志（T2-8 切片 A·崩溃恢复的输入记录）：
 *
 * 编辑器在输入期间把当前正文快照写入 `.yushu/recovery/<hash>.json`（渲染层短防抖 500ms），
 * 保存成功后清除；进程被杀 / 崩溃时 journal 残留 → 下次进入项目检测「与磁盘不一致」并提示恢复。
 *
 * - journal 是派生辅助数据：位于 `.yushu/`（索引排除、不入 Git），损坏 / 缺失不影响真源；
 * - 只服务章节（仅接受 `chapters/` 前缀，读取也经 FileGateway 的路径防护）；
 * - 原子写（tmp → rename）：崩溃不会读到半截 JSON；
 * - 检测规则：journal 与磁盘正文一致（已保存但漏清）→ 自动清除；章节文件不存在 / JSON 损坏 → 保留原文件但不出现在列表（保守，不静默删）。
 */

export const RECOVERY_DIR = ".yushu/recovery";

interface JournalFile {
  path: string;
  body: string;
  updatedAt: string;
}

function journalRelPath(chapterPath: string): string {
  const hash = createHash("sha256").update(chapterPath, "utf8").digest("hex").slice(0, 12);
  return `${RECOVERY_DIR}/${hash}.json`;
}

function assertChapterPath(path: string): void {
  if (!path.startsWith("chapters/")) {
    throw new YushuError("E_INVALID_INPUT", `编辑日志仅服务章节文件：${path}`);
  }
}

/**
 * 正文比对归一：编辑器正文（journal）不带尾随换行；章节文件序列化会带行尾 `\n`——
 * 仅尾随空白差异视为同一内容（避免"保存后漏清"被误判为可恢复条目）。
 */
function normalizeBody(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/** 写入 / 更新编辑日志（覆盖式原子写） */
export async function writeRecoveryJournal(
  gateway: ProjectGateway,
  payload: RecoveryWritePayload,
): Promise<boolean> {
  assertChapterPath(payload.path);
  const abs = join(gateway.root, journalRelPath(payload.path));
  await fs.mkdir(dirname(abs), { recursive: true });
  const data: JournalFile = {
    path: payload.path,
    body: payload.body,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, abs);
  return true;
}

/** 清除编辑日志（保存成功后；不存在视为已清） */
export async function clearRecoveryJournal(gateway: ProjectGateway, path: string): Promise<boolean> {
  assertChapterPath(path);
  await fs.rm(join(gateway.root, journalRelPath(path)), { force: true });
  return true;
}

/**
 * 检测可恢复条目（进入项目时调用）：
 * 遍历 journal → 与磁盘章节正文比对 → 返回不一致者；一致的（漏清）自动清除；无法判定的保守保留。
 */
export async function listRecoverable(gateway: ProjectGateway): Promise<RecoveryEntry[]> {
  const dirAbs = join(gateway.root, RECOVERY_DIR);
  const files = await fs.readdir(dirAbs).catch(() => [] as string[]);
  const entries: RecoveryEntry[] = [];
  for (const name of files) {
    const abs = join(dirAbs, name);
    if (!name.endsWith(".json")) {
      // 原子写崩溃残留的 .tmp：无内容可言，直接清理
      if (name.endsWith(".tmp")) await fs.rm(abs, { force: true }).catch(() => undefined);
      continue;
    }
    let data: JournalFile | null = null;
    try {
      data = JSON.parse(await fs.readFile(abs, "utf8")) as JournalFile;
    } catch {
      data = null;
    }
    if (!data || typeof data.path !== "string" || typeof data.body !== "string" || !data.path.startsWith("chapters/")) {
      continue; // 损坏 / 非法：保留原文件不静默删，跳过
    }
    // 经 FileGateway 读取（路径防护）；章节被删 / 读取失败 → 无法自动恢复，保留 journal 但不提示
    const snapshot = await gateway.readDoc(data.path).catch(() => null);
    if (!snapshot) continue;
    let diskBody: string | null = null;
    try {
      diskBody = readChapterFile(snapshot.content).body;
    } catch {
      diskBody = null; // 磁盘章节解析失败：无法判定，保守跳过
    }
    if (diskBody === null) continue;
    if (normalizeBody(diskBody) === normalizeBody(data.body)) {
      // 内容已落盘（journal 漏清）：自动清除，不打扰用户
      await fs.rm(abs, { force: true }).catch(() => undefined);
      continue;
    }
    entries.push({
      path: data.path,
      body: data.body,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
      wordCount: countWords(data.body),
    });
  }
  return entries;
}

/** 丢弃编辑日志（用户在恢复面板显式放弃） */
export async function discardRecoveryJournal(gateway: ProjectGateway, path: string): Promise<boolean> {
  return clearRecoveryJournal(gateway, path);
}