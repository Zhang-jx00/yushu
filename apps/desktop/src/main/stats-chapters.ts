/* SPDX-License-Identifier: Apache-2.0 */
import type { LibraryChapterEntry, StatsChapterDistPayload } from "../shared/ipc.js";

/**
 * 逐章字数分布（R167，T5-6 剩余片）：**结构由后端给**（R158 立的口径）——
 * 界面只渲染，不自己挑数、不自己算平均、不自己排顺序。
 *
 * 口径三条：
 * ① **按书序**（清单给的顺序：卷序 → 章序），**不按字数排序** —— 作者要看的是
 *    "第几章到第几章塌了"，按字数一排序，长尾的形状就撒谎了；
 * ② **平均只数有稿的章** —— 未建草稿的章没有字数，混进分母会把"平均"摊薄成假象；
 * ③ **空项目不画假图** —— 一个章都没有时 `chapters` 为空数组、`avgWords` 为 null
 *    （不是 0），界面按 null 渲染空态；未建草稿的章 `words` 为 null，**不冒充 0**。
 */
export function buildChapterDist(entries: LibraryChapterEntry[]): StatsChapterDistPayload {
  const chapters = entries.map((entry) => ({
    /** 唯一对账锚点（同名卷 / 同卷同序号都不会撞——React 的 key 与预演的行匹配都认它） */
    chapterId: entry.chapterId,
    volumeTitle: entry.volumeTitle,
    idx: entry.idx,
    title: entry.title,
    /** 已建草稿为字数；未建草稿为 null（不冒充 0） */
    words: entry.chapterPath === null ? null : entry.wordCount,
  }));
  const drafted = chapters.filter((row) => row.words !== null);
  const totalWords = drafted.reduce((sum, row) => sum + (row.words ?? 0), 0);
  const avgWords = drafted.length > 0 ? Math.round(totalWords / drafted.length) : null;
  const shortest = drafted.reduce<(typeof chapters)[number] | null>(
    (best, row) => (best === null || (row.words ?? 0) < (best.words ?? 0) ? row : best),
    null,
  );
  return {
    totalChapters: chapters.length,
    withDraft: drafted.length,
    noDraft: chapters.length - drafted.length,
    avgWords,
    shortest: shortest === null ? null : { ...shortest },
    chapters,
  };
}
