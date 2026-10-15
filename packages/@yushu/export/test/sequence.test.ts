/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  assembleExport,
  buildClipboardText,
  buildMarkdown,
  buildTxt,
  formatChapterHead,
  withSequence,
  type ExportChapter,
} from "@yushu/export";

/**
 * 全书连续序号与平台标题格式（M5 / T5-4 第四段·K11 第二段，R94）。
 *
 * 这一轮的存在理由：R93 交的 `platform-format.ts` 是**零消费者**的纯函数——
 * K11 要的"格式参数从包读取并用于导出"必须落到实际产物上才算数。
 * 而"落到产物上"的第一个问题就是 `{index}` 到底是哪个序号，
 * 顺着这个问题才查出：**跨卷导出时章号会在每一卷重新开始**
 * （卷一是 第1/2/3 章，卷二又回到 第1 章），作者拿去投稿会直接对不上平台的连续章节号。
 */

function chapter(overrides: Partial<ExportChapter> = {}): ExportChapter {
  return {
    outlineRef: "co-1",
    chapterId: "ch-1",
    volumeId: "vol-1",
    volumeTitle: "第一卷·起",
    act: "起",
    volumeIndex: 0,
    idx: 1,
    title: "废物少年",
    body: "天启界的夜色压下来。",
    statedWordCount: 11,
    ...overrides,
  };
}

/** 三章两卷：卷一两章、卷二一章（卷内 idx 各自从 1 开始，这是大纲的真实形状） */
function threeChapters(): ExportChapter[] {
  return [
    chapter({ chapterId: "ch-1", outlineRef: "co-1", idx: 1, title: "废物少年" }),
    chapter({ chapterId: "ch-2", outlineRef: "co-2", idx: 2, title: "觉醒" }),
    chapter({
      chapterId: "ch-3",
      outlineRef: "co-3",
      volumeId: "vol-2",
      volumeIndex: 1,
      volumeTitle: "第二卷·承",
      act: "承",
      idx: 1,
      title: "扩地图",
    }),
  ];
}

describe("全书连续序号（R94 查出的跨卷重号）", () => {
  it("withSequence 按大纲序给每章标全书序号，跨卷不重置", () => {
    const seq = withSequence(threeChapters()).map((item) => [item.chapterId, item.seq]);
    expect(seq).toEqual([
      ["ch-1", 1],
      ["ch-2", 2],
      ["ch-3", 3],
    ]);
  });

  it("assembleExport 交出的章节带 seq（调用方不必自己再数一遍）", () => {
    const result = assembleExport({ chapters: threeChapters() });
    expect(result.chapters.map((item) => item.seq)).toEqual([1, 2, 3]);
    // 原有职责不受影响：排序、统计照旧
    expect(result.stats.chapters).toBe(3);
    expect(result.stats.volumes).toBe(2);
  });

  it("TXT 章头用全书序号：卷二不会重新从第1章开始", () => {
    const text = buildTxt(threeChapters(), {
      bookTitle: "天启界",
      includeToc: true,
      stripMarkers: true,
      generatedAt: "2026-10-15T09:00:00.000Z",
    });
    expect(text).toContain("第3章 扩地图");
    expect(text).not.toContain("第1章 扩地图");
    expect(text).toContain("第1章 废物少年");
    expect(text).toContain("第2章 觉醒");
  });

  it("目录与正文用同一把尺（同一章在两处编号一致）", () => {
    const text = buildTxt(threeChapters(), {
      bookTitle: "天启界",
      includeToc: true,
      stripMarkers: true,
      generatedAt: "2026-10-15T09:00:00.000Z",
    });
    // 卷二那一章在目录和正文里各出现一次，两处都必须是"第3章"
    expect(text.match(/第3章 扩地图/g)?.length).toBe(2);
  });

  it("剪贴板文本同样按全书序号（三个出口不会分叉）", () => {
    const text = buildClipboardText(threeChapters(), {});
    expect(text).toContain("第3章 扩地图");
    expect(text).not.toContain("第1章 扩地图");
  });

  it("调用方注入了完整 seq 时照它编号（未创建草稿的章不能把后面章号往前拽）", () => {
    // 真实场景：大纲卷一有 11 章，只有第 1 章和第 11 章写了正文。
    // 按"导出流里的位置"数会得到 1/2，可作者要的是他在大纲里的第 11 章。
    // 主进程按大纲算好 seq 注入，引擎就不再自己数。
    const given = [
      chapter({ chapterId: "ch-1", idx: 1, seq: 1 }),
      chapter({ chapterId: "ch-11", idx: 11, seq: 11 }),
    ];
    expect(withSequence(given).map((item) => item.seq)).toEqual([1, 11]);
    const text = buildTxt(given, {
      bookTitle: "天启界",
      includeToc: false,
      generatedAt: "2026-10-15T09:00:00.000Z",
    });
    expect(text).toContain("第11章 废物少年");
    expect(text).not.toContain("第2章 废物少年");
  });

  it("注入不完整（有的章没 seq）时整体按位置补，不会出现两个相同章号", () => {
    const partial = [
      chapter({ chapterId: "ch-1", idx: 1, seq: 7 }),
      chapter({ chapterId: "ch-2", idx: 2 }),
    ];
    const seq = withSequence(partial).map((item) => item.seq);
    expect(seq).toEqual([1, 2]);
    expect(new Set(seq).size).toBe(2);
  });

  it("作者标题自带「第N章」时导出层不悄悄删字，仍照原文（前缀交给 warn 提示）", () => {
    const prefixed = chapter({ chapterId: "ch-9", volumeId: "vol-2", volumeIndex: 1, idx: 1, title: "第1章 扩地图" });
    expect(formatChapterHead(prefixed, undefined)).toBe("第1章 扩地图");
    // 但 seq 是知道的：要改写就得由显式模板下指令
    const [sequenced] = withSequence([prefixed]);
    expect(sequenced?.seq).toBe(1);
  });

  it("模板自带「第N章」前缀而标题也有 ⇒ 导出副本让模板赢，不出现重复前缀", () => {
    // 生成的章纲标题就是"第1章（待拟题）"这个形状。若照字面套模板，
    // 产物会得到"第1章 第1章（待拟题）"——这是能直接投稿的稿子里不该出现的东西。
    const prefixedChapters = [
      chapter({ chapterId: "ch-1", idx: 1, seq: 1, title: "第1章（待拟题）" }),
      chapter({ chapterId: "ch-2", idx: 2, seq: 2, title: "第2章（待拟题）" }),
    ];
    const text = buildTxt(prefixedChapters, {
      bookTitle: "天启界",
      includeToc: false,
      generatedAt: "2026-10-15T09:00:00.000Z",
      titleFormat: "第{index}章 {title}",
    });
    expect(text).toContain("第2章 （待拟题）");
    expect(text).not.toContain("第2章 第2章");
    // 真源不动：这里改的只是导出副本
    expect(prefixedChapters[1]?.title).toBe("第2章（待拟题）");
  });

  it("模板不带章节前缀时不剥作者标题里的前缀（只剥该剥的那种）", () => {
    const head = formatChapterHead(
      { ...chapter(), seq: 4, title: "第4章 血战" },
      "《{title}》",
    );
    expect(head).toBe("《第4章 血战》");
  });

  it("标题只有一个前缀时不留尾随空格", () => {
    const head = formatChapterHead({ ...chapter(), seq: 6, title: "第六章" }, "第{index}章 {title}");
    expect(head).toBe("第6章");
  });
});

