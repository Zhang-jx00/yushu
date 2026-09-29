import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  hasFrontmatter,
  parseFrontmatter,
  serializeCard,
  serializeFrontmatter,
} from "@yushu/core";

const CARD = {
  id: "char-linyuan",
  type: "character",
  layer: "characters",
  name: "林渊",
  aliases: ["渊哥", "林师兄"],
  refs: [{ relation: "师徒", target: "char-moxuan" }],
  source_chapters: ["ch-001"],
  visibility: "revealed",
  format_version: 1,
};

describe("frontmatter", () => {
  it("序列化-解析往返保持一致", () => {
    const body = "# 角色志\n\n少年身负残魂，剑指天门。\n";
    const text = serializeCard(CARD, body);
    const parsed = parseFrontmatter<typeof CARD>(text);
    expect(parsed.data).toEqual(CARD);
    expect(parsed.body).toBe(body);
    expect(hasFrontmatter(text)).toBe(true);
  });

  it("兼容 CRLF 输入", () => {
    const text = "---\r\nid: ch-001\r\ntitle: 夜探\r\n---\r\n正文\r\n";
    const parsed = parseFrontmatter<{ id: string; title: string }>(text);
    expect(parsed.data.id).toBe("ch-001");
    expect(parsed.data.title).toBe("夜探");
    expect(parsed.body).toBe("正文\r\n");
  });

  it("缺少 frontmatter 抛出 FrontmatterError", () => {
    expect(() => parseFrontmatter("# 没有 frontmatter")).toThrow(FrontmatterError);
  });

  it("frontmatter 非映射结构时抛错", () => {
    expect(() => parseFrontmatter("---\n- a\n- b\n---\n")).toThrow(FrontmatterError);
  });

  it("serializeCard 规范化正文空行与换行", () => {
    const text = serializeCard(CARD, "\n\n正文一行\r\n正文二行\n\n\n");
    expect(text.endsWith("正文二行\n")).toBe(true);
    expect(text).not.toContain("\r");
    const parsed = parseFrontmatter<typeof CARD>(text);
    expect(parsed.body).toBe("正文一行\n正文二行\n");
  });

  it("serializeFrontmatter 输出可被子解析器读取", () => {
    const fm = serializeFrontmatter({ a: 1, b: "中文值" });
    expect(fm.startsWith("---\n")).toBe(true);
    expect(fm.endsWith("---\n")).toBe(true);
  });
});