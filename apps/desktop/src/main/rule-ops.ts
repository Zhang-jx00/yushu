import {
  collectExpressionIssues,
  duplicateRuleIds,
  evaluateRule,
  loadRuleSets,
  type ConsistencyRule,
  type PackRuleSet,
} from "@yushu/genre-engine";
import { PROJECT_CONFIG_PATH, parseProjectConfig } from "@yushu/world-engine";
import type {
  RuleCatalogPayload,
  RuleDryRunPayload,
  RuleDryRunResult,
  RuleFilePayload,
  RuleRowPayload,
} from "../shared/ipc.js";
import { loadPacksByIds } from "./project-ops.js";
import type { ProjectGateway } from "./file-gateway.js";
import { YushuError } from "@yushu/core";

/**
 * 规则目录与沙箱试算（M4 / T4-1 桌面接入，R51）。
 *
 * 两个通道**都是只读**（`wrap` 而非 `wrapWrite`）：规则本体来自内置派系包目录，御书不改派系包；
 * 试算只吃调用方给的 JSON 夹具，不读正文、不写盘。真正"拿项目数据去比对"属 T4-2。
 */

function toRow(rule: ConsistencyRule, set: PackRuleSet): RuleRowPayload {
  // 表达式问题以**求值期为准**再扫一遍：lint 侧已扫过，这里让面板单文件展示也拿得到
  const issues = Object.prototype.hasOwnProperty.call(set.expressionIssues, rule.id)
    ? set.expressionIssues[rule.id]!
    : collectExpressionIssues(rule.when);
  return {
    id: rule.id,
    severity: rule.severity,
    scope: rule.scope,
    message: rule.message,
    ...(rule.priority === undefined ? {} : { priority: rule.priority }),
    ...(rule.origin ? { origin_set: rule.origin.set } : {}),
    ...(rule.origin?.title ? { origin_title: rule.origin.title } : {}),
    ...(rule.origin?.source ? { origin_source: rule.origin.source } : {}),
    issues,
  };
}

/** 项目所选派系包 id（规则求值与目录共用一处，避免两处各读一遍 project.toml） */
export async function projectPackIds(gateway: ProjectGateway): Promise<string[]> {
  const snap = await gateway.readDoc(PROJECT_CONFIG_PATH).catch(() => null);
  return snap ? parseProjectConfig(snap.content).genre.packs : [];
}

/**
 * 列出项目所选派系包携带的全部规则。
 * 包找不到时**不降级成空目录**：作者会读成"这个包没有规则"，而真相是"包没加载出来"。
 */
export async function readRuleCatalog(gateway: ProjectGateway): Promise<RuleCatalogPayload> {
  const packIds = await projectPackIds(gateway);
  let sets: PackRuleSet[] = [];
  let loadError: string | null = null;
  try {
    sets = loadRuleSets(await loadPacksByIds(packIds));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  const files: RuleFilePayload[] = sets.map((set) => ({
    packId: set.packId,
    file: set.file,
    error: set.error,
    rules: set.rules.map((rule) => toRow(rule, set)),
  }));
  const duplicates = duplicateRuleIds(sets).map((item) => ({ id: item.id, files: item.files }));
  return {
    packIds,
    files,
    total: files.reduce((sum, file) => sum + file.rules.length, 0),
    brokenFiles: files.filter((file) => file.error !== null).length,
    problemRules: files.reduce((sum, file) => sum + file.rules.filter((rule) => rule.issues.length > 0).length, 0),
    duplicateIds: duplicates,
    loadError,
  };
}

/** 在目录里按 id 找规则；跨文件重名时要求带上文件名，避免"试算了哪一条"说不清 */
function findRule(sets: PackRuleSet[], ruleId: string, file?: string): ConsistencyRule {
  const candidates: Array<{ set: PackRuleSet; rule: ConsistencyRule }> = [];
  for (const set of sets) {
    for (const rule of set.rules) {
      if (rule.id !== ruleId) continue;
      if (file !== undefined && file !== "" && set.file !== file) continue;
      candidates.push({ set, rule });
    }
  }
  if (candidates.length === 0) {
    throw new YushuError("E_RULE_NOT_FOUND", `找不到规则「${ruleId}」${file ? `（文件 ${file}）` : ""}：请从目录里选一条`);
  }
  if (candidates.length > 1) {
    throw new YushuError(
      "E_RULE_AMBIGUOUS",
      `规则 id「${ruleId}」在多个文件里都存在（${candidates.map((item) => item.set.file).join("、")}）：请带上文件名`,
    );
  }
  return candidates[0]!.rule;
}

/**
 * 沙箱试算：给定 JSON 夹具求值一条规则。
 * 失败一律**原样带出原因**（非法 JSON / 找不到规则 / `E_RULE_*` 被沙箱拒绝），
 * 不返回 `matched:false` 冒充"检查通过"——这正是求值层"宁可报错也不静默当假"的口径。
 */
export async function dryRunRule(gateway: ProjectGateway, payload: RuleDryRunPayload): Promise<RuleDryRunResult> {
  const ruleId = payload.ruleId.trim();
  const empty: RuleDryRunResult = {
    ok: false,
    ruleId,
    matched: false,
    message: "",
    evidence: {},
    error: "",
  };
  let rule: ConsistencyRule;
  try {
    const sets = loadRuleSets(await loadPacksByIds(await projectPackIds(gateway)));
    rule = findRule(sets, ruleId, payload.file);
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload.data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...empty, error: "夹具顶层应为 JSON 对象（形如 {\"a\": {…}, \"b\": {…}}）" };
    }
    data = parsed as Record<string, unknown>;
  } catch (err) {
    return { ...empty, error: `夹具不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const result = evaluateRule(rule, data);
    return {
      ok: true,
      ruleId: result.ruleId,
      matched: result.matched,
      message: result.message,
      evidence: result.evidence,
      error: "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    return { ...empty, error: code ? `[${code}] ${message}` : message };
  }
}
