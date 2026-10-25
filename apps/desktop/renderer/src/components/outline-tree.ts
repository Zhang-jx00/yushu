/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 卷章树 + 选中那一章的产物摘要（R164）—— **大纲页与稿件总览页共用**。
 *
 * 为什么抽成共用模块：两页的卷章树必须**是同一份章清单、同一套算法**
 * （否则两页的树会慢慢长歪：作者在总览页看到的第 3 章与在大纲页看到的第 3 章不是同一章）。
 * ⇒ 两页都走这里的 `buildOutlineTree`，谁也不许自己再写一遍分组（docs/11 §7.43）。
 *
 * 纯函数：只读入参，不碰 fs、不碰 React、不读墙钟 ⇒ 可单测。
 */

/** 章清单里的一项（只取这一层要用的那几样 ⇒ 上游怎么改都不影响这两个函数） */
export interface OutlineTreeChapter {
  /** 章 id（大纲里的 co-*；与总览页那份清单同一个 id 空间） */
  id: string;
  /** 章名 */
  title: string;
  /** 所属卷 id */
  volumeId: string;
  /** 所属卷名 */
  volumeTitle: string;
  /** 卷内章序（1 起） */
  idx: number;
  /** 字数（未建草稿为 0） */
  wordCount: number;
  /** 章节状态（frontmatter status；未建草稿为空串） */
  status: string;
  /** 草稿文件相对路径（未建草稿为 null） */
  chapterPath: string | null;
}

export interface OutlineTreeVolume {
  volumeId: string;
  title: string;
  chapters: OutlineTreeChapter[];
}

/**
 * 从**同一份章清单**现算卷章树。
 *
 * 分组只认 `volumeId` **相邻** ⇒ 顺序与清单完全一致（不重排、不排序）：
 * 清单怎么排，树就怎么排（否则作者在两页看到的顺序会不一样）。
 */
export function buildOutlineTree(chapters: OutlineTreeChapter[]): OutlineTreeVolume[] {
  const groups: OutlineTreeVolume[] = [];
  for (const item of chapters) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.volumeId === item.volumeId) last.chapters.push(item);
    else groups.push({ volumeId: item.volumeId, title: item.volumeTitle, chapters: [item] });
  }
  return groups;
}

/** 章纲要素（大纲真源里那一章的 brief） */
export interface OutlineChapterBriefInput {
  who: string;
  where: string;
  goal: string;
  obstacle: string;
  turn: string;
  result: string;
  hook: string;
}

/** 选中那一章的产物摘要（右栏摆的东西） */
export interface OutlineChapterSummary {
  /** 选中的章 id（null = 还没选） */
  chapterId: string | null;
  /** 章名 */
  title: string;
  /** 章纲要素（逐项：标签 + 值；空值不列） */
  elements: { label: string; value: string }[];
  /** 状态（未建草稿 / 已建草稿 + frontmatter 状态） */
  status: string;
  /** 字数 */
  words: number;
  /** 草稿文件路径（未建草稿为空串） */
  path: string;
  /** 没选中 / 找不到时的如实说明（空串 = 有内容） */
  note: string;
}

/** 章纲要素的七个字段（谁 / 在哪 / 要什么 / 挡着什么 / 转折 / 结果 / 钩子） */
const BRIEF_FIELDS: { key: keyof OutlineChapterBriefInput; label: string }[] = [
  { key: "who", label: "谁" },
  { key: "where", label: "在哪" },
  { key: "goal", label: "要什么" },
  { key: "obstacle", label: "挡着什么" },
  { key: "turn", label: "转折" },
  { key: "result", label: "结果" },
  { key: "hook", label: "钩子" },
];

/**
 * 选中那一章的**产物摘要**（纯函数）。
 *
 * 两个来源，各管一段：
 * - **章纲要素**来自大纲真源（`brief` 等）—— 那是作者写的计划；
 * - **状态与字数**来自**与总览页同一份章清单**（草稿建没建、多少字）—— 那是盘上的结果。
 *
 * 为什么要分开：计划与结果是两件事，混在一起就成了"作者以为自己写了 3000 字"。
 */
export function summarizeOutlineChapter(input: {
  /** 选中的章 id */
  chapterId: string | null;
  /** 大纲真源里那一章 */
  outline: { id: string; title: string; brief: OutlineChapterBriefInput } | null;
  /** 与总览页同一份章清单里那一章 */
  entry: OutlineTreeChapter | null;
}): OutlineChapterSummary {
  const { chapterId, outline, entry } = input;
  if (chapterId === null) {
    return {
      chapterId: null,
      title: "",
      elements: [],
      status: "",
      words: 0,
      path: "",
      note: "还没选中一章（点左栏的卷章树选一选）",
    };
  }
  const elements: { label: string; value: string }[] = [];
  if (outline !== null) {
    for (const field of BRIEF_FIELDS) {
      const value = outline.brief[field.key].trim();
      if (value !== "") elements.push({ label: field.label, value });
    }
  }
  const hasDraft = entry !== null && entry.chapterPath !== null;
  return {
    chapterId,
    title: outline?.title ?? entry?.title ?? "",
    elements,
    status: hasDraft
      ? entry.status === ""
        ? "已建草稿"
        : `已建草稿（${entry.status}）`
      : "未建草稿",
    words: entry?.wordCount ?? 0,
    path: entry?.chapterPath ?? "",
    note:
      outline === null && entry === null
        ? "这一章在盘上找不到（可能刚被删了或改了 id）"
        : "",
  };
}
