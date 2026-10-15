/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError, codePointCompare, parseFrontmatter } from "@yushu/core";

/**
 * 平台章节格式适配（M5 / T5-4 第四段·K11，R93；纯函数，不碰 fs）。
 *
 * K11 那句话是本模块的存在理由：**"平台章节格式参数（从 I07 规则包读取，不硬编码）"**。
 * 所以这里一个平台名字都不认、一个阈值都不写死：所有参数从包解析，
 * 而包必须带来源与生效日期（I07 的 `pr-rule-source-missing` 是 error 级硬设计原则）。
 *
 * 三条要紧的边界：
 * ① **未知键直接拒**：包偷偷加一个代码不认识的字段，比报错危险得多——它会安静地被忽略；
 * ② **占位符只认 `{index}` 与 `{title}`**：写错成 `{num}` 要当场报错，
 *    不许原样吐进作者的书稿里（那等于把模板漏给客户看）；
 * ③ **不编造数值门槛**：研究里没给"单章字数上限"的量化口径，本模块就只报"口径是什么"，
 *    不假装能判"这章超没超"。宁可少判，不可瞎判。
 */

/** 包里允许出现的格式字段（K11 的 platform_export 草案逐条对应） */
export const PLATFORM_EXPORT_KEYS = [
  "platform",
  "chapter_title_format",
  "encoding",
  "volume_separator",
  "valid_word_rule",
  "submission_materials",
] as const;

/** 溯源字段（I07：缺来源即 error），与格式字段分开列，避免白名单越写越长还说不清谁必填 */
export const PLATFORM_PROVENANCE_KEYS = ["source_urls", "effective_date", "checked_at", "version"] as const;

export interface PlatformExportPack {
  platform: string;
  chapter_title_format: string;
  encoding: string;
  volume_separator: string;
  valid_word_rule: string;
  submission_materials: string[];
  source_urls: string[];
  effective_date: string;
  checked_at: string;
  version: string;
}

export interface PlatformFormatRow {
  rule: string;
  severity: "error" | "warn" | "info";
  subject: string;
  detail: string;
}

