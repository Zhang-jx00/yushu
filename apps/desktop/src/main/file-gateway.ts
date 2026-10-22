/* SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { YushuError, codePointCompare } from "@yushu/core";
import type { DocSnapshot, TreeEntry } from "../shared/ipc.js";

/**
 * FileGateway：主进程唯一 fs 出口（docs/03 §3）。
 * 纯 Node 实现（不依赖 Electron），可被 CLI / 测试直接复用。
 * - 一切路径限定在项目根目录内（防路径穿越，K12）；
 * - 写操作支持 baseHash 并发检测（内容 sha256）；
 * - 引擎目录（.yushu）与 node_modules 禁止写入。
 */

export class DocConflictError extends YushuError {
  constructor(path: string, detail: string) {
    super("E_DOC_CONFLICT", `写入冲突（${path}）：${detail}`);
  }
}

export class PathSafetyError extends YushuError {
  constructor(message: string) {
    super("E_PATH_UNSAFE", message);
  }
}

/**
 * 目录树遍历跳过的目录。**与 git-ops 的 GIT_EXCLUDES、索引的 DEFAULT_INDEX_EXCLUDES 是同一件事的三份清单**，
 * 三向一致由 test/exclude-lists.test.ts 钉住（漂移的真实后果是派生物在一处被当作者内容、在另一处被当垃圾）。
 * 注意 `exports/` 不在这里：导出件要在文件树里看得见，但不进 Git 也不进索引——那是刻意的不对称。
 */
