/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { chapterPath } from "@yushu/world-engine";
import { firstDraftPath } from "../renderer/src/first-draft.js";
import type { OutlineDocPayload } from "../src/shared/ipc.js";

/**
 * 只摆首章判定关心的字段（卷序 / 章序 / chapter_id）；brief 等与判定无关的字段不重复造，
 * 用一次断言式转换把「测试只关心这三样」写明白。
 */
function doc(volumes: Array<{ id: string; chapters: Array<{ id: string; chapterId?: string }> }>): OutlineDocPayload {
  return {
    apiVersion: "yushu/v1",
    format_version: 1,
    id: "outline-r191",
    master: { title: "测试书", logline: "", theme: "", notes: "", acts: [] },
    volumes: volumes.map((volume) => ({
      id: volume.id,
      title: volume.id,
      act: "第一幕",
      desc: "",
      chapters: volume.chapters.map((chapter, index) => ({
        id: chapter.id,
        idx: index + 1,
        title: chapter.id,
        scene_ids: [],
        ...(chapter.chapterId ? { chapter_id: chapter.chapterId } : {}),
      })),
    })),
  } as unknown as OutlineDocPayload;
}

describe("首章预热：章纲里第一个已回填 chapter_id 的章（R191）", () => {
  it("空章纲 / 没有回填 chapter_id 的章 → null（退回等 ai.drafts 清单兜底）", () => {
    expect(firstDraftPath(doc([]))).toBeNull();
    expect(firstDraftPath(doc([{ id: "vol-a", chapters: [{ id: "co-1" }, { id: "co-2" }] }]))).toBeNull();
  });

  it("跳过没建草稿的章，取第一个已回填的章", () => {
    const outline = doc([{ id: "vol-a", chapters: [{ id: "co-1" }, { id: "co-2", chapterId: "ch-2" }] }]);
    expect(firstDraftPath(outline)).toBe(chapterPath("vol-a", "ch-2"));
  });

  it("第一卷一章未建、第二卷首章已建 → 取第二卷首章（卷序优先）", () => {
    const outline = doc([
      { id: "vol-a", chapters: [{ id: "co-1" }] },
      { id: "vol-b", chapters: [{ id: "co-3", chapterId: "ch-3" }] },
    ]);
    expect(firstDraftPath(outline)).toBe(chapterPath("vol-b", "ch-3"));
  });

  it("多卷都已建 → 取章纲遍历顺序里的第一章（与 listDraftTargets 同序）", () => {
    const outline = doc([
      { id: "vol-a", chapters: [{ id: "co-1", chapterId: "ch-1" }] },
      { id: "vol-b", chapters: [{ id: "co-2", chapterId: "ch-2" }] },
    ]);
    expect(firstDraftPath(outline)).toBe(chapterPath("vol-a", "ch-1"));
  });
});
