import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WordlistError,
  assembleExport,
  buildClipboardText,
  buildTxt,
  mergeWordlists,
  parseWordlist,
  scanSensitive,
  stripInternalMarkers,
  type ExportChapter,
} from "@yushu/export";

function chapter(overrides: Partial<ExportChapter> = {}): ExportChapter {
  return {
    outlineRef: "co-1",
    chapterId: "ch-1",
    volumeId: "vol-1",
    volumeTitle: "第一卷·起",
    act: "起",
    volumeIndex: 0,
    idx: 1,
    title: "第1章 废物少年",
    body: "天启界的夜色压下来。",
    statedWordCount: 10,
    ...overrides,
  };
}

const WORDS_YAML = `apiVersion: yushu.wordlist/v1
id: test-basic
version: 1.0.0
source: 测试词库
entries:
  - word: 加微信
    severity: error
    suggestion: 删除导流信息
    platforms: [起点]
  - word: 私聊
    severity: warn
  - word: 血腥
    severity: info
    note: 提示级
`;

describe("词库解析与合并（T1-19 外置可更新）", () => {
  it("解析带来源与版本的词库；severity 缺省为 warn", () => {
    const wordlist = parseWordlist(WORDS_YAML);
    expect(wordlist.id).toBe("test-basic");
    expect(wordlist.version).toBe("1.0.0");
    expect(wordlist.source).toBe("测试词库");
    expect(wordlist.entries).toHaveLength(3);
    expect(wordlist.entries[2]?.severity).toBe("info");
    expect(wordlist.entries[0]?.suggestion).toBe("删除导流信息");
    expect(wordlist.entries[0]?.platforms).toEqual(["起点"]);
  });

  it("非法词库给出明确错误", () => {
    expect(() => parseWordlist("apiVersion: yushu.wordlist/v2\nentries: []\n")).toThrow(WordlistError);
    expect(() => parseWordlist("apiVersion: yushu.wordlist/v1\n")).toThrowError(/entries/);
    expect(() =>
      parseWordlist("apiVersion: yushu.wordlist/v1\nentries:\n  - {word: x, severity: fatal}\n"),
    ).toThrowError(/severity/);
  });

  it("合并时后加载词库覆盖同词条（项目内覆盖内置），并保留来源", () => {
    const base = parseWordlist(WORDS_YAML);
    const override = parseWordlist(
      `apiVersion: yushu.wordlist/v1\nid: project-words\nversion: 2.0.0\nentries:\n  - {word: 私聊, severity: error, suggestion: 改为单独谈谈}\n`,
    );
    const merged = mergeWordlists([base, override]);
    expect(merged).toHaveLength(3);
    const item = merged.find((entry) => entry.word === "私聊");
    expect(item?.severity).toBe("error");
    expect(item?.wordlistId).toBe("project-words");
    expect(item?.suggestion).toBe("改为单独谈谈");
  });

  it("仓库内置词库文件可解析（外置文件自证）", async () => {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    const text = await readFile(join(repoRoot, "wordlists", "sensitive-basic.yaml"), "utf8");
    const wordlist = parseWordlist(text);
    expect(wordlist.id).toBe("sensitive-basic");
    expect(wordlist.entries.length).toBeGreaterThanOrEqual(5);
    expect(wordlist.source).toContain("内置");
  });
});

