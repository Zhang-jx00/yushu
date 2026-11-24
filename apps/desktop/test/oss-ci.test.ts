/* SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 开源 CI 门槛锁（R192，docs/04 §11.6 第三条：lint / test / dco-check / changelog-check）。
 *
 * 两条腿：
 * ① **配置在场**——`.github/workflows/ci.yml` 真的存在且四岗齐备、真的跑 pnpm test/typecheck、
 *    dco 岗只在 PR 上跑。把某一岗删掉、或把 dco 改成 push 也跑，当场红。
 * ② **脚本行为**——两个零依赖校验脚本以子进程跑好/坏夹具：好的退出 0、坏的退出 1 并点名。
 *    用子进程而不是 import，是因为它们是仓库维护脚本（.mjs，不进产品运行时），
 *    且 test 目录的相对导入锁要求 .js 后缀（esm-relative-imports.test.ts）——子进程绕开这条，
 *    也更贴近 CI 里真实的调用方式（`node scripts/...`）。
 *
 * 「能红」靠变异证明：把脚本逻辑改坏（如 checkChangelog 恒返回 ok）或删掉 ci.yml 某一岗，
 * 本文件对应的坏夹具/在场断言会红。
 */

const ROOT = join(__dirname, "..", "..", "..");
const CI_YML = join(ROOT, ".github", "workflows", "ci.yml");
const CHANGELOG_SCRIPT = join(ROOT, "scripts", "check-changelog.mjs");
const DCO_SCRIPT = join(ROOT, "scripts", "check-dco.mjs");

const tmp = mkdtempSync(join(tmpdir(), "yushu-oss-ci-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 跑一个 node 脚本，返回退出码与输出（不抛异常，便于断言非零退出）。 */
function runNode(script: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fixture(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("CI 配置在场（docs/04 §11.6 第三条）", () => {
  it("ci.yml 存在且四岗齐备：lint / test / dco-check / changelog-check", () => {
    expect(existsSync(CI_YML), ".github/workflows/ci.yml 不存在 ⇒ CI 门槛没落地").toBe(true);
    const yml = readFileSync(CI_YML, "utf8");
    for (const job of ["lint:", "test:", "dco-check:", "changelog-check:"]) {
      expect(yml, `CI 缺少 ${job} 岗`).toContain(job);
    }
  });

  it("lint/test 岗真的跑 typecheck 与 pnpm test；dco 岗只在 PR 上跑", () => {
    const yml = readFileSync(CI_YML, "utf8");
    expect(yml).toContain("pnpm typecheck");
    expect(yml).toContain("pnpm test");
    expect(yml).toContain("node scripts/check-dco.mjs");
    expect(yml).toContain("node scripts/check-changelog.mjs");
    // dco 岗须有 pull_request 条件——否则历史无签署提交会把 push(main) 拦死
    expect(yml).toContain("github.event_name == 'pull_request'");
  });

  it("两个零依赖校验脚本在场", () => {
    expect(existsSync(CHANGELOG_SCRIPT)).toBe(true);
    expect(existsSync(DCO_SCRIPT)).toBe(true);
  });
});

describe("changelog-check 脚本行为", () => {
  it("真实 CHANGELOG 通过（退出 0）", () => {
    const r = runNode(CHANGELOG_SCRIPT, [join(ROOT, "CHANGELOG.md")]);
    expect(r.status, `真实 CHANGELOG 应通过，实际 stderr：${r.stderr}`).toBe(0);
  });

  it("缺 Unreleased 段 ⇒ 红并点名", () => {
    const f = fixture("no-unreleased.md", "# Changelog\n\n## [0.2.0] - 2026-10-06\n\n### Fixed\n- x\n");
    const r = runNode(CHANGELOG_SCRIPT, [f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unreleased");
  });

  it("非法 semver 版本头 ⇒ 红", () => {
    const f = fixture("bad-semver.md", "# Changelog\n\n## [Unreleased]\n\n## [不是版本]\n");
    const r = runNode(CHANGELOG_SCRIPT, [f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("semver");
  });

  it("非法日历日期 ⇒ 红", () => {
    const f = fixture("bad-date.md", "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-13-40\n");
    const r = runNode(CHANGELOG_SCRIPT, [f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("日历日");
  });

  it("重复版本头 ⇒ 红", () => {
    const f = fixture("dup.md", "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-06\n\n## [0.2.0] - 2026-10-06\n");
    const r = runNode(CHANGELOG_SCRIPT, [f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("重复");
  });

  it("合法 semver 预发布 + ISO 日期 + YANKED ⇒ 绿", () => {
    const f = fixture("good.md", "# Changelog\n\n## [Unreleased]\n\n## [0.1.0-alpha]\n\n## [0.2.0] - 2026-10-06\n\n## [0.3.0] - 2026-11-01 [YANKED]\n");
    const r = runNode(CHANGELOG_SCRIPT, [f]);
    expect(r.status, `合法结构应通过，stderr：${r.stderr}`).toBe(0);
  });
});

describe("dco-check 脚本行为", () => {
  it("全部已签署 ⇒ 绿（退出 0）", () => {
    const f = fixture("signed.json", JSON.stringify([
      { sha: "aaa111", message: "feat: x\n\nSigned-off-by: 张三 <zhang@example.com>\n" },
      { sha: "bbb222", message: "fix: y\n\nSigned-off-by: Li Si <li@example.com>\n" },
    ]));
    const r = runNode(DCO_SCRIPT, ["--json", f]);
    expect(r.status, `全签署应通过，stderr：${r.stderr}`).toBe(0);
  });

  it("有未签署提交 ⇒ 红并逐个点名 sha", () => {
    const f = fixture("unsigned.json", JSON.stringify([
      { sha: "aaa111", message: "feat: x\n\nSigned-off-by: 张三 <zhang@example.com>\n" },
      { sha: "ccc333", message: "fix: 没有签署\n" },
    ]));
    const r = runNode(DCO_SCRIPT, ["--json", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ccc333");
    expect(r.stderr).not.toContain("aaa111"); // 已签署的不该被点名
  });

  it("空提交集 ⇒ 绿（没有提交就没有未签署）", () => {
    const f = fixture("empty.json", "[]");
    const r = runNode(DCO_SCRIPT, ["--json", f]);
    expect(r.status).toBe(0);
  });

  it("Signed-off-by 格式不对（缺邮箱）⇒ 红", () => {
    const f = fixture("bad-signoff.json", JSON.stringify([
      { sha: "ddd444", message: "feat: x\n\nSigned-off-by: 张三\n" },
    ]));
    const r = runNode(DCO_SCRIPT, ["--json", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ddd444");
  });
});