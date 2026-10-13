import { collectVarReferences, evaluateRule, loadRuleSets, readPath, type PackRuleSet } from "@yushu/genre-engine";
import {
  collectIndexInput,
  parsePowerLog,
  pairPowerLog,
  powerPairData,
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
}

/**
 * 数据绑定：**不再有"哪条规则参与求值"的手写名单**（R74）。每条规则表达式里的 `var` 路径
 * 就是它自己声明的数据需求，桌面端拿拼好的求值数据逐个比对：全都取得到才求值，
 * 否则进 `notEvaluated` 并点名缺哪些路径。新增包规则因此不需要改这里的代码——
 * 它要么真的能拿到数据并参与，要么被具体原因点名，**不会静默通过，也不会被名单漏掉**。
 */

function originOf(set: PackRuleSet): string {
  return `派系包 ${set.packId}（${set.file}）`;
}

async function cardEntities(gateway: ProjectGateway, entities?: IndexEntityRow[]): Promise<IndexEntityRow[]> {
  if (entities) return entities;
  return (await collectIndexInput(gatewayReader(gateway))).entities;
}

export async function evaluatePackRules(
  gateway: ProjectGateway,
  options: { packIds: string[]; entities?: IndexEntityRow[]; entityIds?: string[] },
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
  }

  for (const set of sets) {
    if (set.error) {
      errors.push(`${originOf(set)}：${set.error}`);
      continue;
    }
    for (const rule of set.rules) {
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
          origin: originOf(set),
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
  }

  findings.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return (a.related ?? "") < (b.related ?? "") ? -1 : (a.related ?? "") > (b.related ?? "") ? 1 : 0;
  });
  return { findings, evaluated: [...new Set(evaluated)].sort(), notEvaluated, errors: errors.sort() };
}
