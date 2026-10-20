/* SPDX-License-Identifier: Apache-2.0 */
import {
  OUTLINE_PATH,
  WORLD_CONFIG_PATH,
  chapterPath,
  parseOutline,
  parseWorldConfig,
  readChapterFile,
  type Outline,
  type OutlineChapter,
  type OutlineVolume,
} from "@yushu/world-engine";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 共享的只读文档读取（记忆 / 抽取 / 一致性校验等主进程编排共用——口径单一来源）：
 * - 大纲 / 世界配置解析失败返回保守缺省（编排层给出可操作错误，不在此处抛）；
 * - 章节正文经 readChapterFile 解析（frontmatter + body），失败返回空串。
 */

const PROJECT_ID_FALLBACK = "";

export async function readOutlineSafe(gateway: ProjectGateway): Promise<Outline | null> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snapshot) return null;
  try {
    return parseOutline(snapshot.content);
  } catch {
    return null;
  }
}

/**
 * 章序（单一口径，R104 收拢）：大纲里**已回填 chapter_id** 的那些章，按卷序 + 卷内顺序摊平。
 * 可见性核对（R103）与注入门控核对（R104）都要问"这一章存在吗"，两处必须拿同一份答案——
 * 一边算上未建草稿的章纲、另一边不算，就会出现"同一条登记在这边悬空、在那边不悬空"。
 * 未回填的章纲不进这份名单：它没有可指的正文章 id，拿它当"存在的章"是反过来骗人。
 */
export async function outlineChapterOrder(gateway: ProjectGateway): Promise<string[]> {
  const outline = await readOutlineSafe(gateway);
  if (outline === null) return [];
  const ids: string[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      const id = chapter.chapter_id;
      if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export async function readProjectId(gateway: ProjectGateway): Promise<string> {
  const snapshot = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snapshot) return PROJECT_ID_FALLBACK;
  try {
    return parseWorldConfig(snapshot.content).id;
  } catch {
    return PROJECT_ID_FALLBACK;
  }
}

export async function readWorldTitle(gateway: ProjectGateway): Promise<string> {
  const snapshot = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snapshot) return "本作品";
  try {
    return parseWorldConfig(snapshot.content).title;
  } catch {
    return "本作品";
  }
}

export async function readChapterBody(gateway: ProjectGateway, path: string): Promise<string> {
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (!snapshot) return "";
  try {
    return readChapterFile(snapshot.content).body;
  } catch {
    return "";
  }
}

export function locateChapter(
  outline: Outline,
  chapterEntityId: string,
): { volume: OutlineVolume; chapter: OutlineChapter; path: string } | null {
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.chapter_id === chapterEntityId) {
        return { volume, chapter, path: chapterPath(volume.id, chapterEntityId) };
      }
    }
  }
  return null;
}