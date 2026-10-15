/* SPDX-License-Identifier: Apache-2.0 */
import {
  collectVarReferences,
  evaluateRule,
  loadRuleSets,
  mergeRuleSets,
  readPath,
  type PackRuleSet,
  type RuleAmbiguity,
  type RuleOutOfDate,
  type RuleOverride,
  type RuleSetGroup,
} from "@yushu/genre-engine";
import {
  checkPowerGate,
  collectIndexInput,
  parsePowerLog,
  pairPowerLog,
  powerPairData,
  POWER_GATE_ORIGIN,
  type IndexEntityRow,
} from "@yushu/world-engine";
import type { ProjectGateway } from "./file-gateway.js";
import { gatewayReader } from "./index-ops.js";
import { loadPacksByIds } from "./project-ops.js";

/**
 * 派系包规则拿项目数据求值（M4 / T4-2 第一条语义规则，R57）。
 *
 * **分工裁决（写在 docs/04 §7.3，这里只复述结论）**：战力"崩没崩"的判定只有一套，
 * 就是包内 DSL 规则 `power-no-regress`；御书不再另写一份等价判定——两套判定各报各的，
 * 作者最终学会的是忽略红色。本模块因此只做**数据装配**：读设定卡的
 * `extensions.power_log`，拼成规则要的相邻对 `{a, b}`，交给 `evaluateRule`。
 *
 * 两条硬口径：
 * ① **没有数据绑定的规则逐条列进 `notEvaluated`**（R51 的教训：一条悄悄没跑的规则，
 *    作者看到的是"没发现问题"）；
 * ② 台账本身读不出（章号认不出、类型不对）时记进 `errors` 并点名是哪张卡，
 *    **不给"零结论 = 没问题"**。
 */

export interface PackRuleFinding {
  rule: string;
  severity: "error" | "warn" | "info";
  /** 主体：这张设定卡的 id（报告按它找原文区间） */
  subject: string;
  /** 战力类结论指向"后一章"那条台账，区间就落在那一行 */
  related?: string;
  message: string;
  evidence: string;
  fix: string;
  /** 出处：哪个包的哪一件规则文件（内置结构规则没有这一项） */
  origin: string;
}

export interface PackRuleRunResult {
  findings: PackRuleFinding[];
  /** 本轮真的跑了的规则 id */
  evaluated: string[];
  /** 包里有、但这轮没有数据可比的规则（必须外显） */
  notEvaluated: Array<{ id: string; reason: string }>;
  /** 数据装配失败（卡与原因逐条点名） */
  errors: string[];
  /**
   * 跨包同 id 的合并情况（T4-12 / R85）。
   *
   * `overrides` 与 `ambiguous` 都必须外显：docs/03 §8.3 的底线是"一切冲突显式提示，
   * 禁止静默覆盖"。`dateCheck` 说明生效期到底判没判——没判不能看起来像"都在有效期内"。
   */
  merge: {
    overrides: RuleOverride[];
    ambiguous: RuleAmbiguity[];
    dateCheck: "applied" | "skipped";
  };
}

/**
 * 数据绑定：**不再有"哪条规则参与求值"的手写名单**（R74）。每条规则表达式里的 `var` 路径
 * 就是它自己声明的数据需求，桌面端拿拼好的求值数据逐个比对：全都取得到才求值，
 * 否则进 `notEvaluated` 并点名缺哪些路径。新增包规则因此不需要改这里的代码——
 * 它要么真的能拿到数据并参与，要么被具体原因点名，**不会静默通过，也不会被名单漏掉**。
 */

/** 规则文件出处的统一写法（面板与 errors 都用它，别在两处各拼一遍字符串） */
export function packOriginLabel(packId: string, file: string): string {
  return `派系包 ${packId}（${file}）`;
}

function originOf(set: PackRuleSet): string {
  return packOriginLabel(set.packId, set.file);
}

