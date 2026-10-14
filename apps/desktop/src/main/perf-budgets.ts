/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 性能预算（M2 / T2-10；R83 从 `perf-runner.ts` 里搬出来单独成模块）。
 *
 * 为什么要搬：仓库根 `perf-budget.yaml` 自称"唯一事实源"，而探针用的是 `perf-runner.ts` 里
 * 手抄的一份数字，两边靠一句注释维系——**没有任何东西会因它俩不一致而变红**。
 * 本轮要给探针加指标，先立锁再改数字：`perf-budget-sync.test.ts` 双向对账
 * （yaml 改了探针没跟 ⇒ 红；yaml 新增项没登记 ⇒ 红；映射指向不存在的路径 ⇒ 红）。
 *
 * 之所以不直接从 `perf-runner.ts` 导出给测试用：那个模块顶层 `import { app } from "electron"`，
 * 在 node 环境的 vitest 里导入它属于自找麻烦。**预算是数据，数据该住在没有依赖的地方**。
 */

/** 探针逐项门禁值（越低越好；`rebuild_cpm_min` 是吞吐、越高越好） */
export const BUDGETS = {
  cold_to_editable_ms: 2000,
  hot_to_editable_ms: 800,
  project_open_ms: 3000,
  keystroke_p95_ms: 16,
  keystroke_mega_p95_ms: 16,
  save_to_indexed_ms: 500,
  query_p95_ms: 80,
  rebuild_cpm_min: 20000,
  idle_rss_mb: 600,
  million_chars_rss_mb: 1200,
} as const;

/**
 * `BUDGETS` 的键 → `perf-budget.yaml` 里 `budgets:` 之下的点分路径。
 *
 * 两份清单的**键名本来就不一致**（yaml 写 `project_open.million_chars_ms`、探针叫
 * `project_open_ms`；yaml 写 `search.rebuild_cpm`、探针叫 `rebuild_cpm_min`），
 * 所以这张表就是唯一的翻译层；`Record<keyof typeof BUDGETS, string>` 让"漏登记一项"
 * 在编译期就报出来，运行期那条锁再查另外三个方向。
 */
export const BUDGET_YAML_MAP: Record<keyof typeof BUDGETS, string> = {
  cold_to_editable_ms: "startup.cold_to_editable_ms",
  hot_to_editable_ms: "startup.hot_to_editable_ms",
  project_open_ms: "project_open.million_chars_ms",
  keystroke_p95_ms: "edit.keystroke_p95_ms",
  keystroke_mega_p95_ms: "edit.keystroke_mega_p95_ms",
  save_to_indexed_ms: "edit.save_to_indexed_ms",
  query_p95_ms: "search.query_p95_ms",
  rebuild_cpm_min: "search.rebuild_cpm",
  idle_rss_mb: "memory.idle_rss_mb",
  million_chars_rss_mb: "memory.million_chars_rss_mb",
};
