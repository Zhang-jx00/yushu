/**
 * 提及追踪（T3-5 别名/提及基础；T3-6 注入触发的输入）：
 * 在正文中追踪实体名与别名的出现（**不含 `@` 前缀**——与编辑器 `@` 提及是两套语义），
 * 用于「别名/提及关键词触发注入」（J05/A08）与事实级统计。
 * 规则：最长匹配优先（先长名后短名）、命中区间不重叠、结果按位置排序。
 */

export interface MentionTarget {
  id: string;
  name: string;
  aliases?: string[];
}

export interface MentionHit {
  entity_id: string;
  /** 命中的文本（名称或别名） */
  matched: string;
  start: number;
  /** 不含 */
  end: number;
}

export function trackMentions(text: string, targets: MentionTarget[]): MentionHit[] {
  if (text === "" || targets.length === 0) return [];
  const candidates: { entity: MentionTarget; name: string }[] = [];
  for (const target of targets) {
    for (const name of [target.name, ...(target.aliases ?? [])]) {
      const trimmed = name.trim();
      if (trimmed !== "") candidates.push({ entity: target, name: trimmed });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);

  const taken = new Array<boolean>(text.length).fill(false);
  const hits: MentionHit[] = [];
  for (const candidate of candidates) {
    let index = text.indexOf(candidate.name);
    while (index >= 0) {
      const end = index + candidate.name.length;
      let overlaps = false;
      for (let i = index; i < end; i += 1) {
        if (taken[i]) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        for (let i = index; i < end; i += 1) taken[i] = true;
        hits.push({ entity_id: candidate.entity.id, matched: candidate.name, start: index, end });
      }
      index = text.indexOf(candidate.name, index + 1);
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** 本章/本文提及的实体 id（按首次出现顺序去重）——注入触发的键集合 */
export function mentionedEntityIds(text: string, targets: MentionTarget[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hit of trackMentions(text, targets)) {
    if (seen.has(hit.entity_id)) continue;
    seen.add(hit.entity_id);
    result.push(hit.entity_id);
  }
  return result;
}