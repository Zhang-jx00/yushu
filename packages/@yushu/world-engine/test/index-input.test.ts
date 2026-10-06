import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chunkText,
  collectIndexInput,
  createChapterDraft,
  createEmptyOutline,
  createSettingCard,
  diffIndexSources,
  serializeCardFile,
  serializeChapterFile,
  serializeOutline,
  type IndexSourceReader,
} from "@yushu/world-engine";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function readerOf(files: Record<string, string>): IndexSourceReader {
  return {
    listFiles: async () =>
      Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

describe("chunkText 切块（T1-21）", () => {
  it("短段落聚合到目标大小，区间可回溯原文", () => {
    const text = "第一段。\n第二段。\n第三段。";
    const chunks = chunkText(text, 8);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end).trim()).toBe(chunk.text);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toContain("第一段。");
  });

  it("超长单段被硬切且无内容丢失", () => {
    const text = "甲".repeat(1000);
    const chunks = chunkText(text, 400);
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.text).join("")).toHaveLength(1000);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[2]?.end).toBe(1000);
  });

  it("空文本与纯空白返回空数组", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(" \n\n ")).toEqual([]);
  });
});

describe("collectIndexInput（T1-21 生产侧）", () => {
  const card = createSettingCard({
    type: "character",
    name: "林渊",
    layer: "characters",
    aliases: ["小渊"],
    refs: [{ relation: "师从", target: "fac-qingyun" }],
  });
  const chapter = createChapterDraft({
    volume: "vol-1",
    idx: 1,
    title: "第1章 废物少年",
    outlineRef: "co-1",
  });
  const outline = createEmptyOutline("天启界");

  const files: Record<string, string> = {
    "world/cards/character/char-linyuan.md": serializeCardFile(card, "边城少年，剑道天赋被夺。"),
    [`chapters/vol-1/${chapter.id}.md`]: serializeChapterFile(chapter, "夜色压下来，林渊拔剑而起。"),
    "outline/outline.yaml": serializeOutline(outline),
    "world/world.yaml": "apiVersion: yushu.world/v1\nid: world-x\ntitle: 天启界\n",
    "project.toml": '[project]\nname = "天启界"\n',
    "notes/readme.txt": "随手笔记",
    "exports/book.txt": "导出产物不该被索引",
    "node_modules/pkg/index.js": "不该被索引",
    "world/cards/character/broken.md": "不是合法 frontmatter",
    // 冲突旁路文件（T2-6）：位于 chapters/ 下但不是真源章节，不应成为"幻觉章节"
    [`chapters/vol-1/${chapter.id}.md.conflict-20260929-184500123.md`]: serializeChapterFile(
      chapter,
      "冲突旁路内容，不该进入索引。",
    ),
  };

  it("分类收集：实体/引用/三类 chunk；排除导出与依赖目录；坏文件记 skipped", async () => {
    const input = await collectIndexInput(readerOf(files));

    const paths = input.files.map((file) => file.path);
    expect(paths).not.toContain("exports/book.txt");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).toContain("notes/readme.txt");
    expect(input.files.every((file) => file.hash.length === 64)).toBe(true);

    expect(input.entities).toHaveLength(1);
    expect(input.entities[0]).toMatchObject({ id: card.id, name: "林渊", layer: "characters" });
    expect(input.refs).toEqual([{ referrer: card.id, relation: "师从", target: "fac-qingyun" }]);

    const kinds = input.chunks.map((chunk) => chunk.kind);
    expect(new Set(kinds)).toEqual(new Set(["card", "chapter", "outline"]));

    const chapterChunk = input.chunks.find((chunk) => chunk.kind === "chapter")!;
    expect(chapterChunk.chapterId).toBe(chapter.id);
    expect(chapterChunk.volume).toBe("vol-1");
    expect(chapterChunk.path).toBe(`chapters/vol-1/${chapter.id}.md`);
    expect(chapterChunk.text).toContain("林渊拔剑而起");
    // 提及追踪：正文命中设定卡名
    expect(chapterChunk.entities).toContain("林渊");

    const cardChunk = input.chunks.find((chunk) => chunk.kind === "card")!;
    expect(cardChunk.path).toBe("world/cards/character/char-linyuan.md");

    const outlineChunk = input.chunks.find((chunk) => chunk.kind === "outline")!;
    expect(outlineChunk.text).toContain("天启界");

    expect(input.skipped.map((item) => item.path)).toContain("world/cards/character/broken.md");

    // 冲突旁路文件：既不入文件表，也不成 chunk，更不计入 skipped（统一排除口径）
    const sidecarInFiles = input.files.some((file) => file.path.includes(".conflict-"));
    expect(sidecarInFiles).toBe(false);
    expect(input.chunks.filter((chunk) => chunk.kind === "chapter")).toHaveLength(1);
    expect(input.skipped.some((item) => item.path.includes(".conflict-"))).toBe(false);
  });

  it("chunk id 稳定（同一输入重复收集结果一致，可幂等重建）", async () => {
    const first = await collectIndexInput(readerOf(files));
    const second = await collectIndexInput(readerOf(files));
    expect(second.chunks.map((chunk) => chunk.id)).toEqual(first.chunks.map((chunk) => chunk.id));
    expect(second.chunks.map((chunk) => chunk.textHash)).toEqual(
      first.chunks.map((chunk) => chunk.textHash),
    );
  });
});

