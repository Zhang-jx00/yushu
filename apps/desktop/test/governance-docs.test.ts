/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 社区健康文件与「对外声称不得跑在账本前面」的锁（R81）。
 *
 * 为什么要有这条文件：`docs/04` §11.2 / §11.4 列的门槛里有四份健康文件加一份 CODEOWNERS，
 * 而 CONTRIBUTING / SECURITY 早就在、README 也一直在改——**最容易烂的恰好是「对外承诺」那一层**：
 * 代码变了，路线图还写着「未开始」；文件建了，里面的承诺是模板抄来的空话，没人负责执行。
 *
 * 这条锁只钉三类东西：
 * ① 文件在不在（最便宜也最容易被忘）；
 * ② 承诺是不是**可指认的条款**——不查有没有写「欢迎贡献」，查那些将来会被拿来问责的具体东西：
 *    处置阶梯的四级、维护者梯队的四级、「核心离线能力永久免费」这句边界、SECURITY 的支持版本范围
 *    与披露时限、issue/PR 模板里的行为准则勾选项；
 * ③ **反漂移**：账本里某里程碑已经动过（勾了任务或留了进展注记），对外文档就不许再写它「未开始」。
 *    这一类才是本轮真正的新锁——它防的不是文件缺失，而是「文件在、话过时了」。
 */

const REPO = new URL("../../../", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, REPO), "utf8");
const has = (rel: string): boolean => existsSync(new URL(rel, REPO));

/** 取出某个里程碑在 docs/04 里的那一节（找不到返回空串） */
function ledgerSection(milestone: string): string {
  const ledger = read("docs/04-开发计划.md");
  const sectionRe = new RegExp(`## \\d+\\. ${milestone}[\\s\\S]*?(?=\\n## \\d+\\. |\\n## 1[0-9]\\. )`);
  return sectionRe.exec(ledger)?.[0] ?? "";
}

/** 把里程碑一节切成「一条任务 + 它下面的注记块」 */
function taskBlocks(milestone: string): Array<{ id: string; checked: boolean; body: string }> {
  const section = ledgerSection(milestone);
  const heads = [...section.matchAll(/^- \[([ x])\] (T\d+-\d+)/gm)];
  return heads.map((head, index) => ({
    id: head[2],
    checked: head[1] === "x",
    body: section.slice(head.index, index + 1 < heads.length ? heads[index + 1].index : section.length),
  }));
}

/** 已勾选的任务号 */
function checkedTasks(milestone: string): string[] {
  return taskBlocks(milestone)
    .filter((block) => block.checked)
    .map((block) => block.id);
}

/**
 * 「动过」= 勾了，或该任务下面留了进展注记。
 * T5-7 就是这一类：三段注记、零勾选——对外文档写它「未开始」同样是漂移。
 */
function touchedTasks(milestone: string): string[] {
  return taskBlocks(milestone)
    .filter((block) => block.checked || block.body.includes("进展注记"))
    .map((block) => block.id);
}

describe("四份社区健康文件与 CODEOWNERS 齐备", () => {
  it.each([
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "GOVERNANCE.md",
    "CODEOWNERS",
    "NOTICE",
    "LICENSE",
    "ROADMAP.md",
    ".github/ISSUE_TEMPLATE/pack_submission.yml",
  ])("%s 存在", (file) => {
    expect(has(file)).toBe(true);
  });
});

describe("对外承诺必须是可指认的条款，不是模板空话", () => {
  it("行为准则给出四级处置阶梯与真实举报渠道", () => {
    const coc = read("CODE_OF_CONDUCT.md");
    for (const step of ["督促", "警告", "临时封禁", "永久开除"]) {
      expect(coc).toContain(step);
    }
    // 渠道必须落到本项目实际存在的路径上，不许是一个虚构邮箱
    expect(coc).toContain("SECURITY.md");
    expect(coc).not.toMatch(/example\.com|your-?email|XXX@/i);
    // 适用范围：项目空间与公开空间都要覆盖，否则线下骚扰没人管
    expect(coc).toContain("项目空间");
    expect(coc).toContain("公开空间");
  });

  it("GOVERNANCE 写出四级梯队、独立 moderation 与商业化边界承诺", () => {
    const gov = read("GOVERNANCE.md");
    for (const tier of ["贡献者", "复审者", "维护者", "核心团队"]) {
      expect(gov).toContain(tier);
    }
    expect(gov).toContain("moderation");
    // 这句是 docs/04 §10 风险表里写明的承诺，不是装饰
    expect(gov).toContain("核心离线能力永久免费");
    expect(gov).toContain("数据主权");
  });

  it("SECURITY 给出支持版本范围与披露时限", () => {
    const sec = read("SECURITY.md");
    expect(sec).toContain("支持版本");
    expect(sec).toMatch(/90\s*天|三个月/);
  });

  it("CODEOWNERS 按领域指派，且指向真实存在的维护者账号", () => {
    const owners = read("CODEOWNERS");
    for (const domain of ["editor", "world-engine", "memory", "pack"]) {
      expect(owners.toLowerCase()).toContain(domain);
    }
    expect(owners).toContain("@Zhang-jx00");
  });

  it("issue 与 PR 模板带行为准则勾选项（§11.2 的门槛）", () => {
    expect(read(".github/PULL_REQUEST_TEMPLATE.md")).toContain("CODE_OF_CONDUCT");
    for (const file of [
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_proposal.yml",
      ".github/ISSUE_TEMPLATE/pack_submission.yml",
    ]) {
      expect(read(file)).toContain("CODE_OF_CONDUCT");
    }
  });

  it("派系包投稿模板要求说清许可与来源（派系包是数据，这两条是命门）", () => {
    const form = read(".github/ISSUE_TEMPLATE/pack_submission.yml");
    expect(form).toContain("许可");
    expect(form).toContain("来源");
  });
});

describe("反漂移：账本里已动过的里程碑，对外文档不许写「未开始」", () => {
  it("先确认这条断言有牙齿：M6 零勾选零注记 ⇒ 允许写未开始；M4 已勾 9 项 ⇒ 不许", () => {
    expect(checkedTasks("M6")).toEqual([]);
    expect(touchedTasks("M6")).toEqual([]);
    expect(checkedTasks("M4").length).toBeGreaterThan(0);
    expect(touchedTasks("M5").length).toBeGreaterThan(0);
  });

  it.each(["M1", "M2", "M3", "M4", "M5"])("%s 在 ROADMAP 与 README 里的状态与账本不矛盾", (milestone) => {
    if (touchedTasks(milestone).length === 0) return; // 真没动过的里程碑允许写「未开始」
    for (const file of ["ROADMAP.md", "README.md"]) {
      const rows = read(file)
        .split("\n")
        .filter((row) => row.startsWith(`| ${milestone} `) || row.startsWith(`| **${milestone} `));
      for (const row of rows) {
        // 只看**状态那一格**：整行搜「未开始」会误伤「导出管线（T5-4）未开始」这种对子项的诚实说明，
        // 而真正要挡的是把整个里程碑说成没动过。
        const cells = row.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
        const status = cells[cells.length - 1] ?? "";
        // 断言的**主语必须是状态格本身**。先前写成 expect(`${file} :: ${status}`).not.toMatch(/^未开始/)
        // ——`^` 锚在拼接出来的文件名上，永远不可能匹配，于是这条锁是假的（变异打不动它）。
        const claimsNotStarted = /^未开始/.test(status);
        expect(claimsNotStarted, `${file} 的 ${milestone} 状态格`).toBe(false);
      }
    }
  });
});
