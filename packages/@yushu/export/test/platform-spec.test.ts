/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_SPEC_FIELDS,
  checkPlatformSpecConsistency,
  parsePlatformSpec,
  type PlatformSpec,
} from "../src/platform-spec.js";

/**
 * 平台规则包解析（M5 / T5-8，R177）。
 *
 * 这组判据盯的是**一条纪律**：平台规则不许凭印象写。
 * 所以「不合规」不是 warning 级的提醒，而是**解析即拒**——
 * 缺出处、字段不在口径表里、口径名对不上、门槛写成 0，全部当场抛错。
 * 一个能装下编造规则的包，比没有包更坏。
 */

const VALID = `platform: qimao
version: "1.0.0"
effective_date: 2025-02-01
checked_at: 2026-10-25
source_urls:
  - https://www.qimao.com/fuli/
rules:
  - id: qimao.daily-words.floor
    field: daily-words.floor
    title: 每日更新字数下限
    value: 4000
    unit: 字/日
    meaning: 每日更新字数下限（全勤奖口径）
    source: "https://www.qimao.com/fuli/ —— 全勤奖表：「日更≥4000字」"
    effective_from: 2025-02-01
`;

/** 在合规样例上做一处改动（换行/字段值），省得每条判据都重抄整份 YAML */
function withRule(field: string, replacement: string): string {
  return VALID.replace(field, replacement);
}

describe("平台规则包解析（R177）：不合规就是拒", () => {
  it("合规包解析得出来，各字段逐字对上", () => {
    const spec = parsePlatformSpec(VALID);
    expect(spec.platform).toBe("qimao");
    expect(spec.version).toBe("1.0.0");
    expect(spec.effective_date).toBe("2025-02-01");
    expect(spec.checked_at).toBe("2026-10-25");
    expect(spec.source_urls).toEqual(["https://www.qimao.com/fuli/"]);
    expect(spec.rules).toHaveLength(1);
    const rule = spec.rules[0]!;
    expect(rule.id).toBe("qimao.daily-words.floor");
    expect(rule.field).toBe("daily-words.floor");
    expect(rule.value).toBe(4000);
    expect(rule.unit).toBe("字/日");
    expect(rule.meaning).toBe("每日更新字数下限（全勤奖口径）");
    expect(rule.source).toContain("https://www.qimao.com/fuli/");
    expect(rule.effective_from).toBe("2025-02-01");
    // 类由口径表给定，包里不另写
    expect(rule.kind).toBe("word_floor");
  });

  it("**缺出处的条目进不了包**（没有出处就是编的）", () => {
    const text = withRule("    source: \"https://www.qimao.com/fuli/ —— 全勤奖表：「日更≥4000字」\"\n", "");
    expect(() => parsePlatformSpec(text)).toThrowError(/缺出处字段 source/);
  });

  it("出处里没有可核 URL ⇒ 拒（“出处”必须指得回公开规则页）", () => {
    const text = withRule(
      "    source: \"https://www.qimao.com/fuli/ —— 全勤奖表：「日更≥4000字」\"",
      "    source: \"听编辑说的\"",
    );
    expect(() => parsePlatformSpec(text)).toThrowError(/没有可核的 URL/);
  });

  it("规则的出处链接必须在本包登记过的 source_urls 里（没登记过的链接等于来路不明）", () => {
    const text = withRule(
      "    source: \"https://www.qimao.com/fuli/ —— 全勤奖表：「日更≥4000字」\"",
      "    source: \"https://example.com/other —— 条款\"",
    );
    expect(() => parsePlatformSpec(text)).toThrowError(/不在本包的 source_urls 里/);
  });

  it("顶层未知键 ⇒ 拒（拼错的键会让规则以为自己少了一个条件）", () => {
    expect(() => parsePlatformSpec(`${VALID}extra_key: 1\n`)).toThrowError(/不认识的字段/);
  });

  it("规则条目未知键 ⇒ 拒", () => {
    const text = withRule("    value: 4000\n", "    value: 4000\n    value_typo: 1\n");
    expect(() => parsePlatformSpec(text)).toThrowError(/含未知键/);
  });

  it("字段不在口径登记表里 ⇒ 拒（口径表是唯一出处，不许私造字段）", () => {
    const text = withRule("    field: daily-words.floor\n", "    field: my-own-field\n");
    expect(() => parsePlatformSpec(text)).toThrowError(/不在平台口径登记表里/);
  });

  it("口径名不是该字段的合法口径名 ⇒ 拒", () => {
    const text = withRule(
      "    meaning: 每日更新字数下限（全勤奖口径）",
      "    meaning: 我自己编的口径",
    );
    expect(() => parsePlatformSpec(text)).toThrowError(/不是字段「daily-words.floor」的合法口径名/);
  });

  it("单位与口径名对不上 ⇒ 拒（一个口径名只许一个单位）", () => {
    const text = withRule("    unit: 字/日\n", "    unit: 千字/日\n");
    expect(() => parsePlatformSpec(text)).toThrowError(/的单位/);
  });

  it("字数门槛写成 0 / 负数 / 字符串 ⇒ 拒（“达标”不能变成假话）", () => {
    for (const bad of ["0", "-1", '"4000"']) {
      const text = withRule("    value: 4000\n", `    value: ${bad}\n`);
      expect(() => parsePlatformSpec(text)).toThrowError(/正整数/);
    }
  });

  it("条款类规则（note）的值必须是原文字符串", () => {
    const text = `platform: qimao
version: "1.0.0"
effective_date: 2025-02-01
checked_at: 2026-10-25
source_urls:
  - https://www.qimao.com/fuli/
rules:
  - id: qimao.no-studio-submission
    field: no-studio-submission
    title: 禁止工作室投稿
    value: 123
    unit: 条
    meaning: 禁止的工作室投稿条款
    source: "https://www.qimao.com/fuli/ —— 签约及分成模式"
    effective_from: 2025-02-01
`;
    expect(() => parsePlatformSpec(text)).toThrowError(/条款原文/);
  });

  it("同一个包内规则 id 重复 ⇒ 拒（id 撞车就是写错了）", () => {
    const rule = `  - id: qimao.daily-words.floor
    field: daily-words.floor
    title: 每日更新字数下限
    value: 4000
    unit: 字/日
    meaning: 每日更新字数下限（全勤奖口径）
    source: "https://www.qimao.com/fuli/ —— 全勤奖表"
    effective_from: 2025-02-01
`;
    const text = `platform: qimao
version: "1.0.0"
effective_date: 2025-02-01
checked_at: 2026-10-25
source_urls:
  - https://www.qimao.com/fuli/
rules:
${rule}${rule}`;
    expect(() => parsePlatformSpec(text)).toThrowError(/规则 id 重复/);
  });

  it("日期形状不对 / 日历上不存在 ⇒ 拒", () => {
    expect(() => parsePlatformSpec(VALID.replace("effective_date: 2025-02-01", "effective_date: 2025-2-1"))).toThrowError(
      /ISO 日期/,
    );
    expect(() => parsePlatformSpec(VALID.replace("effective_date: 2025-02-01", "effective_date: 2025-02-30"))).toThrowError(
      /不是日历上存在的日期/,
    );
  });

  it("source_urls 缺失 / 不是 http 链接 ⇒ 拒（缺来源即 error）", () => {
    const noUrls = VALID.replace(/source_urls:\n  - https:\/\/www\.qimao\.com\/fuli\/\n/, "");
    expect(() => parsePlatformSpec(noUrls)).toThrowError(/缺 source_urls/);
    const badUrl = VALID.replace("  - https://www.qimao.com/fuli/", "  - ftp://example.com/x");
    expect(() => parsePlatformSpec(badUrl)).toThrowError(/不是 http\(s\) 链接/);
  });

  it("口径登记表本身是活的（每个字段都有类、每个口径名都有单位）", () => {
    for (const [field, shape] of Object.entries(PLATFORM_SPEC_FIELDS)) {
      expect(shape.kind, `字段 ${field} 没有类`).toMatch(/word_floor|note/);
      expect(shape.meanings.length, `字段 ${field} 没有口径名`).toBeGreaterThan(0);
      for (const pair of shape.meanings) {
        expect(pair.meaning.length, `字段 ${field} 有空口径名`).toBeGreaterThan(0);
        expect(pair.unit.length, `字段 ${field} 的口径名「${pair.meaning}」没有单位`).toBeGreaterThan(0);
      }
    }
  });
});

