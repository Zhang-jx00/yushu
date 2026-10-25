/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError, codePointCompare } from "@yushu/core";
import { parse as parseYaml } from "yaml";

/**
 * 平台规则包（M5 / T5-8「平台规则包首轮填充」；纯函数，不碰 fs）。
 *
 * 这一层的存在理由只有一条：**平台规则不许凭印象写**。
 * 所以本模块的口径是「宁缺毋造」——
 * - 规则**必须**带出处（`source` 里要有可核的 URL）；没有出处的条目**进不了包**（解析即拒）；
 * - 规则 id / 字段键 / 口径名 / 单位**由一张登记表说了算**（`PLATFORM_SPEC_FIELDS`），
 *   包里只许引用，不许私造 ⇒ 同一个口径在所有平台包里指的是同一件事；
 * - 数值按平台不同而不同（4000 与 6000 不是冲突），**口径名不同才是冲突**（跨包校验抓这个）。
 *
 * 为什么口径表在代码里而不是在包里：口径表是「一个事实一个出处」的地方。
 * 若每个包各写各的口径名，两个包里的 `daily-words.floor` 就可能各说各话，
 * 而作者无从察觉——这就是跨包打架的真正来源。
 *
 * 三条边界：
 * ① **未知键一律拒**（拼错的键会让规则以为自己少了一个条件）；
 * ② **缺来源 = 拒**（不是警告：没有出处的平台规则等于编的）；
 * ③ **数值必须是正整数**（门槛是 0 或负数没有意义，而它会让人以为"不用更新也算达标"）。
 */

/** 包顶层允许出现的键 */
export const PLATFORM_SPEC_KEYS = [
  "platform",
  "version",
  "effective_date",
  "checked_at",
  "source_urls",
  "rules",
] as const;

/** 规则条目允许出现的键 */
export const PLATFORM_SPEC_RULE_KEYS = [
  "id",
  "field",
  "title",
  "value",
  "unit",
  "meaning",
  "source",
  "effective_from",
] as const;

/** 规则的两类形态：字数门槛 / 条款备注 */
export type PlatformSpecKind = "word_floor" | "note";

/** 口径表里的一条「口径名 + 单位」 */
export interface PlatformSpecMeaning {
  /** 口径名（**跨包必须逐字一致**，不一致就是跨包打架） */
  meaning: string;
  /** 单位（与口径名一一对应：同一个口径名不许换单位） */
  unit: string;
}

/** 一个字段键的形状：它是什么类的规则、有哪些合法口径名 */
export interface PlatformSpecFieldShape {
  kind: PlatformSpecKind;
  /** 该字段允许的口径名清单（**同一个字段在不同包里只能取其中一个**） */
  meanings: PlatformSpecMeaning[];
}

/**
 * 平台口径登记表（**唯一出处**）。
 *
 * 键 = 字段键（跨包对齐用的语义键）；值 = 这个字段是什么规则、有哪些**已知**口径名。
 * 一个字段列出两个口径名，是因为现实中确实有两种都存在但**不能混用**的口径
 * （例：`daily-words.floor` 的「每日更新字数下限（全勤奖口径）」与
 * 「每日打卡字数下限（后台打卡口径）」——数字可能一样，算法不一样）。
 * 登记表允许它们各自存在，但**同一个字段在两个包里取到不同的口径名，就是打架**。
 */
export const PLATFORM_SPEC_FIELDS: Record<string, PlatformSpecFieldShape> = {
  "daily-words.floor": {
    kind: "word_floor",
    meanings: [
      { meaning: "每日更新字数下限（全勤奖口径）", unit: "字/日" },
      { meaning: "每日打卡字数下限（后台打卡口径）", unit: "字/日" },
    ],
  },
  "monthly-words.floor": {
    kind: "word_floor",
    meanings: [{ meaning: "月更新总字数下限（全勤奖口径）", unit: "字/月" }],
  },
  "apply-words.floor": {
    kind: "word_floor",
    meanings: [{ meaning: "申请签约时正文须达到的字数门槛", unit: "字/书" }],
  },
  "vip-shelf-words.floor": {
    kind: "word_floor",
    meanings: [{ meaning: "上架成为付费作品的全书字数门槛", unit: "字/书" }],
  },
  "no-studio-submission": {
    kind: "note",
    meanings: [{ meaning: "禁止的工作室投稿条款", unit: "条" }],
  },
};

