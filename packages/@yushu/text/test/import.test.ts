/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { cleanImportedText, decodeImportedText, detectSourceEncoding, splitImportedChapters } from "../src/import.js";

/**
 * 存量稿件导入（M5 / T5-7 引擎侧，R76；输入来源 I09）。
 *
 * 三条口径决定了这份导入能不能信：
 * ① **探测不出就不猜**：BOM 与严格 UTF-8 都不成立时才退 GB18030，且把"这是猜的"标在结果里；
 * ② **清洗必须留报告**：删了多少行、每类留一个样例，作者要能核对——静默改稿等于毁掉别人的稿子；
 * ③ **切不出章就别切**：没有章节标题的纯文本返回单篇并说明，绝不按字数硬切（那会切在句子中间）。
 */

const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
/**
 * 真 GBK 字节夹具：`夜色压下来。林渊拔剑而起。` 用 iconv 转出来的字节。
 * 不能写 `Buffer.from(s, "gb18030")` —— Node 的 Buffer **不支持** GB18030 编码方向
 * （`ERR_UNKNOWN_ENCODING`），只有 `TextDecoder` 能解。夹具用真字节，才测得到真路径。
 */
const GBK_TEXT = "夜色压下来。林渊拔剑而起。";
const GBK_BYTES = new Uint8Array([
  0xd2, 0xb9, 0xc9, 0xab, 0xd1, 0xb9, 0xcf, 0xc2, 0xc0, 0xb4, 0xa1, 0xa3,
  0xc1, 0xd6, 0xd4, 0xa8, 0xb0, 0xce, 0xbd, 0xa3, 0xb6, 0xf8, 0xc6, 0xf0, 0xa1, 0xa3,
]);

describe("detectSourceEncoding：BOM 优先，UTF-8 严格试，GB18030 兜底", () => {
  it("UTF-8 BOM 直接判定，并报告 BOM 会被剥掉", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("第一章 起", "utf8")]);
    const hit = detectSourceEncoding(bytes);
    expect(hit.encoding).toBe("utf-8");
    expect(hit.bom).toBe("utf-8");
    expect(hit.assumed).toBe(false);
  });

  it("UTF-16LE BOM 认得出（老编辑器另存常见）", () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...Buffer.from("测试", "utf16le")]);
    expect(detectSourceEncoding(bytes).encoding).toBe("utf-16le");
  });

  it("无 BOM 但字节是合法 UTF-8 ⇒ 判 utf-8 且不算猜", () => {
    const hit = detectSourceEncoding(utf8("夜色压下来。林渊拔剑而起。"));
    expect(hit.encoding).toBe("utf-8");
    expect(hit.assumed).toBe(false);
  });

  it("GB18030 中文稿：UTF-8 严格解码失败 ⇒ 兜底并如实标 assumed", () => {
    const hit = detectSourceEncoding(GBK_BYTES);
    expect(hit.encoding).toBe("gb18030");
    expect(hit.assumed).toBe(true);
    expect(hit.note).toContain("猜");
  });

  it("空字节串不猜编码，直接说不采信", () => {
    const hit = detectSourceEncoding(new Uint8Array(0));
    expect(hit.encoding).toBe("unknown");
    expect(hit.ok).toBe(false);
  });

  it("解码：GB18030 稿件能读回中文；BOM 不留在正文里", () => {
    expect(decodeImportedText(GBK_BYTES, detectSourceEncoding(GBK_BYTES))).toBe(GBK_TEXT);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("正文", "utf8")]);
    expect(decodeImportedText(withBom, detectSourceEncoding(withBom))).toBe("正文");
  });
});