describe("跨包一致性校验（R177 埋下的判据，R178 接第二个包）", () => {
  const qimao: PlatformSpec = parsePlatformSpec(VALID);

  it("同一个包自己跟自己没有冲突", () => {
    expect(checkPlatformSpecConsistency([{ packId: "qimao", spec: qimao }])).toEqual([]);
  });

  it("两个包用同一个字段但口径名不同 ⇒ 报冲突（这才是真打架）", () => {
    const other: PlatformSpec = {
      ...qimao,
      platform: "faloo",
      rules: [
        {
          ...qimao.rules[0]!,
          id: "faloo.daily-words.floor",
          // 打卡口径 ≠ 更新口径：数字可能一样，算法不一样
          meaning: "每日打卡字数下限（后台打卡口径）",
        },
      ],
    };
    const conflicts = checkPlatformSpecConsistency([
      { packId: "faloo", spec: other },
      { packId: "qimao", spec: qimao },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("field-meaning-mismatch");
    expect(conflicts[0]!.subject).toBe("daily-words.floor");
    expect(conflicts[0]!.packs).toEqual(["faloo", "qimao"]);
  });

  it("两个包用同一个字段且口径名一致 ⇒ **不是**冲突（数值按平台不同是正常的）", () => {
    const other: PlatformSpec = {
      ...qimao,
      platform: "faloo",
      rules: [{ ...qimao.rules[0]!, id: "faloo.daily-words.floor", value: 6000 }],
    };
    expect(
      checkPlatformSpecConsistency([
        { packId: "faloo", spec: other },
        { packId: "qimao", spec: qimao },
      ]),
    ).toEqual([]);
  });

  it("同一个规则 id 出现在两个包 ⇒ 报冲突（id 必须全局唯一）", () => {
    const other: PlatformSpec = { ...qimao, platform: "faloo" };
    const conflicts = checkPlatformSpecConsistency([
      { packId: "faloo", spec: other },
      { packId: "qimao", spec: qimao },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("id-collision");
    expect(conflicts[0]!.subject).toBe("qimao.daily-words.floor");
  });

  it("两个包声称同一个平台 ⇒ 报冲突（作者选了哪个说不清）", () => {
    const other: PlatformSpec = {
      ...qimao,
      rules: [{ ...qimao.rules[0]!, id: "faloo.daily-words.floor" }],
    };
    const conflicts = checkPlatformSpecConsistency([
      { packId: "other", spec: other },
      { packId: "qimao", spec: qimao },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("platform-collision");
  });
});