export interface PlatformSpecRule {
  /** 规则 id（**全局唯一**：平台命名空间 + 字段，跨包不许撞车） */
  id: string;
  /** 字段键（跨包对齐用的语义键，必须在口径表里） */
  field: string;
  /** 给作者看的这条规则的标题（各平台可以有自己的叫法） */
  title: string;
  /** 字数门槛给数字；条款备注给原文 */
  value: number | string;
  /** 单位（必须与口径名一一对应） */
  unit: string;
  /** 口径名（跨包必须逐字一致） */
  meaning: string;
  /** 出处（**必须含可核 URL**） */
  source: string;
  /** 生效日期（YYYY-MM-DD） */
  effective_from: string;
  /** 规则的类（由口径表给定，包里不另写） */
  kind: PlatformSpecKind;
}

export interface PlatformSpec {
  platform: string;
  version: string;
  effective_date: string;
  checked_at: string;
  source_urls: string[];
  rules: PlatformSpecRule[];
}

/** 跨包冲突（一条冲突 = 一个字段/一个 id 在两个包里对不上） */
export interface PlatformSpecConflict {
  /** 冲突类别（写进核对行，便于按类筛） */
  kind: "id-collision" | "field-meaning-mismatch" | "platform-collision";
  /** 冲突涉及的字段键或规则 id */
  subject: string;
  /** 涉及的包（码点序，可复现） */
  packs: string[];
  /** 人话结论：谁跟谁在什么上对不上 */
  detail: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new YushuError("E_PLATFORM_SPEC", message);
}

function scalarOf(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** ISO 日历日：形状对 + 日历上真的存在（2026-02-30 这种当场拒） */
function isoDateOf(raw: Record<string, unknown>, key: string, where: string): string {
  const text = scalarOf(raw, key);
  if (text === null) fail(`${where} 缺必填字段 ${key}`);
  if (!ISO_DATE.test(text)) fail(`${where} 的 ${key} 应为 ISO 日期 YYYY-MM-DD，实际「${text}」`);
  const [year, month, day] = text.split("-").map((part) => Number(part));
  const daysInMonth = new Date(Date.UTC(year as number, month as number, 0)).getUTCDate();
  if ((month as number) < 1 || (month as number) > 12 || (day as number) < 1 || (day as number) > daysInMonth) {
    fail(`${where} 的 ${key} 不是日历上存在的日期：${text}`);
  }
  return text;
}

/** 出处必须带 URL：没有可核链接的"出处"等于没有出处 */
function sourceOf(raw: Record<string, unknown>, where: string): string {
  const text = scalarOf(raw, "source");
  if (text === null) fail(`${where} 缺出处字段 source（缺来源的条目进不了包：没有出处就是编的）`);
  if (!/https?:\/\//.test(text)) {
    fail(`${where} 的 source 里没有可核的 URL（出处要能指回公开规则页，实际「${text}」）`);
  }
  return text;
}

/** 从出处里取出第一个链接（出处写成「URL —— 条款定位」的样子） */
export function firstUrlOf(source: string): string | null {
  const match = /https?:\/\/[^\s，。；、）】"'<>]+/.exec(source);
  return match === null ? null : match[0];
}

function urlListOf(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`平台规则包缺 ${key}（缺来源即 error：一个字都核不到的包不许进仓）`);
  }
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") fail(`平台规则包的 ${key} 里有空项`);
    const url = item.trim();
    if (!/^https?:\/\//.test(url)) fail(`平台规则包的 ${key} 里「${url}」不是 http(s) 链接`);
    urls.push(url);
  }
  return urls;
}

