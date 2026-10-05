import { countWords } from "@yushu/core";
import { OUTLINE_PATH, chapterPath, parseOutline, readChapterFile } from "@yushu/world-engine";
import type { LibraryViewPayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { getWorldSummary } from "./project-ops.js";

/**
 * 稿件总览（M2 / T2-4 切片 A「全库视图」）：
 * 汇总大纲全部章节（含未建草稿）的一行式条目——卷 / 章序 / 标题 / 草稿路径 / 字数 / 状态，
 * 供渲染层以虚拟滚动列表展示（335+ 章级项目只渲染视窗窗口）。
 * 只读：真源始终是 outline.yaml 与 chapters/ 章节文件（本模块不写任何内容）。
 */
export async function readLibrary(gateway: ProjectGateway): Promise<LibraryViewPayload> {
  const world = await getWorldSummary(gateway).catch(() => null);
  const bookTitle = world?.title ?? "";
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snapshot) {
    return { bookTitle, chapters: [], totals: { chapters: 0, drafted: 0, words: 0 } };
  }
  const outline = parseOutline(snapshot.content);

  const chapters: LibraryViewPayload["chapters"] = [];
  let drafted = 0;
  let words = 0;
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      let path: string | null = null;
      let wordCount = 0;
      let status = "";
      if (chapter.chapter_id) {
        const candidate = chapterPath(volume.id, chapter.chapter_id);
        const file = await gateway.readDoc(candidate).catch(() => null);
        if (file) {
          path = candidate;
          drafted += 1;
          try {
            const { chapter: entity, body } = readChapterFile(file.content);
            wordCount = entity.word_count > 0 ? entity.word_count : countWords(body);
            status = entity.status;
          } catch {
            // 章节文件损坏：保留路径与 0 字数（不阻断总览；编辑器打开时会给出解析错误）
          }
        }
      }
      words += wordCount;
      chapters.push({
        volumeId: volume.id,
        volumeTitle: volume.title,
        chapterId: chapter.id,
        idx: chapter.idx,
        title: chapter.title,
        chapterPath: path,
        wordCount,
        status,
      });
    }
  }

  return {
    bookTitle,
    chapters,
    totals: { chapters: chapters.length, drafted, words },
  };
}