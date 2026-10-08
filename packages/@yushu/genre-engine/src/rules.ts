import { readFileSync } from "node:fs";
import { collectExpressionIssues, parseRuleDocument, type ConsistencyRule } from "./rule-dsl.js";
import type { LoadedPack } from "./types.js";

/**
 * 派系包 `rules` 件套的**内容层**加载（M4 / T4-1 桌面接入，R51）。
 *
 * 与 `loadPackTaboos` 的关键差别：taboos 解析失败会静默跳过（约束槽位降级即可），
 * 而规则件**必须把失败原样带出去**——一条加载失败的规则如果悄悄消失，作者看到的是
 * "这条问题没被发现"，而不是"这条规则根本没跑"。沉默的校验器比没有校验器更坏。
 */

export interface PackRuleSet {
  /** 包内相对路径（如 `rules/power-consistency.yaml`），供面板与 lint 指认文件 */
  file: string;
  /** 所属包 id */
  packId: string;
  /** 解析成功时的规则列表；失败时为空数组 */
  rules: ConsistencyRule[];
  /** 解析失败原因（非空即"这个文件一条规则都没跑成"） */
  error: string | null;
  /** 可解析、但表达式结构有问题（未知操作符 / 一个对象多键 / 超深）：ruleId → 问题 */
  expressionIssues: Record<string, string[]>;
}

/** 包目录相对化：绝对路径在面板上没有指认价值，也便于跨机器比较 */
function toRelative(pack: LoadedPack, absolute: string): string {
  const prefix = pack.dir.replace(/[\\/]+$/, "");
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length).replace(/^[\\/]+/, "").replace(/\\/g, "/") : absolute;
}

/**
 * 加载一个包的全部规则件。
 * 文件读不出来（包声明了但磁盘没有）也算 error——`loadPack` 已把缺件记进 `missingFiles`，
 * 这里再给一次明确原因，避免"面板显示 0 条规则"被读成"这个包没有规则"。
 */
export function loadPackRuleSets(pack: LoadedPack): PackRuleSet[] {
  const packId = pack.manifest.metadata.id;
  const sets: PackRuleSet[] = [];
  for (const absolute of pack.resolvedFiles["rules"] ?? []) {
    const file = toRelative(pack, absolute);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch (err) {
      sets.push({
        file,
        packId,
        rules: [],
        error: `规则文件读不出来：${err instanceof Error ? err.message : String(err)}`,
        expressionIssues: {},
      });
      continue;
    }
    try {
      const rules = parseRuleDocument(text);
      const expressionIssues: Record<string, string[]> = {};
      for (const rule of rules) {
        const issues = collectExpressionIssues(rule.when);
        if (issues.length > 0) expressionIssues[rule.id] = issues;
      }
      sets.push({ file, packId, rules, error: null, expressionIssues });
    } catch (err) {
      sets.push({
        file,
        packId,
        rules: [],
        error: err instanceof Error ? err.message : String(err),
        expressionIssues: {},
      });
    }
  }
  return sets;
}

/** 加载多个包的规则件（顺序稳定：按传入包顺序，包内按声明顺序） */
export function loadRuleSets(packs: LoadedPack[]): PackRuleSet[] {
  return packs.flatMap((pack) => loadPackRuleSets(pack));
}

/** 把各件的规则摊平成一个列表（含出处信息，面板与体检都按这个视图工作） */
export function flattenRules(sets: PackRuleSet[]): ConsistencyRule[] {
  return sets.flatMap((set) => set.rules);
}

/**
 * 跨件重复的规则 id（同包内不同文件撞名）。
 * G06 的「同 id 高版本胜出」是**跨包版本合并**的事，不在本轮实现；
 * 同一个包内部撞 id 没有版本可依据，只能当错误报出来——静默按加载顺序取后者是最坏的。
 */
export function duplicateRuleIds(sets: PackRuleSet[]): Array<{ id: string; files: string[] }> {
  const byId = new Map<string, string[]>();
  for (const set of sets) {
    for (const rule of set.rules) {
      const files = byId.get(rule.id) ?? [];
      if (!files.includes(set.file)) files.push(set.file);
      byId.set(rule.id, files);
    }
  }
  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files: files.sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
