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