describe("diffIndexSources 增量 diff（T2-5 / T2-11 切片 B 主与 worker 共用）", () => {
  const BUILT_AT = "2026-02-01T00:00:00.000Z";

  it("快速跳过 / hash 确认 touch / changed / removed 分类正确；快速跳过不读内容", async () => {
    const files = [
      { path: "a.md", size: 1, mtime: "2026-01-01T00:00:00.000Z" }, // mtime 早于 builtAt 且未变 → 快速跳过
      { path: "b.md", size: 5, mtime: BUILT_AT }, // racy（mtime 不早于 builtAt）→ hash 确认 → 变更
      { path: "c.md", size: 2 }, // 新增 → 变更
      { path: "e.md", size: 1, mtime: "2026-03-01T00:00:00.000Z" }, // mtime 变 → hash 相同 → touch
      { path: "g.md", size: 9 }, // 读取失败 → 保留旧记录（计入复用）
    ];
    const prev = [
      { path: "a.md", mtime: "2026-01-01T00:00:00.000Z", hash: sha("A"), bytes: 1 },
      { path: "b.md", mtime: BUILT_AT, hash: sha("B-old"), bytes: 5 },
      { path: "d.md", mtime: "2026-01-01T00:00:00.000Z", hash: sha("D"), bytes: 1 },
      { path: "e.md", mtime: "2026-01-01T00:00:00.000Z", hash: sha("E"), bytes: 1 },
      { path: "g.md", mtime: "2026-01-01T00:00:00.000Z", hash: sha("G"), bytes: 9 },
    ];
    const texts: Record<string, string> = { "b.md": "B-new", "c.md": "CC", "e.md": "E" };
    const reads: string[] = [];
    const diff = await diffIndexSources(files, prev, BUILT_AT, async (path) => {
      reads.push(path);
      const text = texts[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    });

    expect(diff.removedPaths).toEqual(["d.md"]);
    expect(diff.changed.map((file) => file.path)).toEqual(["b.md", "c.md"]);
    expect(diff.touchedFiles.map((file) => file.path)).toEqual(["e.md"]);
    expect(diff.touchedFiles[0]).toMatchObject({ hash: sha("E"), bytes: 1, mtime: "2026-03-01T00:00:00.000Z" });
    // 复用 = 快速跳过 a + touch e + 读取失败 g（不计入 changed）
    expect(diff.reusedFiles).toBe(3);
    expect(reads).not.toContain("a.md"); // racy 防护之外的未变文件不读内容
    expect(reads).toContain("g.md");
  });

  it("racy 防护：mtime 与 builtAt 同刻不快速跳过（同大小改写仍被 hash 确认）", async () => {
    const files = [{ path: "x.md", size: 3, mtime: BUILT_AT }];
    const prev = [{ path: "x.md", mtime: BUILT_AT, hash: sha("v1\n"), bytes: 3 }];
    const diff = await diffIndexSources(files, prev, BUILT_AT, async () => "v2\n");
    expect(diff.changed.map((file) => file.path)).toEqual(["x.md"]);
    expect(diff.reusedFiles).toBe(0);
  });
});