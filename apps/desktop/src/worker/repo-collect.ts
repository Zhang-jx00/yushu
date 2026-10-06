import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import {
  collectIndexInput,
  diffIndexSources,
  isIndexablePath,
  type IndexFileRow,
  type IndexInput,
  type IndexSourceFile,
  type IndexSourceReader,
} from "@yushu/world-engine";

/**
 * utilityProcess 侧的仓库解析（M2 / T2-11）：
 * - 切片 A：全量只读解析（collectWithFs）——产出索引输入（entities / refs / chunks / file_index）；
 * - 切片 B：增量只读解析（incrementalWithFs）——与 file_index 基线 diff（复用/触碰/变更/移除），
 *   只对变更文件定向解析，回传 delta 由主进程应用。
 * **不写任何内容**——索引库写入仍由主进程独占（docs/04 §5.6 风险对策）。
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

/** 增量 delta（T2-11 切片 B；input 为 null 表示无变更文件——只需移除/触碰记录） */
export interface IncrementalWithFsResult {
  removedPaths: string[];
  touchedFiles: IndexFileRow[];
  reusedFiles: number;
  updatedFiles: number;
  removedFiles: number;
  input: CollectWithFsResult | null;
}

/**
 * 增量只读解析（T2-11 切片 B）：diff（复用 / 触碰 / 变更 / 移除）→ 只对变更文件定向解析。
 * 与主进程回退路径共用 @yushu/world-engine 的 diffIndexSources（含 racy 防护），语义完全一致；
 * 进度口径与全量一致：每成功读取一个可索引文件回调一次（未变文件走快速跳过不读取）。
 */
export async function incrementalWithFs(
  root: string,
  files: IndexSourceFile[],
  prev: IndexFileRow[],
  builtAt: string,
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<IncrementalWithFsResult> {
  const list = files.filter((file) => isIndexablePath(file.path));
  const total = list.length;
  let done = 0;
  const readText = async (path: string): Promise<string> => {
    const text = await fs.readFile(resolveInsideRoot(root, path), "utf8");
    if (isIndexablePath(path)) {
      done += 1;
      onProgress?.(done, total, path);
    }
    return text;
  };
  const diff = await diffIndexSources(list, prev, builtAt, readText);

  const scopedReader: IndexSourceReader = { listFiles: async () => diff.changed, readText };
  const input = diff.changed.length > 0 ? await collectIndexInput(scopedReader) : null;
  return {
    removedPaths: diff.removedPaths,
    touchedFiles: diff.touchedFiles,
    reusedFiles: diff.reusedFiles,
    updatedFiles: diff.changed.length,
    removedFiles: diff.removedPaths.length,
    input,
  };
}