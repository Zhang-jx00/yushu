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

/** 任务路由与可靠性配置（T3-2；缺省时用内置默认，见 @yushu/llm defaultRoutingConfig） */
export const ROUTING_CONFIG_PATH = `${CONFIG_DIR}/routing.yaml`;

/** 成本预算护栏配置（T3-12 / J09；可选文件，缺省 = 不设月度上限，见 @yushu/llm defaultBudgetConfig） */
export const BUDGET_CONFIG_PATH = `${CONFIG_DIR}/budget.yaml`;

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

/**
 * 五层记忆真源目录（T3-5；docs/03 §10.1）：
 * 摘要与事实均为项目内 Markdown（YAML frontmatter + 正文），SQLite 只做索引不做真源。
 * world_core 层复用既有设定卡（world/cards/），rag 层为检索派生（不落真源）。
 */
export const MEMORY_DIR = "memory";
export const MEMORY_VOLUME_SUMMARIES_DIR = `${MEMORY_DIR}/volumes`;
export const MEMORY_CHAPTER_SUMMARIES_DIR = `${MEMORY_DIR}/chapters`;
export const MEMORY_FACTS_DIR = `${MEMORY_DIR}/facts`;

/** 卷摘要路径：memory/volumes/<vol-*>.md */
export function volumeSummaryPath(id: string): string {
  return `${MEMORY_VOLUME_SUMMARIES_DIR}/${id}.md`;
}

/** 章摘要路径：memory/chapters/<ch-*>.md */
export function chapterSummaryPath(id: string): string {
  return `${MEMORY_CHAPTER_SUMMARIES_DIR}/${id}.md`;
}

/** 事实级记忆路径：memory/facts/<fact-*>.md */
export function factPath(id: string): string {
  return `${MEMORY_FACTS_DIR}/${id}.md`;
}

/** 项目配置（TOML，docs/01 技术基线；M1 阶段先保留路径常量） */
export const PROJECT_CONFIG_PATH = "project.toml";