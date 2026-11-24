#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * DCO 签署校验（仓库维护脚本，不进产品运行时；docs/04 §11.6 第三条门槛的 dco-check 岗）。
 *
 * Developer Certificate of Origin：每个提交信息须含一行
 *   Signed-off-by: 姓名 <邮箱>
 * 表示提交者有权提交该改动（用 `git commit -s` 自动追加）。见 CONTRIBUTING.md「提交约定」。
 *
 * 用法（三选一）：
 *   node scripts/check-dco.mjs --range origin/main..HEAD   # CI：校验 PR 区间内的提交
 *   node scripts/check-dco.mjs --json commits.json         # 夹具：[{ "sha", "message" }]
 *   git log --format=... | node scripts/check-dco.mjs      # stdin：同上 JSON
 * 退出码：0 = 全部已签署；1 = 有未签署提交（逐个点名 sha）；2 = 用法/读取错误。
 *
 * 范围说明：DCO 只约束**新提交**（CI 仅在 pull_request 上跑此岗）。本仓历史提交早于 DCO 约定、
 * 没有签署，属既有事实，不在 push(main) 上追溯拦截——那会把 main 自己拦死。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNOFF = /^Signed-off-by:\s+.+\s+<[^>]+>\s*$/im;

/** 纯函数：吃 [{ sha, message }]，吐 { ok, missing }（missing 是未签署的 sha 列表）。 */
export function checkDco(commits) {
  const missing = [];
  for (const c of commits) {
    if (!SIGNOFF.test(c.message ?? "")) missing.push(c.sha ?? "(unknown)");
  }
  return { ok: missing.length === 0, missing };
}

/** 从 git 区间取提交：NUL 分隔的 sha/message 对，避免提交信息里的换行把解析搅乱。 */
function commitsFromRange(range) {
  const out = execFileSync("git", ["log", "--format=%H%x00%B%x00", range], { encoding: "utf8" });
  const parts = out.split("\0").filter((p) => p.length > 0);
  const commits = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    commits.push({ sha: parts[i].trim(), message: parts[i + 1] });
  }
  return commits;
}

function readCommits() {
  const args = process.argv.slice(2);
  const rangeIdx = args.indexOf("--range");
  if (rangeIdx >= 0) {
    const range = args[rangeIdx + 1];
    if (!range) throw new Error("--range 需要一个区间，如 origin/main..HEAD");
    return commitsFromRange(range);
  }
  const jsonIdx = args.indexOf("--json");
  let raw;
  if (jsonIdx >= 0) {
    const file = args[jsonIdx + 1];
    if (!file) throw new Error("--json 需要一个文件路径");
    raw = readFileSync(resolve(file), "utf8");
  } else {
    raw = readFileSync(0, "utf8"); // stdin
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("提交数据必须是数组 [{ sha, message }]");
  return parsed;
}

function main() {
  let commits;
  try {
    commits = readCommits();
  } catch (err) {
    console.error(`读取提交失败：${err.message}`);
    process.exit(2);
  }
  const { ok, missing } = checkDco(commits);
  if (ok) {
    console.log(`dco-check 通过：${commits.length} 个提交均已签署`);
    process.exit(0);
  }
  console.error(`dco-check 未通过：${missing.length} 个提交缺少 Signed-off-by（用 git commit -s 补签）：`);
  for (const sha of missing) console.error(`  - ${sha}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}