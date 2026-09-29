import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { YushuError } from "@yushu/core";
import {
  ELEVEN_PIECE_KEYS,
  PACK_API_VERSION,
  PACK_KIND,
  type GenrePackManifest,
  type LoadedPack,
} from "./types.js";

export class PackLoadError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_PACK_LOAD", message, options);
  }
}

const SCALAR_KEYS = new Set(["world_preset", "glossary", "taboos", "platform_mapping", "evolution"]);

function toList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * 加载派系包目录（含 pack.yaml manifest）。
 * 仅做结构装载与文件存在性检查；完整校验交给 lintPack()。
 */
export function loadPack(packDir: string): LoadedPack {
  const dir = resolve(packDir);
  const manifestPath = join(dir, "pack.yaml");
  if (!existsSync(manifestPath)) {
    throw new PackLoadError(`缺少 pack.yaml：${manifestPath}`);
  }
  let manifest: GenrePackManifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, "utf8")) as GenrePackManifest;
  } catch (err) {
    throw new PackLoadError(`pack.yaml YAML 解析失败：${manifestPath}`, { cause: err });
  }
  if (manifest === null || typeof manifest !== "object") {
    throw new PackLoadError(`pack.yaml 内容非法（应为 YAML 映射）：${manifestPath}`);
  }

  const resolvedFiles: LoadedPack["resolvedFiles"] = {};
  const missingFiles: string[] = [];
  const content = (manifest.content ?? {}) as unknown as Record<string, unknown>;

  for (const key of ELEVEN_PIECE_KEYS) {
    if (key === "evolution") continue; // 内联对象，无文件
    const refs = toList(content[key]);
    if (refs.length === 0) continue;
    const paths: string[] = [];
    for (const ref of refs) {
      const abs = isAbsolute(ref) ? ref : resolve(dir, ref);
      if (existsSync(abs)) {
        paths.push(abs);
      } else {
        missingFiles.push(ref);
      }
    }
    if (paths.length > 0) resolvedFiles[key] = paths;
  }

  // 标量件套校验：给非标量键传字符串、标量键传数组时记录为缺失（由 lint 报错）
  for (const key of ELEVEN_PIECE_KEYS) {
    if (key === "evolution") continue;
    const raw = content[key];
    if (raw === undefined || raw === null) continue;
    const isScalarKey = SCALAR_KEYS.has(key);
    if (isScalarKey && Array.isArray(raw)) missingFiles.push(`${key}: 期望单文件路径，实际为数组`);
    if (!isScalarKey && typeof raw === "string") missingFiles.push(`${key}: 期望文件列表，实际为字符串`);
  }

  return { dir, manifest, resolvedFiles, missingFiles };
}

export { PACK_API_VERSION, PACK_KIND };