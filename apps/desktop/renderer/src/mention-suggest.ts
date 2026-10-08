/**
 * 富文本形态 @ 提及候选（M2 / T2-2 富文本形态）：
 * - detectMentionQuery：从「光标前、所在段落内」的文本探测「@ + 查询词」触发态（纯函数，供 TipTap 与单测共用）；
 * - filterMentionCandidates：按名称/别名过滤设定卡（前缀优先 → 包含次之 → 同分短名在前），最多 limit 条。
 * 说明：候选纯逻辑与 UI 解耦——插入结果始终是 `@名称` 纯文本，与源码形态解析（entity-mentions.findMentions）同口径。
 */
import type { EntityIndexEntry } from "./entity-mentions";

export interface MentionQuery {
  /** 查询词（`@` 之后、光标之前的文本；可为空串 = 刚敲下 @） */
  query: string;
  /** `@` 在传入文本中的下标（调用方据此换算文档位置） */
  at: number;
}

/** 查询词长度上限：超过则视为普通输入（如邮箱 / 长串符号），关闭候选 */
export const MENTION_QUERY_MAX = 20;

/**
 * 探测 `@查询词` 触发态：从光标前一个字符向左扫描——
 * 遇到 `@` 即触发（其在文本中的下标即插入起点）；
 * 遇到空白 / 换行则中断（`@` 与光标之间断开的不是提及输入）。
 * 防误触：`@` 前一字符为 ASCII 字母 / 数字 / 下划线时不触发（邮箱、账号等场景）。
 */
export function detectMentionQuery(before: string): MentionQuery | null {
  let i = before.length - 1;
  let steps = 0;
  while (i >= 0) {
    const ch = before[i]!;
    if (ch === "@") {
      const prev = i > 0 ? before[i - 1]! : "";
      if (prev !== "" && /[A-Za-z0-9_]/.test(prev)) return null;
      return { query: before.slice(i + 1), at: i };
    }
    if (/\s/.test(ch)) return null;
    steps += 1;
    if (steps > MENTION_QUERY_MAX) return null;
    i -= 1;
  }
  return null;
}

/** 单个实体对查询词的匹配分：3 = 名称/别名前缀命中，2 = 名称/别名包含命中，0 = 不匹配；空查询视为全部命中（1） */
function scoreOf(entity: EntityIndexEntry, query: string): number {
  if (query === "") return 1;
  const q = query.toLowerCase();
  let best = 0;
  for (const raw of [entity.name, ...entity.aliases]) {
    const name = raw.trim();
    if (name === "") continue;
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) best = Math.max(best, 3);
    else if (lower.includes(q)) best = Math.max(best, 2);
  }
  return best;
}

/** 上一次 @ 菜单会话的高亮事实（调用方从组件状态投影） */
export interface MentionActivePrev {
  /** 该次 @ 的起点（文档位置）——用于判定是否同一次会话 */
  from: number;
  /** 上次的高亮下标 */
  active: number;
}

/**
 * 菜单高亮的继承规则（R40 修正预演 step21 抓到的缺陷）：
 * 只有「同一次 @ 会话内继续输入」（@ 起点不变）才保留上次高亮——边打字边过滤时不该跳回首项；
 * **新的 @ 会话或无前置状态一律从第 1 项开始**。原实现无条件继承 `prev.active`，
 * 于是上一回留下的第 N 项会变成新菜单的默认选中项，用户直接回车就插错卡。
 */
export function nextMentionActive(
  prev: MentionActivePrev | null,
  atDoc: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  if (prev === null || prev.from !== atDoc) return 0;
  return Math.min(Math.max(0, prev.active), itemCount - 1);
}

/** 过滤候选：分高者先（前缀 > 包含），同分短名先（更贴近"打一半就想要"的直觉），再按中文排序稳定输出 */
export function filterMentionCandidates(
  entities: EntityIndexEntry[],
  query: string,
  limit = 8,
): EntityIndexEntry[] {
  return entities
    .map((entity) => ({ entity, score: scoreOf(entity, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entity.name.length !== b.entity.name.length) {
        return a.entity.name.length - b.entity.name.length;
      }
      return a.entity.name.localeCompare(b.entity.name, "zh-Hans-CN");
    })
    .slice(0, limit)
    .map((item) => item.entity);
}