/** 合并后的可求值视图：规则 + 它真正的出处 */
export interface RuleMergeView {
  runnable: Array<{ rule: PackRuleSet["rules"][number]; origin: string }>;
  /** 整件读不了的文件（原样列出，不进合并） */
  failed: Array<{ packId: string; file: string; error: string }>;
  /**
   * 给面板与 `errors` 用的成品文案。
   *
   * 拼装留在这里而不是调用方：调用方只剩"并进 errors"一步，
   * 于是"到底有没有外显"这件事由本函数持有的断言管得到
   * （R82 第 7 条：变异点名的文件必须自己持有那条断言）。
   */
  errorLines: string[];
  overrides: RuleOverride[];
  ambiguous: RuleAmbiguity[];
  outOfDate: RuleOutOfDate[];
  dateCheck: "applied" | "skipped";
}

/**
 * 把多个规则文件合并成"本轮真正参与求值的那些规则"（T4-12 / R85）。
 *
 * 引擎侧 `mergeRuleSets` 管"谁胜出"，这里管**出处跟着走**：结论行要写
 * "派系包 X（rules/y.yaml）"，合并时若把胜出者的 packId/file 丢了，
 * 面板就会指着错误的包说"这条是你该改的"——算法对了、指认错了，一样是坏证据。
 *
 * 解析失败的文件**不进合并**（它们一条规则都没有），但必须原样出现在 `failed` 里：
 * 悄悄丢掉等于"这个包没有规则"，而真相是"这个文件读不了"。
 */
export function applyRuleMerge(
  sets: readonly PackRuleSet[],
  options: { asOf?: string } = {},
): RuleMergeView {
  const failed = sets
    .filter((set) => set.error !== null)
    .map((set) => ({ packId: set.packId, file: set.file, error: set.error as string }));
  const groups: RuleSetGroup[] = sets
    .filter((set) => set.error === null)
    .map((set) => ({ packId: set.packId, file: set.file, rules: set.rules }));
  const merged = mergeRuleSets(groups, options);
  const originByKey = new Map(sets.map((set) => [`${set.packId}::${set.file}`, originOf(set)]));
  // 按"胜出者所在的那一件文件"取规则本体——用全局 id→rule 表会取到**第一个**同 id 规则，
  // 于是出处写着新包、求值的却是旧包那条：正是本轮这条函数要防的事（测试当场抓到过一次）
  const rulesByKey = new Map(groups.map((group) => [`${group.packId}::${group.file}`, group.rules]));
  const runnable = merged.winners
    .filter((winner) => !merged.outOfDate.some((item) => item.id === winner.id))
    .map((winner) => {
      const key = `${winner.packId}::${winner.file}`;
      const rule = (rulesByKey.get(key) ?? []).find((candidate) => candidate.id === winner.id);
      return {
        rule: rule as PackRuleSet["rules"][number],
        origin: originByKey.get(key) ?? `派系包 ${winner.packId}（${winner.file}）`,
      };
    })
    .filter((item) => item.rule !== undefined);
  return {
    runnable,
    failed,
    errorLines: failed.map((item) => `${packOriginLabel(item.packId, item.file)}：${item.error}`),
    overrides: merged.overrides,
    ambiguous: merged.ambiguous,
    outOfDate: merged.outOfDate,
    dateCheck: merged.dateCheck,
  };
}

async function cardEntities(gateway: ProjectGateway, entities?: IndexEntityRow[]): Promise<IndexEntityRow[]> {
  if (entities) return entities;
  return (await collectIndexInput(gatewayReader(gateway))).entities;
}

