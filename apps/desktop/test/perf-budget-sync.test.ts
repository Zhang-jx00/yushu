/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@yushu/core";
import { BUDGETS, BUDGET_YAML_MAP } from "../src/main/perf-budgets.js";

/**
 * 性能预算两份定义的一致性锁（R83）。
 *
 * 起因：`perf-budget.yaml` 自称"唯一事实源"，`perf-runner.ts` 里另抄了一份 `BUDGETS`，
 * 两边靠一句注释"保持一致"维系——**没有任何东西会因它不一致而变红**。
 * 本轮要给探针加两项指标，如果就这么加下去，漂移的概率反而更高，所以先把锁立上。
 * （同族规矩见 docs/06 §八 第 82 轮："写进对外文档的防护栏，同轮就要有测试"。）
 *
 * 三个方向都要拦住：
 * ① yaml 改了数字、探针没跟 ⇒ 红；
 * ② yaml 新增一项预算、映射表没登记 ⇒ 红（否则探针会静默不测这一项，
 *    而报告上看起来"全达标"）；
 * ③ 映射表写了 yaml 里没有的路径 ⇒ 红（拼错的路径读出来是 undefined，
 *    跟"值为 undefined"分不清）。
 */

const ROOT = join(__dirname, "..", "..", "..");

/** 用现成的 YAML 解析器读那份预算表（不为此给桌面端再加一个依赖） */
function readBudgetYaml(): Record<string, unknown> {
  const text = readFileSync(join(ROOT, "perf-budget.yaml"), "utf8");
  const parsed = parseFrontmatter<Record<string, unknown>>(`---\n${text}\n---`);
  const budgets = (parsed.data as Record<string, unknown>)["budgets"];
  if (typeof budgets !== "object" || budgets === null) {
    throw new Error("perf-budget.yaml 里没有 budgets 段（解析失败，不是「预算为空」）");
  }
  return budgets as Record<string, unknown>;
}

function readPath(budgets: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = budgets;
  for (const part of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** 把 yaml 的 budgets 段摊平成 `路径 → 数值`（只收数值叶子） */
function flattenNumbers(node: unknown, prefix: string, out: Map<string, number>): void {
  if (typeof node === "number" && Number.isFinite(node)) {
    out.set(prefix, node);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flattenNumbers(value, prefix === "" ? key : `${prefix}.${key}`, out);
  }
}

describe("性能预算两份定义一致（perf-budget.yaml ↔ BUDGETS）", () => {
  const budgets = readBudgetYaml();

  it("下限自校准：BUDGETS 与映射表都非空（防「空表通过一切」）", () => {
    expect(Object.keys(BUDGETS).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(BUDGET_YAML_MAP).length).toBe(Object.keys(BUDGETS).length);
  });

  it("每一项预算：yaml 的数字与探针用的数字逐个相等", () => {
    const mismatched: string[] = [];
    for (const [key, yamlPath] of Object.entries(BUDGET_YAML_MAP)) {
      const declared = readPath(budgets, yamlPath);
      const used = BUDGETS[key as keyof typeof BUDGETS];
      if (declared !== used) mismatched.push(`${key}: 探针用 ${String(used)}，yaml 写 ${String(declared)}`);
    }
    expect(mismatched).toEqual([]);
  });

  it("yaml 里新增的预算项必须登记进映射表（否则探针静默不测这一项）", () => {
    const flat = new Map<string, number>();
    flattenNumbers(budgets, "", flat);
    const mapped = new Set(Object.values(BUDGET_YAML_MAP));
    const unmapped = [...flat.keys()].filter((path) => !mapped.has(path));
    expect(unmapped).toEqual([]);
    // 绝对下限：这份预算表至少 10 个数值叶子，防"解析出空对象 ⇒ 零命中全绿"
    expect(flat.size).toBeGreaterThanOrEqual(10);
  });

  it("映射表不许指向 yaml 里不存在的路径（拼错的路径读出来是 undefined）", () => {
    const flat = new Map<string, number>();
    flattenNumbers(budgets, "", flat);
    const dangling = Object.entries(BUDGET_YAML_MAP)
      .filter(([, yamlPath]) => !flat.has(yamlPath))
      .map(([key, yamlPath]) => `${key} → ${yamlPath}`);
    expect(dangling).toEqual([]);
  });
});
