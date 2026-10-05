import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import {
  collectIndexInput,
  isIndexablePath,
  type IndexInput,
  type IndexSourceFile,
  type IndexSourceReader,
} from "@yushu/world-engine";

/**
 * utilityProcess 侧的仓库解析（M2 / T2-11 切片 A）：
 * 只读文件、产出索引输入（entities / refs / chunks / file_index），**不写任何内容**——
 * 索引库写入仍由主进程独占（docs/04 §5.6 风险对策：utilityProcess 只读文件、写索引走队列）。
 * 本模块不触碰 Electron API，可在 vitest 直接单测。
 */

/**
 * 路径安全（防御纵深）：把相对路径解析到 root 内；越界（../、绝对路径逃逸）即拒绝读取。
 * 主进程 listTree 已做过路径防护，此处再拦一层——utility 进程独立读盘，不信任入参。
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`)) {
    throw new Error(`路径越界（拒绝读取）：${relPath}`);
  }
  return abs;
}

export interface CollectWithFsResult extends IndexInput {
  skipped: { path: string; error: string }[];
}

/**
 * 以 fs 适配器收集索引输入（与主进程的 FileGateway 适配器同构）。
 * onProgress：每成功读取一个可索引文件回调一次（done / total / 当前路径）。
 */
export async function collectWithFs(
  root: string,
  files: IndexSourceFile[],
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<CollectWithFsResult> {
  const total = files.filter((file) => isIndexablePath(file.path)).length;
  let done = 0;
  const reader: IndexSourceReader = {
    listFiles: async () => files,
    readText: async (path) => {
      const text = await fs.readFile(resolveInsideRoot(root, path), "utf8");
      if (isIndexablePath(path)) {
        done += 1;
        onProgress?.(done, total, path);
      }
      return text;
    },
  };
  return collectIndexInput(reader);
}