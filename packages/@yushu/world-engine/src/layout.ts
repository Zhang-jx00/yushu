/* SPDX-License-Identifier: Apache-2.0 */
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

/** 一致性豁免清单（M4 / T4-3，可选文件；**每条豁免必须写理由**，故属真源而非派生物） */
export const CONSISTENCY_ALLOW_PATH = `${CONFIG_DIR}/consistency.yaml`;

/**
 * 发布台账（M5 / T5-6，可选文件；**作者动作的留痕**，故属真源而非派生物）。
 *
 * 记的是"这一章什么时候从什么状态到了什么状态"——I01 §5 要求「回退记录留痕」：
 * 没有它，"发了又撤回"和"从没发过"在盘上长得一模一样，当日字数口径（番茄全勤）也算不出来。
 * 派生区放不了这个：删掉 `.yushu/` 它就没了，而它是**作者决定的记录**，不是机器算出来的结论。
 */
export const PUBLISH_LEDGER_PATH = `${CONFIG_DIR}/publish.yaml`;

/** 伏笔台账（M4 / T4-6，可选文件；登记→埋设→回收→未回收看板的唯一真源，docs/03 §5.3） */
export const FORESHADOW_PATH = `${WORLD_DIR}/foreshadow.yaml`;

/** 时间线（M4 / T4-7，可选文件；内部统一数字刻度 + 锚定事件 = Year 0，docs/03 §5.3） */
export const TIMELINE_PATH = `${WORLD_DIR}/timeline.yaml`;

/**
 * 爽点与期待感台账（M4 / T4-10，可选文件）。
 * 与 `foreshadow.yaml` 并列但**载体不同**（I03 §2.2）：伏笔靠道具/对白/意象埋设，
 * 这里的承诺多来自简介、核心梗与角色台词——所以两份账各记各的，靠 `foreshadow_id` 交叉引用，不双写。
 */
export const SATISFACTION_PATH = `${WORLD_DIR}/satisfaction.yaml`;

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