/** 只认 YAML 里那一层键；值统一按字符串/字符串数组处理（不做多态猜测） */
function scalarOf(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function listOf(raw: Record<string, unknown>, key: string): string[] | null {
  const value = raw[key];
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length === value.length ? items : null;
}

/** 解析一份 platform_export 包；任何不合规都是抛错（不静默降级为"少几个字段"） */
export function parsePlatformExport(text: string): PlatformExportPack {
  let parsed: unknown;
  try {
    // parseFrontmatter 的契约是"坏输入直接抛 FrontmatterError"，没有 ok 字段可查
    parsed = parseFrontmatter(`---\n${text}\n---`).data;
  } catch (err) {
    throw new YushuError(
      "E_PLATFORM_FORMAT",
      `平台导出包解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const raw = (parsed ?? {}) as Record<string, unknown>;
  const allowed = new Set<string>([...PLATFORM_EXPORT_KEYS, ...PLATFORM_PROVENANCE_KEYS]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new YushuError(
      "E_PLATFORM_FORMAT",
      `平台导出包有代码不认识的字段：${unknown.sort(codePointCompare).join("、")}（未知键一律拒，不静默忽略）`,
    );
  }
  const need = (key: string): string => {
    const value = scalarOf(raw, key);
    if (value === null) throw new YushuError("E_PLATFORM_FORMAT", `平台导出包缺必填字段 ${key}`);
    return value;
  };
  const needList = (key: string, min = 1): string[] => {
    const value = listOf(raw, key);
    if (value === null || value.length < min) {
      throw new YushuError("E_PLATFORM_FORMAT", `平台导出包的 ${key} 必须是非空字符串数组（缺来源即 pr-rule-source-missing）`);
    }
    return value;
  };
  const platform = need("platform");
  const chapterTitleFormat = need("chapter_title_format");
  const materials = listOf(raw, "submission_materials") ?? [];
  return {
    platform,
    chapter_title_format: chapterTitleFormat,
    encoding: scalarOf(raw, "encoding") ?? "utf-8",
    volume_separator: scalarOf(raw, "volume_separator") ?? "\n\n",
    valid_word_rule: scalarOf(raw, "valid_word_rule") ?? "（包未声明字数口径）",
    submission_materials: materials,
    source_urls: needList("source_urls"),
    effective_date: need("effective_date"),
    checked_at: need("checked_at"),
    version: need("version"),
  };
}

/** 渲染章节标题：占位符只认 {index} 与 {title}，写错就抛，不许原样吐进书稿 */
export function renderChapterTitle(
  template: string,
  parts: { index: number; title: string },
): string {
  const unknown = [...template.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined)
    .filter((name) => name !== "index" && name !== "title");
  if (unknown.length > 0) {
    throw new YushuError(
      "E_PLATFORM_FORMAT",
      `章节标题模板里有不认识的占位符：{${unknown.sort(codePointCompare).join("}、{")}}（只支持 {index} 与 {title}）`,
    );
  }
  return template.replace(/\{index\}/g, String(parts.index)).replace(/\{title\}/g, parts.title);
}

/** 已经自带"第N章"前缀的裸标题（真源里很常见：章纲标题就写着"第一章 边城少年"） */
const HAS_CHAPTER_PREFIX = /^\s*第[0-9一二三四五六七八九十百千]+[章节回]/;

/**
 * 按包核对一批章节：只报**包能支持**的判断（标题会不会重复前缀、编码对不对、投稿材料缺哪几项）。
 * 不判"单章字数超没超"——研究里没给量化上限，写出来就是编的。
 */
export function checkPlatformExport(input: {
  pack: PlatformExportPack;
  chapters: Array<{ chapterId: string; idx: number; title: string }>;
  /** 已备好的投稿材料名集合；不传视为"一份都没备" */
  materials?: Record<string, boolean>;
}): PlatformFormatRow[] {
  const rows: PlatformFormatRow[] = [];
  const templatePrefixed = /第\{index\}章/.test(input.pack.chapter_title_format)
    || /第\{index\}节/.test(input.pack.chapter_title_format);

  if (input.pack.encoding.toLowerCase() !== "utf-8") {
    rows.push({
      rule: "export-platform-encoding",
      severity: "error",
      subject: input.pack.platform,
      detail: `包要求 ${input.pack.encoding}，而御书导出一律写 UTF-8；要真上这个平台得先决定在哪一步转码（转码不是导出层顺手做的事）`,
    });
  }

  for (const chapter of input.chapters) {
    // 套模板之前标题已经带"第N章"⇒ 结果会是"第1章 第一章 边城少年"这种重复
    if (templatePrefixed && HAS_CHAPTER_PREFIX.test(chapter.title)) {
      rows.push({
        rule: "export-platform-title-repeat",
        severity: "warn",
        subject: chapter.chapterId,
        detail: `标题已含"第N章"，套模板 ${input.pack.chapter_title_format} 会得到「${renderChapterTitle(
          input.pack.chapter_title_format,
          { index: chapter.idx, title: chapter.title },
        )}」；建议真源里把标题写成裸名（"边城少年"），前缀交给平台格式`,
      });
    }
  }

  const missing = input.pack.submission_materials.filter((name) => input.materials?.[name] !== true);
  if (missing.length > 0) {
    rows.push({
      rule: "export-platform-materials-missing",
      severity: "info",
      subject: input.pack.platform,
      detail: `投稿材料还缺：${missing.join("、")}（清单来自包 v${input.pack.version}，生效 ${input.pack.effective_date}）；字数口径：${input.pack.valid_word_rule}`,
    });
  }

  rows.sort((a, b) =>
    a.rule === b.rule
      ? a.subject === b.subject
        ? codePointCompare(a.detail, b.detail)
        : codePointCompare(a.subject, b.subject)
      : codePointCompare(a.rule, b.rule),
  );
  return rows;
}