describe("cleanImportedText：可核对的清洗报告", () => {
  it("行尾统一成 LF，并把 CR 计数写进报告", () => {
    const out = cleanImportedText("第一段\r\n第二段\r\n", { rules: [] });
    expect(out.text).toBe("第一段\n第二段\n");
    expect(out.report.lineEndingNormalized).toBe(2);
  });

  it("站点水印行按规则删除，并留样例", () => {
    const text = ["第一章 起", "本章未完，点击下一页继续阅读。", "夜色压下来。"].join("\n");
    const out = cleanImportedText(text, { rules: [{ id: "next-page", pattern: "本章未完，点击下一页" }] });
    expect(out.text).not.toContain("本章未完");
    expect(out.text).toContain("夜色压下来。");
    const hit = out.report.removed.find((item) => item.rule === "next-page");
    expect(hit?.count).toBe(1);
    expect(hit?.sample).toContain("本章未完");
  });

  it("规则里的非法正则被拒，不静默跳过（静默跳过=作者以为清洗过了）", () => {
    expect(() => cleanImportedText("x", { rules: [{ id: "bad", pattern: "(" }] })).toThrow(/规则「bad」的正则读不了/);
  });

  it("疑似密钥一律剔除并单独计数（红线 3：明文密钥不落盘）", () => {
    const text = ["正文。", "我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456", "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].join("\n");
    const out = cleanImportedText(text, { rules: [] });
    expect(out.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(out.text).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out.report.redacted.length).toBeGreaterThanOrEqual(2);
  });

  it("连续三个以上空行压成一个，正文段落不被动", () => {
    const out = cleanImportedText("甲\n\n\n\n\n乙\n\n丙\n", { rules: [] });
    expect(out.text).toContain("甲\n\n乙");
    expect(out.report.blankLinesCollapsed).toBeGreaterThanOrEqual(1);
  });

  it("空规则集时正文逐字不变（清洗不能是默认改稿）", () => {
    const text = "第一章 起\n夜色压下来。\n";
    const out = cleanImportedText(text, { rules: [] });
    expect(out.text).toBe(text);
    expect(out.report.removed).toEqual([]);
  });
});

describe("splitImportedChapters：认标题才切，认不出就不切", () => {
  it("按「第 N 章 / 回 / 节」标题切分，标题里的序号与标题都留下", () => {
    const text = ["楔子", "风起了。", "第一章 起", "夜色压下来。", "第二章 承", "剑出鞘。"].join("\n");
    const out = splitImportedChapters(text);
    expect(out.chapters.map((c) => c.title)).toEqual(["第一章 起", "第二章 承"]);
    expect(out.chapters[0]?.body).toContain("夜色压下来。");
    expect(out.chapters[1]?.body).toContain("剑出鞘。");
    // 第一章之前的内容不能丢：它是稿子的一部分，得单独交还给作者
    expect(out.preamble?.body).toContain("风起了。");
  });

  it("没有任何章节标题 ⇒ 不硬切，整篇作为单章并说明原因", () => {
    const out = splitImportedChapters("一整段没有标题的稿子。\n还是正文。");
    expect(out.hardSplit).toBe(false);
    expect(out.chapters).toHaveLength(1);
    expect(out.note).toContain("没找到章节标题");
  });

  it("标题行本身不进正文；同序号重复出现也各自成章（不合并）", () => {
    const out = splitImportedChapters("第一章 起\n甲\n第一章 起（修订）\n乙");
    expect(out.chapters).toHaveLength(2);
    expect(out.chapters[0]?.body.trim()).toBe("甲");
  });

  it("卷标题识别为卷提示，不当成章", () => {
    const out = splitImportedChapters("第一卷 风起\n第一章 起\n正文。");
    expect(out.volumeHints).toEqual(["第一卷 风起"]);
    expect(out.chapters).toHaveLength(1);
  });

  it("空文本 ⇒ 零章且不编造", () => {
    const out = splitImportedChapters("   \n  ");
    expect(out.chapters).toEqual([]);
    expect(out.preamble).toBeNull();
  });

  it("阿拉伯数字的章号也认（第1章 / 第10章）——导出稿里这种写法很常见", () => {
    // R108 撞出来的旧缺陷：章号的字符类里原本只有 ASCII 的 `0`（没有 1-9），
    // 于是「第1章」认不出来 ⇒ 整篇稿子被当成一章，而另外两处（章号解析、海选规则）都认 ⇒ 三处不一致
    const out = splitImportedChapters(["第1章 起", "夜色压下来。", "第10章 转", "停。"].join("\n"));
    expect(out.hardSplit).toBe(true);
    expect(out.chapters.map((c) => c.title)).toEqual(["第1章 起", "第10章 转"]);
  });
});

describe("确定性", () => {
  it("同一份字节两次探测与清洗结果逐字一致", () => {
    const bytes = utf8("第一章 起 / 水印行 / CRLF 的混合样本");
    const a = cleanImportedText(decodeImportedText(bytes, detectSourceEncoding(bytes)), { rules: [{ id: "n", pattern: "本章未完" }] });
    const b = cleanImportedText(decodeImportedText(bytes, detectSourceEncoding(bytes)), { rules: [{ id: "n", pattern: "本章未完" }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
