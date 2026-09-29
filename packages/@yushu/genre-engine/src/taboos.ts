import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { LoadedPack } from "./types.js";

/**
 * 派系包 taboos 件套解析（yushu.taboos/v1）。
 * 约束文本来源之一（T1-14 约束注入）；解析失败不阻断调用方（lint 已在派系包面板报错）。
 */

export interface PackTaboo {
  id: string;
  /** 雷点描述（作为约束条款下发） */
  desc: string;
}

export function parseTaboos(text: string): PackTaboo[] {
  const data = parseYaml(text) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const list = (data as Record<string, unknown>)["taboos"];
  if (!Array.isArray(list)) return [];
  const taboos: PackTaboo[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const desc = record["desc"];
    if (typeof desc !== "string" || desc.trim() === "") continue;
    taboos.push({
      id: typeof record["id"] === "string" ? record["id"] : `taboo-${taboos.length + 1}`,
      desc: desc.trim(),
    });
  }
  return taboos;
}

/** 读取派系包 taboos 文件（缺文件/解析失败返回空数组） */
export function loadPackTaboos(pack: LoadedPack): PackTaboo[] {
  const files = pack.resolvedFiles["taboos"] ?? [];
  const taboos: PackTaboo[] = [];
  for (const file of files) {
    try {
      taboos.push(...parseTaboos(readFileSync(file, "utf8")));
    } catch {
      // 单文件失败不阻断
    }
  }
  return taboos;
}