export const WALK_EXCLUDES = new Set([".git", ".yushu", "node_modules"]);
const WRITE_EXCLUDES = new Set([".yushu", "node_modules"]);

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class ProjectGateway {
  private readonly rootAbs: string;

  constructor(root: string) {
    this.rootAbs = resolve(root);
  }

  get root(): string {
    return this.rootAbs;
  }

  private resolveInside(relPath: string, forWrite = false): string {
    const rel = relPath.replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
      throw new PathSafetyError(`非法路径：${relPath}`);
    }
    const abs = resolve(this.rootAbs, rel);
    if (abs !== this.rootAbs && !abs.startsWith(this.rootAbs + sep)) {
      throw new PathSafetyError(`路径越界：${relPath}`);
    }
    if (forWrite) {
      const forbidden = rel.split("/").find((segment) => WRITE_EXCLUDES.has(segment));
      if (forbidden) {
        throw new PathSafetyError(`禁止写入引擎/依赖目录：${relPath}`);
      }
    }
    return abs;
  }

  /** 递归列出项目文件（排除 .git/.yushu/node_modules 与临时文件；按路径排序） */
  async listTree(): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
      const sorted = [...dirents].sort((a, b) => codePointCompare(a.name, b.name));
      for (const dirent of sorted) {
        if (WALK_EXCLUDES.has(dirent.name) || dirent.name.endsWith(".tmp")) continue;
        const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        const abs = join(dirAbs, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ path: rel, type: "dir" });
          await walk(abs, rel);
        } else if (dirent.isFile()) {
          const stat = await fs.stat(abs);
          entries.push({ path: rel, type: "file", size: stat.size, mtime: stat.mtime.toISOString() });
        }
      }
    };
    await walk(this.rootAbs, "");
    return entries;
  }

  /**
   * 读**二进制**文件（图片等）——路径防护与 readDoc 同一套（K12 防路径穿越）。
   *
   * 为什么单独一条：`readDoc` 按 utf8 解码，二进制会被解坏（可选项失真）。
   */
  async readBinary(relPath: string): Promise<{ path: string; bytes: Buffer }> {
    const abs = this.resolveInside(relPath);
    const bytes = await fs.readFile(abs);
    return { path: relPath, bytes };
  }

  async readDoc(relPath: string): Promise<DocSnapshot> {
    const abs = this.resolveInside(relPath);
    const content = await fs.readFile(abs, "utf8");
    return { path: relPath, content, hash: sha256(content) };
  }

  /**
   * 写入文档（原子：临时文件 + rename）。
   * - 不携带 baseHash：仅允许新建（文件已存在则冲突）；
   * - 携带 baseHash：文件必须存在且当前内容 hash 与之一致（外部修改即冲突）。
   */
  async writeDoc(relPath: string, content: string, baseHash?: string): Promise<DocSnapshot> {
    const abs = this.resolveInside(relPath, true);
    let current: string | null = null;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (baseHash === undefined) {
      if (current !== null) {
        throw new DocConflictError(relPath, "文件已存在（未携带 baseHash，禁止盲写）");
      }
    } else if (current === null) {
      throw new DocConflictError(relPath, "文件不存在或已被删除");
    } else if (sha256(current) !== baseHash) {
      throw new DocConflictError(relPath, "baseHash 不匹配（文件已被外部修改）");
    }

    await fs.mkdir(dirname(abs), { recursive: true });
    await this.atomicWriteAbs(abs, content);
    return { path: relPath, content, hash: sha256(content) };
  }

  /**
   * 写**二进制**文件（图片等）——路径防护与 writeDoc 同一套（K12 防路径穿越），
   * 写入也是**原子**的（临时文件 + rename）。
   *
   * 为什么需要它：底图是**图片**（二进制）⇒ `writeDoc` 按 utf8 解码会把它**写坏**
   * （可选项失真）⇒ 只能另开一条（同 `readBinary` 的理由）。
   *
   * 不覆盖已有文件（除非调用方自己判断）⇒ 底图同名时由调用方先决定要不要换名。
   */
  async writeBinary(relPath: string, bytes: Buffer): Promise<{ path: string; bytes: number }> {
    const abs = this.resolveInside(relPath, true);
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
    return { path: relPath, bytes: bytes.length };
  }

  private async atomicWriteAbs(abs: string, content: string): Promise<void> {
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
    // T2-6 保存管线：先写入临时文件并 fsync 落盘，再 rename —— 进程/系统崩溃窗口内
    // 要么保留旧内容、要么是完整新内容，不会出现半截文件（原子写 + 持久化的双保险）。
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
  }

  /**
   * 写派生区（`.yushu/**`）——审计里"ops 用裸 fs 直写 .yushu 绕过 FileGateway"那条的正解：
   * 派生文件确实不能走 `writeDoc`（那里的 WRITE_EXCLUDES 就是用来挡真源误写的），
   * 但也不该因此各写各的。所以开一扇**只认派生区**的窄门：越界检查照做，
   * 路径不以 `.yushu/` 开头就直接拒 ⇒ 这扇门不能拿来写真源，也拿不到 baseHash 之外的并发语义。
   */
  async writeDerived(relPath: string, content: string, expectedHash?: string): Promise<DocSnapshot> {
    const rel = relPath.replace(/\\/g, "/");
    if (!rel.startsWith(".yushu/")) {
      throw new PathSafetyError(`writeDerived 只允许写派生区 .yushu/，收到：${relPath}`);
    }
    const abs = this.resolveInside(rel);
    if (expectedHash !== undefined) {
      const current = await fs.readFile(abs, "utf8").catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (current === null) {
        throw new DocConflictError(rel, "派生文件不存在或已被删除");
      }
      if (sha256(current) !== expectedHash) {
        throw new DocConflictError(rel, "派生文件已被外部修改（拒绝盲写）");
      }
    }
    await this.atomicWriteAbs(abs, content);
    return { path: rel, content, hash: sha256(content) };
  }

  /** 列派生区某个前缀下的文件名（不递归；按码点序，保证调用方拿到的顺序可复现） */
  async listDerived(dirRel: string): Promise<string[]> {
    const rel = dirRel.replace(/\\/g, "/");
    if (!rel.startsWith(".yushu/")) {
      throw new PathSafetyError(`listDerived 只允许列派生区 .yushu/，收到：${dirRel}`);
    }
    const abs = this.resolveInside(rel);
    try {
      const names = await fs.readdir(abs, { withFileTypes: true });
      return names.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async renameDoc(from: string, to: string): Promise<void> {
    const fromAbs = this.resolveInside(from, true);
    const toAbs = this.resolveInside(to, true);
    let targetExists = true;
    try {
      await fs.access(toAbs);
    } catch {
      targetExists = false;
    }
    if (targetExists) {
      throw new DocConflictError(to, "重命名目标已存在");
    }
    await fs.mkdir(dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
  }

  /**
   * 删除文档（T3-5 事实台账）：携带 baseHash 并发检测（文件已被外部修改即拒绝）。
   * 路径防护与写通道一致（禁写目录同样禁止删除）。
   */
  async deleteDoc(relPath: string, baseHash?: string): Promise<void> {
    const abs = this.resolveInside(relPath, true);
    const current = await fs.readFile(abs, "utf8").catch(() => null);
    if (current === null) {
      throw new DocConflictError(relPath, "文件不存在或已被删除");
    }
    if (baseHash !== undefined && sha256(current) !== baseHash) {
      throw new DocConflictError(relPath, "baseHash 不匹配（文件已被外部修改）");
    }
    await fs.unlink(abs);
  }

  /** 文件是否存在（路径防护同 readDoc；快照恢复统计"重建 / 覆盖"用） */
  async exists(relPath: string): Promise<boolean> {
    const abs = this.resolveInside(relPath);
    return fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * 快照恢复专用写入（T2-7 切片 A）：显式整体回滚语义——UI 已二次确认且调用方已强制生成
   * pre_restore 快照，因此不做 baseHash 并发检测；路径防护与原子写（tmp → fsync → rename）不变。
   */
  async restoreDoc(relPath: string, content: string): Promise<void> {
    const abs = this.resolveInside(relPath, true);
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
  }
}