/** 解析一份平台规则包；任何不合规都是抛错（不静默降级为"少几条规则"） */
export function parsePlatformSpec(text: string): PlatformSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    fail(`平台规则包解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("平台规则包顶层应为映射");
  }
  const raw = parsed as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(PLATFORM_SPEC_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    fail(
      `平台规则包有代码不认识的字段：${unknown.sort(codePointCompare).join("、")}（未知键一律拒，不静默忽略）`,
    );
  }
  const platform = scalarOf(raw, "platform");
  if (platform === null) fail("平台规则包缺必填字段 platform");
  const version = scalarOf(raw, "version");
  if (version === null) fail("平台规则包缺必填字段 version");
  const effectiveDate = isoDateOf(raw, "effective_date", "平台规则包");
  const checkedAt = isoDateOf(raw, "checked_at", "平台规则包");
  const sourceUrls = urlListOf(raw, "source_urls");
  const list = raw["rules"];
  if (!Array.isArray(list) || list.length === 0) fail("平台规则包的 rules 应为非空数组");

  const rules: PlatformSpecRule[] = list.map((item, index) => parseRule(item, `rules[${index}]`));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) fail(`同一个包内规则 id 重复「${rule.id}」（id 撞车就是写错了）`);
    seen.add(rule.id);
    // 出处必须指向**本包登记过的页面**：不许在规则的 source 里塞一个没登记过的链接
    // （登记过 = 这个包承认自己核过那一页；没登记的链接等于来路不明）。
    const url = firstUrlOf(rule.source);
    if (url === null || !sourceUrls.includes(url)) {
      fail(
        `规则「${rule.id}」的出处链接「${url ?? ""}」不在本包的 source_urls 里（出处要指回登记过的页面）`,
      );
    }
  }
  return {
    platform,
    version,
    effective_date: effectiveDate,
    checked_at: checkedAt,
    source_urls: sourceUrls,
    rules,
  };
}

function parseRule(value: unknown, where: string): PlatformSpecRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} 应为映射`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(PLATFORM_SPEC_RULE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    fail(`${where} 含未知键「${unknown.sort(codePointCompare).join("、")}」（拒绝静默忽略）`);
  }
  const id = scalarOf(raw, "id");
  if (id === null) fail(`${where}.id 应为非空字符串`);
  const field = scalarOf(raw, "field");
  if (field === null) fail(`${where}.field 应为非空字符串`);
  const title = scalarOf(raw, "title");
  if (title === null) fail(`${where}.title 应为非空字符串`);
  const shape = PLATFORM_SPEC_FIELDS[field];
  if (shape === undefined) {
    fail(
      `${where}.field「${field}」不在平台口径登记表里（口径表是唯一出处：先在代码里立这个字段，再在包里引用）`,
    );
  }
  const meaningText = scalarOf(raw, "meaning");
  if (meaningText === null) fail(`${where}.meaning 应为非空字符串（口径名是跨包对齐的锚）`);
  const pair = shape.meanings.find((item) => item.meaning === meaningText);
  if (pair === undefined) {
    fail(
      `${where}.meaning「${meaningText}」不是字段「${field}」的合法口径名（合法口径名：${shape.meanings
        .map((item) => item.meaning)
        .join("、")}）`,
    );
  }
  const unit = scalarOf(raw, "unit");
  if (unit === null) fail(`${where}.unit 应为非空字符串`);
  if (unit !== pair.unit) {
    fail(`${where}.unit「${unit}」与口径名「${pair.meaning}」的单位「${pair.unit}」对不上（一个口径名只许一个单位）`);
  }
  const source = sourceOf(raw, where);
  const effectiveFrom = isoDateOf(raw, "effective_from", where);

  let ruleValue: number | string;
  if (shape.kind === "word_floor") {
    const num = raw["value"];
    if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
      fail(`${where}.value 应为正整数（字数门槛写成 0 或小数都会让"达标"变成假话）`);
    }
    ruleValue = num;
  } else {
    const text = scalarOf(raw, "value");
    if (text === null) fail(`${where}.value 应为条款原文（非空字符串）`);
    ruleValue = text;
  }
  return {
    id,
    field,
    title,
    value: ruleValue,
    unit,
    meaning: meaningText,
    source,
    effective_from: effectiveFrom,
    kind: shape.kind,
  };
}

