/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { buildTxt } from "../src/assemble.js";
import { buildMarkdown, yamlScalar } from "../src/markdown.js";
import type { ExportChapter } from "../src/types.js";

/**
 * Pandoc 源装配（M5 / T5-4 第二段，R89）：把已装配的章节写成一份 **pandoc 吃得下的 Markdown**。
 *
 * 这一层的价值全在"不做什么"：
 * ① **不重排正文**——真源本来就是 Markdown，导出层再加工一遍等于把作者的排版换掉；
 * ② **不手搓目录**——目录交给 pandoc 的 `--toc`，这里再写一份就会产出两份目录；
 * ③ **不读墙钟**——纯函数，日期由调用方给，同样输入必得同样输出（可复现快照的口径）。
 */

const chapter = (over: Partial<ExportChapter> = {}): ExportChapter => ({
  outlineRef: "co-1",
  chapterId: "ch-001",
  volumeId: "vol-a",
  volumeTitle: "第一卷 风起",
  act: "起",
  volumeIndex: 1,
  idx: 1,
  title: "边城少年",
  body: "夜色压下来。\n\n<!-- 内部备注：伏笔X -->\n他低声说。",
  statedWordCount: 12,
  ...over,
});

describe("YAML 标量转义（元数据块不许被书名撑坏）", () => {
  it("含冒号与井号的书名被引号包住，不会被 YAML 读成键或注释", () => {
    expect(yamlScalar("天启界：序章 #1")).toBe('"天启界：序章 #1"');
  });

  it("引号与反斜杠按 JSON 规则转义（JSON 双引号标量是合法 YAML）", () => {
    expect(yamlScalar('他说"好"')).toBe('"他说\\"好\\""');
    expect(yamlScalar("路径 C:\\temp")).toBe('"路径 C:\\\\temp"');
    expect(yamlScalar("多\n行")).toBe('"多\\n行"');
  });
});

