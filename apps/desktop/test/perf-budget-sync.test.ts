/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync, readdirSync } from "node:fs";
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

  it("BUDGETS 每一项都必须真的进探针 checks（R180：登记了预算却不门禁 = 账实不符）", () => {
    /**
     * R169 实撞：yaml 与 BUDGETS 都登记了 module_exec_ms / fcp_ms，注释写「R169 起参与门禁」，
     * 但 perf-runner 组 checks 时漏了这两键 ⇒ 只进报告、不翻退出码，门禁名存实亡。
     * 上面四条锁只管「两份定义一致」，管不到「定义了却没用」——这条锁补上那个洞：
     * 源码腿扫 checks 对象字面量，与 BUDGETS 键（去掉单位后缀）双向对账。
     */
    const src = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "perf-runner.ts"), "utf8");
    const keys = extractChecksKeys(src);
    expect(keys.length, "checks 块没解析出来（扫描器坏了？）").toBeGreaterThanOrEqual(10);
    const expected = Object.keys(BUDGETS).map((k) => k.replace(/_(ms|mb|min)$/, ""));
    const missing = expected.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !expected.includes(k));
    expect(missing, `预算登记了却没进 checks：${missing.join(", ")}`).toEqual([]);
    expect(extra, `checks 里有没登记预算的项（硬编门禁？）：${extra.join(", ")}`).toEqual([]);
    // 自检：抽掉一项的样本必须被抓出来（防「解析出空数组 ⇒ 零命中全绿」）
    const sample = src.replace(
      "module_exec: boot.module_exec_ms !== null && boot.module_exec_ms <= BUDGETS.module_exec_ms,",
      "",
    );
    const sampleKeys = extractChecksKeys(sample);
    expect(expected.filter((k) => !sampleKeys.includes(k)), "自检样本应点名缺 module_exec").toContain("module_exec");
  });

  it("最新归档 perf 报告的 checks 必须覆盖探针当前全部检查项（R180：改了门禁就要重跑留证）", () => {
    /**
     * 归档回执腿：门禁项变了而最新归档报告还是旧的 ⇒ 「跑过 perf」这句话覆盖不了新门禁。
     * 逼着改门禁的那一轮真的重跑探针并把报告归档（docs/assets/perf/），不许只改代码不留证。
     */
    const dir = join(ROOT, "docs", "assets", "perf");
    const files = readdirSync(dir)
      .filter((n) => /^perf-report-local-dev-\d{8}.*\.json$/.test(n))
      .sort();
    expect(files.length, "一份归档报告都没读到（目录错了？）").toBeGreaterThanOrEqual(1);
    const latestName = files[files.length - 1] ?? "";
    const latest = JSON.parse(readFileSync(join(dir, latestName), "utf8")) as {
      checks?: Record<string, unknown>;
    };
    const archived = Object.keys(latest.checks ?? {});
    const src = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "perf-runner.ts"), "utf8");
    const current = extractChecksKeys(src);
    expect(current.length, "checks 块没解析出来（扫描器坏了？）").toBeGreaterThanOrEqual(10);
    const missing = current.filter((k) => !archived.includes(k));
    expect(
      missing,
      `最新归档报告（${latestName}）缺检查项：${missing.join(", ")}——改了门禁要重跑 perf 并归档`,
    ).toEqual([]);
  });
});

/** 从 perf-runner.ts 源码里提取 checks 对象字面量的键（4 空格缩进的 `key:` 行） */
function extractChecksKeys(src: string): string[] {
  const m = /const checks = \{([\s\S]*?)\n  \};/.exec(src);
  if (!m) return [];
  const body = m[1] ?? "";
  return [...body.matchAll(/^\s{4}([a-z_0-9]+):/gm)].map((x) => x[1] ?? "");
}
