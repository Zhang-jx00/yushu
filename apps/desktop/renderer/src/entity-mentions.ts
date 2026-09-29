/**
 * 实体内联提及解析（M2 / T2-2）：
 * 正文中以 `@名称`（含别名）标记实体引用；本模块是纯函数实现，供编辑器装饰、提及面板与单测共用。
 * 规则：最长匹配优先（「林渊之」优先于「林渊」）、命中区间不重叠、同一实体在面板中去重。
 * 说明：正文提及按"名称/别名文本"识别（M3 的别名提及追踪会在此基础上补消歧与事实级记忆）。
 */

export interface EntityIndexEntry {
  id: string;
  name: string;
  aliases: string[];
  type: string;
  layer: string;
  filePath: string;
}

export interface MentionMatch {
  entity: EntityIndexEntry;
  /** 命中的名称（可能是别名） */
  matchedName: string;
  /** 起始下标（含 `@`） */
  start: number;
  /** 结束下标（不含） */
  end: number;
}

export function findMentions(text: string, entities: EntityIndexEntry[]): MentionMatch[] {
  if (text === "" || entities.length === 0) return [];

  // 展开候选并按名称长度降序（最长匹配优先）
  const candidates: { entity: EntityIndexEntry; name: string }[] = [];
  for (const entity of entities) {
    for (const name of [entity.name, ...entity.aliases]) {
      const trimmed = name.trim();
      if (trimmed !== "") candidates.push({ entity, name: trimmed });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);

  const taken = new Array<boolean>(text.length).fill(false);
  const matches: MentionMatch[] = [];

  for (const candidate of candidates) {
    const needle = `@${candidate.name}`;
    let index = text.indexOf(needle);
    while (index >= 0) {
      const end = index + needle.length;
      let overlaps = false;
      for (let i = index; i < end; i += 1) {
        if (taken[i]) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        for (let i = index; i < end; i += 1) taken[i] = true;
        matches.push({ entity: candidate.entity, matchedName: candidate.name, start: index, end });
      }
      index = text.indexOf(needle, index + 1);
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/** 本章提及的实体（按首次出现顺序去重）——用于"提及面板"与索引 entities 列 */
export function collectMentionedEntities(text: string, entities: EntityIndexEntry[]): EntityIndexEntry[] {
  const seen = new Set<string>();
  const result: EntityIndexEntry[] = [];
  for (const match of findMentions(text, entities)) {
    if (seen.has(match.entity.id)) continue;
    seen.add(match.entity.id);
    result.push(match.entity);
  }
  return result;
}