describe("Pandoc 源装配（T5-4 第二段）", () => {
  it("元数据块在最前面，用 --- 包住并与正文之间空一行", () => {
    const text = buildMarkdown([chapter()], { bookTitle: "天启界" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe('title: "天启界"');
    expect(lines[2]).toBe("---");
    expect(lines[3]).toBe("");
    expect(lines[4]?.startsWith("# ")).toBe(true);
  });

  it("卷是一级标题、章是二级标题；正文原样透传（不重排版）", () => {
    const text = buildMarkdown([chapter()], { bookTitle: "天启界" });
    expect(text).toContain("# 第一卷 风起");
    expect(text).toContain("## 第1章 边城少年");
    // 段落之间的空行与原文一致，不折叠、不缩进、不加装饰线
    expect(text).toContain("夜色压下来。\n\n");
  });

  it("默认剥离内部标记；stripMarkers=false 时注释留在正文里", () => {
    const stripped = buildMarkdown([chapter()], { bookTitle: "天启界" });
    expect(stripped).not.toContain("内部备注");
    const kept = buildMarkdown([chapter()], { bookTitle: "天启界", stripMarkers: false });
    expect(kept).toContain("<!-- 内部备注：伏笔X -->");
  });

  it("顺序按大纲（卷序 → 卷内序号），不要求调用方先排好", () => {
    const text = buildMarkdown(
      [
        chapter({ outlineRef: "co-3", chapterId: "ch-011", idx: 11, title: "后事" }),
        chapter({
          outlineRef: "co-2",
          chapterId: "ch-002",
          volumeId: "vol-b",
          volumeTitle: "第二卷 云涌",
          volumeIndex: 2,
          idx: 1,
          title: "转折",
        }),
        chapter({ outlineRef: "co-1", chapterId: "ch-001", idx: 1, title: "开端" }),
      ],
      { bookTitle: "天启界" },
    );
    const order = text
      .split("\n")
      .filter((line) => /^#{1,2} /.test(line))
      .map((line) => line.replace(/^#+ /, ""));
    // R94 纠的就是这一行原本的期望：卷二又出现"第1章"是把**卷内序号**当成章号导出，
    // 两卷的书拿去投稿章节号直接对不上。现在章号跨卷连续（详见 sequence.test.ts）。
    expect(order).toEqual(["第一卷 风起", "第1章 开端", "第2章 后事", "第二卷 云涌", "第3章 转折"]);
  });

  it("同一卷内不重复输出卷标题", () => {
    const text = buildMarkdown(
      [chapter({ chapterId: "ch-001", idx: 1 }), chapter({ chapterId: "ch-002", idx: 2, title: "第二章" })],
      { bookTitle: "天启界" },
    );
    expect([...text.matchAll(/^# /gm)]).toHaveLength(1);
    expect([...text.matchAll(/^## /gm)]).toHaveLength(2);
  });

  it("不手搓目录：整份源里不出现目录文本，交给 pandoc 的 --toc", () => {
    const text = buildMarkdown([chapter(), chapter({ chapterId: "ch-002", idx: 2 })], { bookTitle: "天启界" });
    expect(text).not.toContain("目录");
    expect(text).not.toContain("═");
  });

  it("作者与日期只在传进来时出现（纯函数不读墙钟）", () => {
    const plain = buildMarkdown([chapter()], { bookTitle: "天启界" });
    expect(plain).not.toContain("author:");
    expect(plain).not.toContain("date:");
    const dated = buildMarkdown([chapter()], { bookTitle: "天启界", author: "张三", date: "2026-10-14" });
    expect(dated.split("\n")[1]).toBe('title: "天启界"');
    expect(dated).toContain('author: "张三"');
    expect(dated).toContain('date: "2026-10-14"');
  });

  it("空章节列表 ⇒ 只有元数据块，不抛错也不留悬空标题", () => {
    const text = buildMarkdown([], { bookTitle: "天启界" });
    expect(text).toBe('---\ntitle: "天启界"\n---\n');
  });

  it("同输入两次装配结果逐字一致（可复现快照口径）", () => {
    const chapters = [chapter(), chapter({ chapterId: "ch-002", idx: 2 })];
    expect(buildMarkdown(chapters, { bookTitle: "天启界" })).toBe(
      buildMarkdown(chapters, { bookTitle: "天启界" }),
    );
  });

  it("与 TXT 走同一把尺：章序一致、内部标记的剥离口径一致", () => {
    const chapters = [
      chapter({ outlineRef: "co-9", chapterId: "ch-011", idx: 11, title: "后事" }),
      chapter({
        outlineRef: "co-2",
        chapterId: "ch-002",
        volumeId: "vol-b",
        volumeTitle: "第二卷 云涌",
        volumeIndex: 2,
        idx: 1,
        title: "转折",
        body: "另起一炉。\n<!-- 内部备注：别外传 -->",
      }),
      chapter({ outlineRef: "co-1", chapterId: "ch-001", idx: 1, title: "开端" }),
    ];
    const txt = buildTxt(chapters, { bookTitle: "天启界", includeToc: true, stripMarkers: true, generatedAt: "2026-10-14T00:00:00.000Z" });
    const md = buildMarkdown(chapters, { bookTitle: "天启界" });
    const positions = (text: string) => ["开端", "后事", "转折"].map((title) => text.indexOf(title));
    const txtAt = positions(txt);
    const mdAt = positions(md);
    // 三份标题都得找得到（-1 说明某一侧把它丢了）
    expect(txtAt.every((at) => at >= 0)).toBe(true);
    expect(mdAt.every((at) => at >= 0)).toBe(true);
    // 同一把尺：两份产物里"开端 → 后事 → 转折"的位置都必须递增（输入是乱序的）
    expect([...txtAt].sort((a, b) => a - b)).toEqual(txtAt);
    expect([...mdAt].sort((a, b) => a - b)).toEqual(mdAt);
    // 剥离口径一致：TXT 里没有的注释，Markdown 里也不许有
    expect(txt).not.toContain("别外传");
    expect(md).not.toContain("别外传");
    expect(md).not.toContain("内部备注");
  });
});
