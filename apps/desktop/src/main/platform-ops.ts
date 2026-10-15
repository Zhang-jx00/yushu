/* SPDX-License-Identifier: Apache-2.0 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { YushuError, codePointCompare } from "@yushu/core";
import { parsePlatformExport, type PlatformExportPack } from "@yushu/export";
import type { PlatformPackSummary } from "../shared/ipc.js";
import { packsRoot } from "./paths.js";

/**
 * 平台导出包的文件侧（M5 / T5-4 第四段·K11 第二段，R94）。
 *
 * 引擎那边（`@yushu/export/platform-format.ts`）是纯函数，不碰 fs；这一层只负责
 * "去哪儿找包、读出来、交给纯函数解析"。**一个平台名都不写死**：
 * 目录里有什么就列什么，参数一律以包内容为准（K11 的硬要求）。
 *
 * 三条口径：
 * ① 包目录不存在 ⇒ 空清单，不抛错——导出页其余功能照常用，没有包就没有平台格式；
 * ② 坏包**不静默丢掉**：照样进清单，但带 `parseError` 与 `pack: null`，
 *    让作者看得见"这里有个包，但它不合规"，而不是以为自己没配；
 * ③ 选中某个包时（`loadPlatformPack`）解析失败要抛**引擎原话**，不改写、不缩写。
 */

/** 平台包的文件名（每个平台一个目录，一个这一份文件） */
export const PLATFORM_PACK_FILE = "platform-export.yaml";

/** 默认根目录：仓库 `packs/platforms/`（与派系包同一套"开发期读仓库"的口径） */
export function platformPacksRoot(): string {
  return join(packsRoot, "platforms");
}

export interface ScannedPlatformPack extends PlatformPackSummary {
  /** 包所在目录（绝对路径，只在主进程内部用，不进 IPC 载荷） */
  root: string;
  /** 解析成功才有值；坏包为 null 且 `parseError` 说明原因 */
  pack: PlatformExportPack | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把包内容摊成界面要用的摘要；解析失败时给空值 + 由调用方带上 parseError */
export function summaryOf(id: string, pack: PlatformExportPack | null): Omit<PlatformPackSummary, "parseError"> {
  return {
    id,
    platform: pack?.platform ?? "",
    version: pack?.version ?? "",
    chapterTitleFormat: pack?.chapter_title_format ?? "",
    encoding: pack?.encoding ?? "",
    validWordRule: pack?.valid_word_rule ?? "",
    submissionMaterials: pack?.submission_materials ?? [],
    sourceUrls: pack?.source_urls ?? [],
    effectiveDate: pack?.effective_date ?? "",
    checkedAt: pack?.checked_at ?? "",
  };
}

/** 扫描平台包目录（按 id 码点序返回，顺序可复现是第六条红线） */
export async function scanPlatformPacks(root = platformPacksRoot()): Promise<ScannedPlatformPack[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const found: ScannedPlatformPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const file = join(dir, PLATFORM_PACK_FILE);
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    try {
      const pack = parsePlatformExport(text);
      found.push({ ...summaryOf(entry.name, pack), parseError: null, root: dir, pack });
    } catch (err) {
      // 坏包照样进清单：作者要能看见"这里有个包但它不合规"，而不是以为自己没配
      found.push({ ...summaryOf(entry.name, null), parseError: messageOf(err), root: dir, pack: null });
    }
  }
  found.sort((a, b) => codePointCompare(a.id, b.id));
  return found;
}

/** 载荷用的摘要：绝对路径与包对象留在主进程，不进 IPC */
export function toSummary(item: ScannedPlatformPack): PlatformPackSummary {
  return {
    id: item.id,
    platform: item.platform,
    version: item.version,
    chapterTitleFormat: item.chapterTitleFormat,
    encoding: item.encoding,
    validWordRule: item.validWordRule,
    submissionMaterials: item.submissionMaterials,
    sourceUrls: item.sourceUrls,
    effectiveDate: item.effectiveDate,
    checkedAt: item.checkedAt,
    parseError: item.parseError,
  };
}

/** 按 id 取一份可用的包；找不到 / 解析失败都抛错（调用方决定是"预览留白"还是"导出前拒"） */
export async function loadPlatformPack(
  id: string,
  root = platformPacksRoot(),
): Promise<{ dir: string; pack: PlatformExportPack }> {
  const dir = join(root, id);
  const file = join(dir, PLATFORM_PACK_FILE);
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) {
    throw new YushuError(
      "E_PLATFORM_PACK_NOT_FOUND",
      `找不到平台导出包：${id}（应放在 ${PLATFORM_PACK_FILE} 所属的 packs/platforms/${id}/ 目录；御书不替你编一份参数）`,
    );
  }
  return { dir, pack: parsePlatformExport(text) };
}
