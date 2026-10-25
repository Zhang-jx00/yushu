/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  buildOutlineTree,
  summarizeOutlineChapter,
  type OutlineTreeChapter,
} from "../renderer/src/components/outline-tree.js";

/**
 * 卷章树 + 选中那一章的产物摘要的**纯函数**判据（R164）。
 *
 * 两页（大纲页 / 稿件总览页）的树必须是**同一份章清单 + 同一套算法** ⇒ 这一层是共用的纯函数：
 * ① **换个清单就换一棵树**（不许写死字面量）；
 * ② 分组只认 `volumeId` **相邻** ⇒ 顺序与清单完全一致（不重排、不排序）；
 * ③ 摘要里的**章纲要素 / 状态 / 字数**各归各的来源（计划 vs 盘上的结果）；
 * ④ **没选中就说没选中**（不许装成有）。
 */

function chapter(id: string, volumeId: string, overrides: Partial<OutlineTreeChapter> = {}): OutlineTreeChapter {
  return {
    id,
    title: "第 " + id + " 章",
    volumeId,
    volumeTitle: "卷 " + volumeId,
    idx: 1,
    wordCount: 0,
    status: "",
    chapterPath: null,
    ...overrides,
  };
}

describe("卷章树与选中那章的产物摘要（R164）：两页共用同一套算法", () => {
  it("按 `volumeId` **相邻**分组（顺序与清单完全一致）", () => {
    const tree = buildOutlineTree([
      chapter("co-1", "vol-a"),
      chapter("co-2", "vol-a"),
      chapter("co-3", "vol-b"),
    ]);
    expect(tree.length).toBe(2);
    expect(tree[0]?.volumeId).toBe("vol-a");
    expect(tree[0]?.chapters.map((item) => item.id)).toEqual(["co-1", "co-2"]);
    expect(tree[1]?.volumeId).toBe("vol-b");
    expect(tree[1]?.chapters.map((item) => item.id)).toEqual(["co-3"]);
  });

  it("**同一个卷不相邻时不并成一组**（不重排、不排序）", () => {
    const tree = buildOutlineTree([
      chapter("co-1", "vol-a"),
      chapter("co-2", "vol-b"),
      chapter("co-3", "vol-a"),
    ]);
    expect(tree.length).toBe(3);
    expect(tree.map((volume) => volume.volumeId)).toEqual(["vol-a", "vol-b", "vol-a"]);
  });

  it("**换个清单就换一棵树**（不许写死字面量）", () => {
    expect(buildOutlineTree([]).length).toBe(0);
    expect(buildOutlineTree([chapter("co-1", "vol-a")]).length).toBe(1);
  });

  it("摘要：章纲要素来自**大纲真源**、状态与字数来自**那份章清单**", () => {
    const summary = summarizeOutlineChapter({
      chapterId: "co-1",
      outline: {
        id: "co-1",
        title: "第一章 起",
        brief: {
          who: "林渊",
          where: "天启界",
          goal: "活下去",
          obstacle: "追兵",
          turn: "觉醒",
          result: "逃出城",
          hook: "灯亮了",
        },
      },
      entry: chapter("co-1", "vol-a", { wordCount: 933, status: "drafted", chapterPath: "chapters/a.md" }),
    });
    expect(summary.chapterId).toBe("co-1");
    expect(summary.title).toBe("第一章 起");
    expect(summary.words).toBe(933);
    expect(summary.status).toBe("已建草稿（drafted）");
    expect(summary.path).toBe("chapters/a.md");
    // 七个要素逐项列出来（谁 / 在哪 / 要什么 / 挡着什么 / 转折 / 结果 / 钩子）
    expect(summary.elements.map((item) => item.label)).toEqual([
      "谁",
      "在哪",
      "要什么",
      "挡着什么",
      "转折",
      "结果",
      "钩子",
    ]);
    expect(summary.note).toBe("");
  });

  it("摘要：空着的要素**不列**（不摆空行）", () => {
    const summary = summarizeOutlineChapter({
      chapterId: "co-1",
      outline: {
        id: "co-1",
        title: "第一章",
        brief: {
          who: "林渊",
          where: "",
          goal: "  ",
          obstacle: "追兵",
          turn: "",
          result: "",
          hook: "",
        },
      },
      entry: null,
    });
    expect(summary.elements.map((item) => item.label)).toEqual(["谁", "挡着什么"]);
    expect(summary.status).toBe("未建草稿");
    expect(summary.words).toBe(0);
  });

  it("**没选中就说没选中**（不许装成有）", () => {
    const summary = summarizeOutlineChapter({ chapterId: null, outline: null, entry: null });
    expect(summary.note).not.toBe("");
    expect(summary.chapterId).toBeNull();
    expect(summary.words).toBe(0);
    expect(summary.elements.length).toBe(0);
  });

  it("选中的章在盘上找不到 ⇒ **如实说找不到**（不装成有）", () => {
    const summary = summarizeOutlineChapter({ chapterId: "co-x", outline: null, entry: null });
    expect(summary.note).not.toBe("");
    expect(summary.words).toBe(0);
  });
});