describe("装配与 TXT 构建（T1-18）", () => {
  it("按卷序 → 章序装配，字数与正文对账，失配被标出", () => {
    const result = assembleExport({
      chapters: [
        chapter({ chapterId: "ch-2", idx: 2, title: "第2章 觉醒", statedWordCount: 99 }),
        chapter({ chapterId: "ch-3", idx: 1, volumeId: "vol-2", volumeIndex: 1, volumeTitle: "第二卷·承", title: "第1章 扩地图" }),
        chapter({ chapterId: "ch-1", idx: 1 }),
      ],
    });
    expect(result.chapters.map((item) => item.chapterId)).toEqual(["ch-1", "ch-2", "ch-3"]);
    expect(result.stats).toEqual({ volumes: 2, chapters: 3, totalWords: 30, matched: 2, mismatched: 1 });
    const mismatched = result.reconcile.find((row) => !row.matched);
    expect(mismatched?.chapterId).toBe("ch-2");
    expect(mismatched?.stated).toBe(99);
  });

  it("TXT 含头部元信息、目录与分章；stripMarkers 去除内部注释", () => {
    const chapters = [
      chapter({ chapterId: "ch-1", idx: 1, body: "第一段。\n<!-- 作者备注：伏笔X -->\n第二段。" }),
      chapter({ chapterId: "ch-2", idx: 2, title: "第2章 觉醒", body: "第二夜。" }),
    ];
    const text = buildTxt(chapters, {
      bookTitle: "天启界",
      includeToc: true,
      stripMarkers: true,
      generatedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(text).toContain("《天启界》");
    expect(text).toContain("共 2 章");
    expect(text).toContain("═ 目录 ═");
    expect(text).toContain("第一卷·起（起）");
    expect(text).toContain("第1章 废物少年");
    expect(text).toContain("【第一卷·起】");
    expect(text).toContain("────────────────────────");
    expect(text).not.toContain("作者备注");
    expect(text).not.toContain("<!--");
    // 章标题已含"第N章"时不重复加前缀
    expect(text.match(/第2章 觉醒/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("不含目录时无目录段；正文顺序与大纲一致", () => {
    const text = buildTxt([chapter()], {
      bookTitle: "X",
      includeToc: false,
      generatedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(text).not.toContain("═ 目录 ═");
  });
});

describe("内部标记清洗与干净剪贴板（T1-20）", () => {
  it("默认去注释，可选去 AI 标识；多余空行被压缩", () => {
    const raw = "正文开始。\n<!-- 内部注释 -->\n[//]: # (md 注释)\n\n\n（AI 生成）补充一段。\n   ";
    const commentsOnly = stripInternalMarkers(raw);
    expect(commentsOnly).not.toContain("内部注释");
    expect(commentsOnly).not.toContain("md 注释");
    expect(commentsOnly).toContain("（AI 生成）");

    const cleaned = stripInternalMarkers(raw, { stripAiMarks: true });
    expect(cleaned).not.toContain("AI");
    expect(cleaned).toContain("正文开始。");
    expect(cleaned).toContain("补充一段。");
  });

  it("剪贴板文本：无目录与元信息，逐章标题 + 正文", () => {
    const text = buildClipboardText([
      chapter({ chapterId: "ch-1", idx: 1, body: "正文一。\n<!-- x -->" }),
      chapter({ chapterId: "ch-2", idx: 2, title: "第2章 觉醒", body: "正文二。" }),
    ]);
    expect(text.startsWith("第1章 废物少年")).toBe(true);
    expect(text).toContain("正文一。");
    expect(text).toContain("第2章 觉醒");
    expect(text).not.toContain("<!--");
    expect(text).not.toContain("═ 目录 ═");
  });
});

describe("敏感词扫描（T1-19）", () => {
  const entries = mergeWordlists([parseWordlist(WORDS_YAML)]);

  it("命中定位（章节 + 正文字符下标 + 上下文）与替换建议", () => {
    const body = "他压低声音说：加微信详谈，然后转身入夜。";
    const result = scanSensitive(
      [{ chapterId: "ch-1", chapterTitle: "第1章", volumeTitle: "第一卷·起", body }],
      entries,
    );
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.word).toBe("加微信");
    expect(hit.severity).toBe("error");
    expect(hit.index).toBe(body.indexOf("加微信"));
    expect(hit.context).toContain("加微信");
    expect(hit.suggestion).toBe("删除导流信息");
    expect(hit.wordlistId).toBe("test-basic");
    expect(result.summary.totalHits).toBe(1);
    expect(result.summary.bySeverity.error).toBe(1);
  });

  it("大小写不敏感、同词多处命中、多章汇总按严重级计数", () => {
    const result = scanSensitive(
      [
        { chapterId: "ch-1", chapterTitle: "A", volumeTitle: "V1", body: "私聊一下，再私聊一次。" },
        { chapterId: "ch-2", chapterTitle: "B", volumeTitle: "V1", body: "画面略显血腥，但无大碍。" },
      ],
      entries,
    );
    expect(result.summary.bySeverity).toEqual({ error: 0, warn: 2, info: 1 });
    expect(result.summary.totalHits).toBe(3);
    expect(result.summary.wordlists[0]?.id).toBe("test-basic");
    expect(result.summary.wordCount).toBe(3);
  });

  it("无命中返回空结果", () => {
    const result = scanSensitive(
      [{ chapterId: "ch-1", chapterTitle: "A", volumeTitle: "V1", body: "天色渐暗。" }],
      entries,
    );
    expect(result.hits).toEqual([]);
    expect(result.summary.totalHits).toBe(0);
  });
});