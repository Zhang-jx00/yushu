/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_EXPORT_KEYS,
  checkPlatformExport,
  parsePlatformExport,
  renderChapterTitle,
} from "../src/platform-format.js";

/**
 * 平台章节格式适配（M5 / T5-4 第四段·K11，R93）。
 *
 * K11 的硬要求是那句话：**"平台章节格式参数（从 I07 规则包读取，不硬编码）"**。
 * 所以这一层的测试有两类：一类验功能，一类验"参数确实来自包、没被写死在代码里"。
 * 后者靠**读仓库里真实的那份包**来验——如果哪天有人把平台数字抄进代码，
 * 这条用例会因为"包里的值与代码里的默认值一致"这种巧合而漏过去吗？不会：
 * 代码里根本没有默认值可读，字段一律从包解析，缺来源就直接拒（I07 的 pr-rule-source-missing）。
 */

const PACK_PATH = new URL("../../../../packs/platforms/fanqie/platform-export.yaml", import.meta.url);

const chapter = (index: number, title: string, body: string) => ({
  outlineRef: `co-${String(index)}`,
  chapterId: `ch-${String(index).padStart(3, "0")}`,
  volumeId: "vol-a",
  volumeTitle: "第一卷 风起",
  act: "起",
  volumeIndex: 1,
  idx: index,
  title,
  body,
  statedWordCount: body.length,
});

describe("平台导出参数解析（K11：参数从包读，不硬编码）", () => {
  it("白名单之外的键直接拒：不许悄悄塞进代码不认识的字段", () => {
    const text = ["platform: fanqie", "chapter_title_format: '第{index}章 {title}'", "sneaky: 1"].join("\n");
    expect(() => parsePlatformExport(text)).toThrowError(/sneaky/);
  });

  it("缺来源 / 缺生效日期 ⇒ 拒（I07 的 pr-rule-source-missing 是 error 级）", () => {
    const noSource = ["platform: fanqie", "chapter_title_format: '第{index}章 {title}'"].join("\n");
    expect(() => parsePlatformExport(noSource)).toThrowError(/source_urls/);
    const noEffective = [
      "platform: fanqie",
      "chapter_title_format: '第{index}章 {title}'",
      "source_urls: [https://example.com]",
    ].join("\n");
    expect(() => parsePlatformExport(noEffective)).toThrowError(/effective_date/);
  });

  it("仓库里那份番茄包必须解析得过，且字段都在白名单内（包与代码不许各说各话）", () => {
    const pack = parsePlatformExport(readFileSync(PACK_PATH, "utf8"));
    expect(pack.platform).toBe("fanqie");
    expect(Object.keys(pack).every((key) => (PLATFORM_EXPORT_KEYS as readonly string[]).includes(key) || key === "source_urls"
      || key === "effective_date" || key === "checked_at" || key === "version")).toBe(true);
    // 标题模板必须带这两个占位符，否则章节序号/标题会丢
    expect(pack.chapter_title_format).toContain("{index}");
    expect(pack.chapter_title_format).toContain("{title}");
  });
});

describe("章节标题渲染与格式核对", () => {
  it("只认 {index} 与 {title}；写错占位符要报错，不许原样输出", () => {
    expect(renderChapterTitle("第{index}章 {title}", { index: 3, title: "转折" })).toBe("第3章 转折");
    expect(() => renderChapterTitle("第{num}章 {title}", { index: 3, title: "转折" })).toThrowError(/\{num\}/);
  });

  it("标题不符合平台格式 ⇒ 点名是哪一章、该长什么样", () => {
    const pack = parsePlatformExport(readFileSync(PACK_PATH, "utf8"));
    const rows = checkPlatformExport({
      pack,
      chapters: [chapter(1, "第一章 边城少年", "正文一"), chapter(2, "夜色", "正文二")],
    });
    // 第一章已经带"第N章"前缀 ⇒ 套模板会重复；第二章是裸标题 ⇒ 正好由模板补上前缀
    const repeat = rows.find((row) => row.rule === "export-platform-title-repeat");
    expect(repeat?.subject).toBe("ch-001");
    expect(repeat?.detail).toContain("第1章");
    expect(rows.find((row) => row.rule === "export-platform-title-repeat")).toBeDefined();
    expect(rows.some((row) => row.subject === "ch-002")).toBe(false);
  });

  it("投稿材料缺项 ⇒ 按包里的清单点名，不自己另列一套", () => {
    // 清单来自包（这里用一份测试内的包，值取 I07 记的晋江签约模板四部分）；
    // 仓库里那份番茄包**故意留空**——I07 没给番茄的材料清单，宁缺毋造。
    const pack = parsePlatformExport(
      [
        "platform: jjwxc",
        "chapter_title_format: '第{index}章 {title}'",
        "encoding: utf-8",
        "volume_separator: |",
        "  \\n\\n",
        "valid_word_rule: 自然月内每日有效过审字数",
        "submission_materials: [简纲, 人设, 创新点, 看点]",
        "source_urls: [https://help.jjwxc.net/index.php?c_id=286]",
        "effective_date: 2025-01-01",
        "checked_at: 2026-09-29",
        "version: 1.0.0",
      ].join("\n"),
    );
    const rows = checkPlatformExport({
      pack,
      chapters: [chapter(1, "夜色", "正文")],
      materials: { 简纲: true, 人设: true },
    });
    const missing = rows.filter((row) => row.rule === "export-platform-materials-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.detail).toContain("创新点");
    expect(missing[0]?.detail).toContain("看点");
    expect(missing[0]?.detail).not.toContain("简纲");
  });

  it("番茄包不报材料缺项：清单是空的，代码不替它补一套", () => {
    const pack = parsePlatformExport(readFileSync(PACK_PATH, "utf8"));
    expect(pack.submission_materials).toEqual([]);
    const rows = checkPlatformExport({ pack, chapters: [chapter(1, "夜色", "正文")] });
    expect(rows.some((row) => row.rule === "export-platform-materials-missing")).toBe(false);
  });

  it("非 utf-8 编码要报错级：导出链路目前只写 UTF-8", () => {
    const text = [
      "platform: fanqie",
      "chapter_title_format: '第{index}章 {title}'",
      "encoding: gbk",
      "volume_separator: |",
      "  \\n\\n",
      "valid_word_rule: 后台打卡口径",
      "submission_materials: [简纲]",
      "source_urls: [https://example.com]",
      "effective_date: 2025-01-01",
      "checked_at: 2026-09-29",
      "version: 1.0.0",
    ].join("\n");
    const pack = parsePlatformExport(text);
    const rows = checkPlatformExport({ pack, chapters: [chapter(1, "夜色", "正文")] });
    const enc = rows.find((row) => row.rule === "export-platform-encoding");
    expect(enc?.severity).toBe("error");
  });
});