export async function evaluatePackRules(
  gateway: ProjectGateway,
  options: { packIds: string[]; entities?: IndexEntityRow[]; entityIds?: string[]; asOf?: string },
): Promise<PackRuleRunResult> {
  const findings: PackRuleFinding[] = [];
  const evaluated: string[] = [];
  const notEvaluated: Array<{ id: string; reason: string }> = [];
  const errors: string[] = [];

  const sets = loadRuleSets(await loadPacksByIds(options.packIds));
  const entities = await cardEntities(gateway, options.entities);
  const scope = options.entityIds && options.entityIds.length > 0 ? new Set(options.entityIds) : null;
  const textByPath = new Map<string, string | null>();
  const readText = async (path: string): Promise<string | null> => {
    if (textByPath.has(path)) return textByPath.get(path) ?? null;
    const snap = await gateway.readDoc(path).catch(() => null);
    const text = snap ? snap.content : null;
    textByPath.set(path, text);
    return text;
  };

  /** 战力相邻对：一次拼好，供所有规则比对（读卡失败进 errors，不静默跳过） */
  const pairs: Array<{
    entity: IndexEntityRow;
    pair: ReturnType<typeof pairPowerLog>[number];
    data: Record<string, unknown>;
  }> = [];
  for (const entity of entities) {
    if (scope && !scope.has(entity.id)) continue;
    const text = await readText(entity.filePath);
    if (text === null) {
      errors.push(`${entity.id}（${entity.filePath}）：设定卡读不到，战力台账无法求值`);
      continue;
    }
    const log = parsePowerLog(text);
    if (log.error) {
      errors.push(`${entity.id}（${entity.filePath}）：${log.error}`);
      continue;
    }
    for (const pair of pairPowerLog(log.entries)) pairs.push({ entity, pair, data: powerPairData(pair) });
    // 台账完整性核对（R97：D03 R3 升级三件套、R5 临时增益要回落）。它不进包规则不是偷懒：
    // 核对的是"作者自己声明的升级有没有交代代价"，与流派无关，与 R57 那条分工也不冲突。
    for (const row of checkPowerGate({ subject: entity.id, entries: log.entries })) {
      findings.push({ ...row, origin: POWER_GATE_ORIGIN });
    }
  }

  // T4-12（R85）：跨包同 id 先合并再求值——不合并的话同一条规则会被两个包各报一遍，
  // 而面板上两条结论的出处互相指认，作者学到的是"红色可以忽略"。
  const merge = applyRuleMerge(sets, options.asOf === undefined ? {} : { asOf: options.asOf });
  errors.push(...merge.errorLines);
  for (const item of merge.outOfDate) {
    notEvaluated.push({ id: item.id, reason: item.reason });
  }

  for (const { rule, origin: originLabel } of merge.runnable) {
    // 参与不参与**由数据决定**：把规则表达式里的 var 路径逐个拿去比对拼好的数据，
    // 一个都取不到 ⇒ 这条没跑，并把缺哪些路径写进理由（R57 的手写名单在这里退场）。
    const vars = collectVarReferences(rule.when);
    const missing = new Set<string>();
    let runnable = 0;
    for (const item of pairs) {
      const gaps = vars.filter((path) => readPath(item.data, path) === undefined);
      if (gaps.length > 0) {
        for (const gap of gaps) missing.add(gap);
        continue;
      }
      runnable += 1;
      const result = evaluateRule(rule, item.data);
      if (!result.matched) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        subject: item.entity.id,
        related: item.pair.b.chapter,
        message: result.message,
        evidence:
          `战力台账：${item.pair.a.chapter} 境界 ${item.pair.a.tier} / 战力 ${item.pair.a.combatPower}` +
          ` → ${item.pair.b.chapter} 境界 ${item.pair.b.tier} / 战力 ${item.pair.b.combatPower}` +
          `（设定卡 ${item.entity.filePath}）`,
        fix:
          `给 ${item.pair.b.chapter} 补一条能解释战力回落的事件（受伤 / 压制 / 道具失效），或下调该章的战斗表现；` +
          `确认是刻意反转就写进 config/consistency.yaml 并记理由`,
        origin: originLabel,
      });
    }
    if (runnable === 0) {
      notEvaluated.push({
        id: rule.id,
        reason:
          pairs.length === 0
            ? "项目里没有可比对的相邻战力数据（设定卡 extensions.power_log 少于两条），这条没跑"
            : vars.length === 0
              ? "表达式没有引用任何取数路径（常量条件），项目数据无从参与"
              : `求值数据取不到这些路径：${[...missing].sort().join("、")}（当前只提供战力相邻对），这条没跑`,
      });
    } else {
      evaluated.push(rule.id);
    }
  }

  findings.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return (a.related ?? "") < (b.related ?? "") ? -1 : (a.related ?? "") > (b.related ?? "") ? 1 : 0;
  });
  return {
    findings,
    evaluated: [...new Set(evaluated)].sort(),
    notEvaluated,
    errors: errors.sort(),
    merge: { overrides: merge.overrides, ambiguous: merge.ambiguous, dateCheck: merge.dateCheck },
  };
}
