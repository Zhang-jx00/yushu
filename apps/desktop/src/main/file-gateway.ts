import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { YushuError } from "@yushu/core";
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

const WALK_EXCLUDES = new Set([".git", ".yushu", "node_modules"]);
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
      const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of sorted) {
        if (WALK_EXCLUDES.has(dirent.name) || dirent.name.endsWith(".tmp")) continue;
        const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        const abs = join(dirAbs, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ path: rel, type: "dir" });
          await walk(abs, rel);
        } else if (dirent.isFile()) {
          const stat = await fs.stat(abs);
          entries.push({ path: rel, type: "file", size: stat.size });
        }
      }
    };
    await walk(this.rootAbs, "");
    return entries;
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
    return { path: relPath, content, hash: sha256(content) };
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
}