describe("平台标题模板落到实际产物（K11 的落点）", () => {
  it("buildTxt 传 titleFormat 时章头按模板渲染，而不是按内置的「第N章 标题」", () => {
    const text = buildTxt(threeChapters(), {
      bookTitle: "天启界",
      includeToc: true,
      stripMarkers: true,
      generatedAt: "2026-10-15T09:00:00.000Z",
      titleFormat: "{index}. {title}",
    });
    expect(text).toContain("3. 扩地图");
    expect(text).not.toContain("第3章 扩地图");
  });

  it("buildMarkdown 传 titleFormat 时 ## 行按模板渲染（pandoc 靠它切章与建目录）", () => {
    const md = buildMarkdown(threeChapters(), {
      bookTitle: "天启界",
      titleFormat: "第{index}章 {title}",
    });
    expect(md).toContain("## 第3章 扩地图");
    expect(md).toContain("# 第二卷·承");
  });

  it("模板占位符写错 ⇒ 在生成任何文本之前就抛，不会把 {num} 吐进作者书稿", () => {
    const options = {
      bookTitle: "天启界",
      includeToc: false,
      generatedAt: "2026-10-15T09:00:00.000Z",
      titleFormat: "第{num}章 {title}",
    };
    expect(() => buildTxt(threeChapters(), options)).toThrow(/只支持 \{index\} 与 \{title\}/);
    expect(() =>
      buildMarkdown(threeChapters(), { bookTitle: "天启界", titleFormat: "第{num}章 {title}" }),
    ).toThrow(/只支持/);
  });

  it("不传 titleFormat 时与旧行为逐字一致（单卷书不受本轮影响）", () => {
    const single = [chapter({ chapterId: "ch-1", idx: 1, title: "第1章 废物少年" })];
    const text = buildTxt(single, {
      bookTitle: "天启界",
      includeToc: true,
      stripMarkers: true,
      generatedAt: "2026-10-15T09:00:00.000Z",
    });
    expect(text).toContain("第1章 废物少年");
    expect(text).not.toContain("{index}");
    expect(text).not.toContain("{title}");
  });
});
