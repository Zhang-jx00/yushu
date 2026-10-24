/* SPDX-License-Identifier: Apache-2.0 */
// 这个模块被**单测**引进来 ⇒ 它自己落进了 NodeNext 那张网（测试的 tsconfig 是 NodeNext）⇒
// 相对导入必须带 .js 后缀（渲染层其余文件不带，是因为它们不进这张网 —— 同一个仓库里的两种写法，各有各的理由）。
import type { ExportRunResult } from "../../../src/shared/ipc.js";

/**
 * 导出产物的**纯函数**（R156）。
 *
 * 口径（`docs/11` §7.36）：
 * ① 右栏那一栏**全部从同一份导出结果载荷现算** —— 不另取数、不写死字面量；
 * ② **还没导出过就如实说「还没有导出过」** —— 不许装成有（盘上有没有产物是另一回事，
 *    这一栏说的是"这次会话里有没有导过"）；
 * ③ **产物清单要分清"目录"和"文件"** —— 章节导出落在 `exports/` 目录里（目录 + 文件两项），
 *    说成一坨路径，作者不知道该去哪儿找产物。
 *
 * 为什么要单独一个模块：右栏那几个数（路径 / 目录 / 章数 / 字数 / 敏感词 / 清单）
 * 是能算的，塞在组件里就只能靠人眼看 ⇒ 提成纯函数单独判
 * （`apps/desktop/test/export-artifacts.test.ts`），改坏了当场红。
 */

/** 产物清单里的一条：要么是目录（产物落点），要么是文件（产物本身 / 中间稿） */
export interface ExportArtifactItem {
  /** 这一条是什么（人话，不是路径） */
  label: string;
  /** 项目内相对路径 */
  path: string;
  /** 文件还是目录 */
  kind: "文件" | "目录";
}

/** 右栏那一栏的全部内容（没导出过时是"还没有导出过"） */
export interface ExportArtifactsSummary {
  /** 导出过没有（false ⇒ 界面必须说"还没有导出过"） */
  hasExport: boolean;
  /** 没导出过时那一句话（写死在这里，界面不许自己编） */
  emptyNote: string;
  /** 实际产出的格式 */
  format: string;
  /** 产物路径（项目内相对路径） */
  path: string;
  /** 产物所在目录（`exports/x.txt` ⇒ `exports`；没有目录层级 ⇒ 空串） */
  dir: string;
  /** 导出的章数 */
  chapters: number;
  /** 导出的字数 */
  words: number;
  /** 敏感词结论（error 级；提示级不阻断） */
  sensitive: string;
  /** 产物清单（目录 + 文件） */
  artifacts: ExportArtifactItem[];
  /** 产物清单里有没有目录项 */
  hasDirectory: boolean;
  /** 产物文件指纹（同一份载荷里的 hash） */
  hash: string;
  /** 喂给 pandoc 的源稿（仅非 TXT 格式有） */
  sourcePath: string;
}

/** 没导出过时的那句话（唯一的出处：界面与判据都从这里取） */
export const EMPTY_EXPORT_NOTE = "还没有导出过";

/** 取路径里的目录部分（`exports/x.txt` ⇒ `exports`；`x.txt` ⇒ 空串） */
export function exportArtifactDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "" : path.slice(0, at);
}

/**
 * 把一次导出的回执算成右栏那一栏。
 *
 * `result` 为 null ⇒ 没导出过 ⇒ 一律说"还没有导出过"，**不许**给出任何路径或数字。
 */
export function summarizeExportArtifacts(result: ExportRunResult | null): ExportArtifactsSummary {
  if (result === null) {
    return {
      hasExport: false,
      emptyNote: EMPTY_EXPORT_NOTE,
      format: "",
      path: "",
      dir: "",
      chapters: 0,
      words: 0,
      sensitive: "",
      artifacts: [],
      hasDirectory: false,
      hash: "",
      sourcePath: "",
    };
  }
  const dir = exportArtifactDir(result.path);
  const artifacts: ExportArtifactItem[] = [];
  if (dir !== "") {
    artifacts.push({ label: "产物落点", path: dir, kind: "目录" });
  }
  artifacts.push({ label: "章节导出产物", path: result.path, kind: "文件" });
  const sourcePath = result.sourcePath ?? "";
  if (sourcePath !== "") {
    artifacts.push({ label: "喂给 pandoc 的源稿", path: sourcePath, kind: "文件" });
  }
  return {
    hasExport: true,
    emptyNote: "",
    format: result.format.toUpperCase(),
    path: result.path,
    dir,
    chapters: result.chapters,
    words: result.words,
    sensitive: result.clean ? "无 error 级敏感词命中" : "仍有 error 级敏感词命中，建议处理后再投稿",
    artifacts,
    hasDirectory: artifacts.some((item) => item.kind === "目录"),
    hash: result.hash,
    sourcePath,
  };
}
