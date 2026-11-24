#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * CHANGELOG 结构校验（仓库维护脚本，不进产品运行时；docs/04 §11.6 第三条门槛的 changelog-check 岗）。
 *
 * 用法：
 *   node scripts/check-changelog.mjs [CHANGELOG.md]
 * 退出码：0 = 结构合法；1 = 有违规（逐条打印）；2 = 用法/读文件错误。
 *
 * 校验的不变量（都是本仓真实成立、且能抓住回归的规则）：
 *   ① 必须有 `## [Unreleased]` 段（Keep a Changelog 的硬要求，新改动先落这里）。
 *   ② 每个 `## [...]` 版本头要么是 `Unreleased`，要么是合法 semver（含预发布/构建后缀）。
 *   ③ 版本头不许重复（重复意味着两段同名版本，下游对不上）。
 *   ④ 版本头若带日期后缀，必须是合法 ISO 8601（YYYY-MM-DD）；不许写成别的格式。
 *
 * 显式差异（不许静默改道，docs/03 §0.2）：本仓的 Unreleased 段按**工作线程**分节
 * （`### 性能预算线程` / `### UI 重构线程` …），而非 Keep a Changelog 的六类标题
 * （Added/Changed/…）。这是轮次制多线程开发的 deliberate 选择，故本脚本**不**校验六类标题，
 * 只校验上面四条版本结构不变量。`## [0.1.0-alpha]` 是未正式打 tag 的里程碑记录、无日期，
 * 因此「日期」是「带了就须合法」而非「必须带」——不给没发生的发布编造日期。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEADER = /^## \[([^\]]+)\](.*)$/;

/** 纯函数：吃 CHANGELOG 全文，吐 { ok, errors }。导出以便复用与单测。 */
export function checkChangelog(text) {
  const errors = [];
  const headers = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADER.exec(line);
    if (m) headers.push({ version: m[1], rest: m[2] });
  }
  if (!headers.some((h) => h.version === "Unreleased")) {
    errors.push("缺少 ## [Unreleased] 段（新改动必须先落 Unreleased）");
  }
  const seen = new Set();
  for (const h of headers) {
    if (h.version !== "Unreleased" && !SEMVER.test(h.version)) {
      errors.push(`版本头不是合法 semver：## [${h.version}]`);
    }
    if (seen.has(h.version)) errors.push(`版本头重复：## [${h.version}]`);
    seen.add(h.version);
    const rest = h.rest.trim();
    if (rest !== "") {
      // 合法后缀形如 "- 2026-10-06" 或 "- 2026-10-06 [YANKED]"
      const dm = /^-\s*(\d{4}-\d{2}-\d{2})(?:\s+\[YANKED\])?$/.exec(rest);
      if (!dm) {
        errors.push(`版本头带了非 ISO 日期后缀：## [${h.version}] ${h.rest}`);
      } else {
        const d = dm[1];
        const dt = new Date(`${d}T00:00:00Z`);
        if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) {
          errors.push(`版本日期不是合法日历日：${d}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  const file = resolve(process.argv[2] ?? "CHANGELOG.md");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`读不到文件：${file}（${err.message}）`);
    process.exit(2);
  }
  const { ok, errors } = checkChangelog(text);
  if (ok) {
    console.log(`changelog-check 通过：${file}`);
    process.exit(0);
  }
  console.error(`changelog-check 未通过（${errors.length} 条）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// 仅在被直接执行时跑 CLI；被 import 时只导出纯函数。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}