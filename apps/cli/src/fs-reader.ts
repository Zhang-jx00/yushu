import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { IndexSourceFile, IndexSourceReader } from "@yushu/world-engine";

/**
 * CLI 的 fs 数据源适配器（与主进程 FileGateway 适配器同构，都产出 IndexSourceReader）。
 * 只读；排除引擎目录、Git、依赖与导出产物。
 */

const WALK_EXCLUDES = new Set([".yushu", ".git", "node_modules", "exports"]);

async function walk(rootAbs: string, dirAbs: string, acc: IndexSourceFile[]): Promise<void> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (WALK_EXCLUDES.has(entry.name)) continue;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      await walk(rootAbs, abs, acc);
    } else if (entry.isFile()) {
      const stat = await fs.stat(abs);
      acc.push({
        path: relative(rootAbs, abs).split("\\").join("/"),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
}

export function createFsReader(rootDir: string): IndexSourceReader {
  const rootAbs = resolve(rootDir);
  return {
    listFiles: async () => {
      const acc: IndexSourceFile[] = [];
      await walk(rootAbs, rootAbs, acc);
      return acc.sort((a, b) => a.path.localeCompare(b.path));
    },
    readText: (path) => fs.readFile(join(rootAbs, ...path.split("/")), "utf8"),
  };
}