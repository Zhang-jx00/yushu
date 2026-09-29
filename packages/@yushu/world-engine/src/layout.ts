/**
 * 项目文件布局（K03 真源布局约定）。
 * 一切路径均为项目根目录下的相对路径（POSIX 分隔符）。
 */

/** 引擎私有目录（SQLite 索引等派生数据；禁入 Git 与同步盘） */
export const INDEX_DIR = ".yushu";

export const WORLD_DIR = "world";
export const WORLD_CONFIG_PATH = "world/world.yaml";
export const CARDS_DIR = "world/cards";
export const OUTLINE_DIR = "outline";
export const CHAPTERS_DIR = "chapters";
export const CONFIG_DIR = "config";
export const ASSETS_DIR = "assets";
export const PACKS_DIR = "packs";
export const SCHEMAS_DIR = "schemas";

/** LLM Provider 配置（apiKey 禁止落盘明文，只记环境变量名；docs/03 §13） */
export const LLM_CONFIG_PATH = `${CONFIG_DIR}/llm.yaml`;

/** 设定卡路径：world/cards/<type>/<id>.md */
export function cardPath(type: string, id: string): string {
  return `${CARDS_DIR}/${type}/${id}.md`;
}

/** 章节路径：chapters/<volume>/<id>.md */
export function chapterPath(volume: string, id: string): string {
  return `${CHAPTERS_DIR}/${volume}/${id}.md`;
}

/** 大纲路径（三级大纲唯一事实源） */
export const OUTLINE_PATH = `${OUTLINE_DIR}/outline.yaml`;

/** 项目配置（TOML，docs/01 技术基线；M1 阶段先保留路径常量） */
export const PROJECT_CONFIG_PATH = "project.toml";