/**
 * 跨包一致性校验（纯函数）。
 *
 * 抓三类打架：
 * ① **id 撞车**：同一个规则 id 出现在两个包里（id 必须是全局唯一的）；
 * ② **含义不一致**：同一个**字段**在两个包里取到了不同的口径名或单位
 *    （数值不同**不是**冲突——各平台的门槛本来就不同；口径名不同才是）；
 * ③ **平台撞车**：两个包声称是同一个平台（那作者在界面上分不清选的是哪个）。
 *
 * 参与校验的包必须**全部**传进来（漏一个包，这条校验就只剩半个世界——那比没有校验更坏）。
 */
export function checkPlatformSpecConsistency(
  packs: Array<{ packId: string; spec: PlatformSpec }>,
): PlatformSpecConflict[] {
  const conflicts: PlatformSpecConflict[] = [];

  // ① id 撞车
  const byId = new Map<string, string[]>();
  for (const pack of packs) {
    for (const rule of pack.spec.rules) {
      const owners = byId.get(rule.id) ?? [];
      owners.push(pack.packId);
      byId.set(rule.id, owners);
    }
  }
  for (const [id, owners] of byId) {
    if (owners.length > 1) {
      conflicts.push({
        kind: "id-collision",
        subject: id,
        packs: [...owners].sort(codePointCompare),
        detail: `规则 id「${id}」在 ${owners.length} 个包里同时出现（${[...owners].sort(codePointCompare).join("、")}）：规则 id 必须全局唯一，否则跨包合并时说不清谁覆盖谁`,
      });
    }
  }

  // ② 同一字段口径名/单位不一致
  const byField = new Map<string, Array<{ packId: string; rule: PlatformSpecRule }>>();
  for (const pack of packs) {
    for (const rule of pack.spec.rules) {
      const list = byField.get(rule.field) ?? [];
      list.push({ packId: pack.packId, rule });
      byField.set(rule.field, list);
    }
  }
  for (const [field, entries] of byField) {
    if (entries.length < 2) continue;
    const first = entries[0]!.rule;
    const mismatched = entries.filter(
      (entry) => entry.rule.meaning !== first.meaning || entry.rule.unit !== first.unit,
    );
    if (mismatched.length > 0) {
      const owners = entries.map((entry) => entry.packId).sort(codePointCompare);
      conflicts.push({
        kind: "field-meaning-mismatch",
        subject: field,
        packs: owners,
        detail:
          `字段「${field}」在各包里指的是不同口径：` +
          entries
            .map((entry) => `${entry.packId}=「${entry.rule.meaning}」（${entry.rule.unit}）`)
            .sort(codePointCompare)
            .join("、") +
          "（同一个字段跨包必须同义；口径不同就换一个字段键，或统一口径名）",
      });
    }
  }

  // ③ 平台撞车
  const byPlatform = new Map<string, string[]>();
  for (const pack of packs) {
    const owners = byPlatform.get(pack.spec.platform) ?? [];
    owners.push(pack.packId);
    byPlatform.set(pack.spec.platform, owners);
  }
  for (const [platform, owners] of byPlatform) {
    if (owners.length > 1) {
      conflicts.push({
        kind: "platform-collision",
        subject: platform,
        packs: [...owners].sort(codePointCompare),
        detail: `平台「${platform}」被 ${owners.length} 个包同时声明（${[...owners]
          .sort(codePointCompare)
          .join("、")}）：两个包抢同一个平台，作者选了哪个说不清`,
      });
    }
  }

  conflicts.sort((a, b) =>
    a.kind === b.kind
      ? a.subject === b.subject
        ? codePointCompare(a.packs.join("、"), b.packs.join("、"))
        : codePointCompare(a.subject, b.subject)
      : codePointCompare(a.kind, b.kind),
  );
  return conflicts;
}
