import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { FrontmatterError } from "./errors.js";

/**
 * Markdown + YAML frontmatter 序列化基元（docs/01 §6 数据主权：文件是用户可读的真源）。
 * 约定：frontmatter 位于文件头部，以 `---` 开始、`---` 结束。
 */

export interface ParsedFrontmatter<T = Record<string, unknown>> {
  data: T;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export function hasFrontmatter(source: string): boolean {
  return FRONTMATTER_RE.test(source);
}

/** 解析 Markdown 的 YAML frontmatter；缺失或非法时抛 FrontmatterError。 */
export function parseFrontmatter<T = Record<string, unknown>>(source: string): ParsedFrontmatter<T> {
  const m = FRONTMATTER_RE.exec(source);
  if (!m || m[1] === undefined) {
    throw new FrontmatterError("文件缺少 YAML frontmatter（应以 `---` 开头并以 `---` 结束）");
  }
  let data: unknown;
  try {
    data = parseYaml(m[1]);
  } catch (err) {
    throw new FrontmatterError("frontmatter YAML 解析失败", { cause: err });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("frontmatter 必须是 YAML 映射（key: value 结构）");
  }
  // 约定：frontmatter 与正文之间允许一个分隔空行，解析时仅剥离一层
  const body = source.slice(m[0].length).replace(/^\r?\n/, "");
  return { data: data as T, body };
}

/** 仅序列化 frontmatter 块（含首尾 `---`）。 */
export function serializeFrontmatter<T>(data: T): string {
  const yamlText = stringifyYaml(data, { lineWidth: 0 });
  return `---\n${yamlText}---\n`;
}

/**
 * 序列化设定卡：frontmatter + 正文。
 * 正文统一 LF 换行，去除首部空行并保证结尾单个换行。
 */
export function serializeCard<T>(data: T, body = ""): string {
  const frontmatter = serializeFrontmatter(data);
  const normalized = body
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n*$/, "\n");
  return `${frontmatter}\n${normalized}`;
}