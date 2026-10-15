/* SPDX-License-Identifier: Apache-2.0 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 换行口径的机器判据（R100，收尾 `.gitattributes` 这条长期 earmark）。
 *
 * 起因不是"难看"，是**它会咬人**：这台机器 `core.autocrlf=true` 而仓库里没有 `.gitattributes`，
 * 于是同一个文件在不同工具手里得到不同行尾——`git status` 一路报"LF will be replaced by CRLF"，
 * 而 `git diff --numstat` **看不见行尾差异**（我至少在三轮里按字节复核过这件事）。
 * 行尾混杂还让"按字节比对产物"这类断言要额外小心。
 *
 * 口径只有一条：**文本一律 LF（index 与工作树都是）**，二进制一律不处理。
 * 判据里三条防自指的护栏都配了：
 * ① `git ls-files --eol` 的行数有下限（防"git 没跑起来 ⇒ 零行 ⇒ 全绿"）；
 * ② 违规必须**点名文件**，只报数量会让人以为差一两个无所谓；
 * ③ 被 git 判成二进制的文件必须逐个在 `binary` 名单里（否则某天真源文件被当二进制，行尾与 diff 一起失控）。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ATTRIBUTES_PATH = join(ROOT, ".gitattributes");

/** 必须声明为二进制的后缀（图片 / 字体 / 压缩包 / 数据库 / Java 归档） */
const BINARY_SUFFIXES = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "zip",
  "epub",
  "docx",
  "pdf",
  "jar",
  "db",
  "sqlite",
];

interface EolRow {
  path: string;
  index: string;
  worktree: string;
}

function hasGit(): boolean {
  return existsSync(join(ROOT, ".git"));
}

/** `git ls-files --eol` → 结构化行；git 不可用或报错时如实返回 null，不假装"没问题" */
function eolRows(): EolRow[] | null {
  if (!hasGit()) return null;
  let out = "";
  try {
    // 必须用 `-z`：加了 `.gitattributes` 之后 attr/ 字段变成 `attr/text eol=lf`（**中间有空格**），
    // 按空白切分会把 "eol=lf" 误当路径开头——第一版就是这么把 21 条违规的名字读花了。
    // NUL 分隔 + "制表符前是属性、后是路径"才站得住；中文文件名也不会再被引号绕进去。
    out = execFileSync("git", ["ls-files", "--eol", "-z"], { cwd: ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
  const rows: EolRow[] = [];
  for (const record of out.split("\0")) {
    if (record.trim() === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1).replace(/^"|"$/g, "");
    const index = (meta[0] ?? "").replace("i/", "");
    const worktree = (meta[1] ?? "").replace("w/", "");
    if (index === "" || worktree === "" || path === "") continue;
    rows.push({ path, index, worktree });
  }
  return rows;
}

describe("换行口径：文本一律 LF，二进制不处理（R100）", () => {
  const attributes = existsSync(ATTRIBUTES_PATH) ? readFileSync(ATTRIBUTES_PATH, "utf8") : null;

  it(".gitattributes 存在，并写明单一口径（不许出现 eol=crlf 的分裂规则）", () => {
    expect(attributes, "缺 .gitattributes：仓库里必须有它才能挡住行尾漂移").not.toBeNull();
    const text = attributes ?? "";
    expect(text).toContain("* text=auto eol=lf");
    const crlfLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && line.includes("eol=crlf"));
    expect(crlfLines, `这些规则把工作树改回 CRLF，口径又分裂了：${crlfLines.join(" / ")}`).toEqual([]);
  });

  it("每个二进制后缀都被点名（不让 git 靠启发式猜真源文件）", () => {
    const text = attributes ?? "";
    const missing = BINARY_SUFFIXES.filter((suffix) => !new RegExp(`\\*\\.${suffix}\\s+binary`).test(text));
    expect(missing, `.gitattributes 没声明这些后缀为 binary：${missing.join(", ")}`).toEqual([]);
  });

  it("现场量：index 与工作树都不许有 CRLF 或混杂行尾（违规必须点名）", () => {
    const rows = eolRows();
    // 下限取实测留余量：R100 现场 `git ls-files --eol` 共 **659 行**
    expect(rows, "git ls-files --eol 跑不出结果（没有 .git 或 git 不可用），本轮不给结论").not.toBeNull();
    const list = rows ?? [];
    expect(list.length, `实测只读到 ${list.length} 行，少到不可能是全仓库`).toBeGreaterThanOrEqual(600);
    const bad = list
      .filter((row) => row.worktree === "crlf" || row.worktree === "mixed" || row.index === "crlf" || row.index === "mixed")
      .map((row) => `${row.path}（index=${row.index} 工作树=${row.worktree}）`)
      .sort();
    expect(bad, `这些文件的行尾不符合"文本一律 LF"：\n${bad.join("\n")}`).toEqual([]);
  });

  it("被 git 判成二进制的文件必须真的在 binary 名单里（否则某天真源会被当二进制）", () => {
    const rows = eolRows();
    if (rows === null) return; // 无 git 时上一条已如实报错，这里不重复
    const unattributed = rows
      .filter((row) => row.index === "-text")
      .map((row) => row.path)
      .filter((path) => {
        const dot = path.lastIndexOf(".");
        const suffix = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
        return !BINARY_SUFFIXES.includes(suffix);
      });
    expect(unattributed, `git 把这些文件当二进制，但它们不在 binary 名单里：${unattributed.join(", ")}`).toEqual([]);
  });
});
