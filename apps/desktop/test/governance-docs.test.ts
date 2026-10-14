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
    // 正则里 `(T\d+-\d+)` 是必选组，匹配成功就一定有值
    id: head[2] ?? "",
    checked: head[1] === "x",
    body: section.slice(head.index ?? 0, index + 1 < heads.length ? (heads[index + 1]?.index ?? section.length) : section.length),
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

  it("README 引用的测试数与交接文档 §1 的基线数是同一个（防对外数字烂在两处）", () => {
    /**
     * R86 总复核实抓到：README 的 `pnpm test` 注释停在 R83 的「1153 例 / 110 文件」，
     * 而 R84、R85 各加了一批测试后交接文档已经写到 1186/114。
     * 这类漂移不会让任何东西变红，只会让**读者拿到的数字是假的**——
     * 而对外文档里的数字恰恰是别人判断"这仓库靠不靠谱"的依据。
     */
    const readme = read("README.md");
    const handover = read("docs/08-交接文档-给QoderCN.md");
    const readmeCount = /(\d+) 例 \/ (\d+) 文件/.exec(readme);
    const handoverCount = /\*\*(\d+)\/\1 全绿\*\*（(\d+) 个测试文件）/.exec(handover);
    expect(readmeCount, "README 里找不到「N 例 / M 文件」这句（被删了？那就连带把这条锁改掉）").not.toBeNull();
    expect(handoverCount, "交接文档 §1 里找不到基线数那行").not.toBeNull();
    expect(
      `${readmeCount?.[1]} / ${readmeCount?.[2]}`,
      `README 写 ${readmeCount?.[1]} 例 / ${readmeCount?.[2]} 文件，交接文档写 ${handoverCount?.[1]} / ${handoverCount?.[2]}`,
    ).toBe(`${handoverCount?.[1]} / ${handoverCount?.[2]}`);
    // 同一份交接文档里 §7 的"期望 N/N（M 文件）"也必须与 §1 一致——
    // R86 复核就是抓到 §7 停在 R84 的 1166/112 而 §1 已经走到 1186/114（一轮之内两处不同步）。
    const baseline = `${handoverCount?.[1]}/${handoverCount?.[2]}`;
    const stale = [...handover.matchAll(/期望 (\d+)\/\1（(\d+) 文件/g)]
      .map((match) => `${match[1]}/${match[2]}`)
      .filter((value) => value !== baseline);
    expect(stale, `交接文档 §7 的期望值与 §1 基线不一致：${stale.join("、")}（基线 ${baseline}）`).toEqual([]);
  });

  it("交接文档 §1 的 M4 进度计数与 docs/04 §7.3 的勾选实况一致", () => {
    /**
     * R86 总复核实抓到：`docs/08` §1 那句"当前进度"还停在 R58 的口径
     * （"T4-1 / T4-3 / T4-4 已勾选；T4-2 / T4-11 已落地但验收未齐"），
     * 而 `docs/04` §7.3 实际已经勾到 T4-1..T4-10 + T4-12。
     * 开头一段是读者与后来接手的人**唯一会先读的那一句**，它落后的方式是"少报进度"——
     * 不会骗人做多，但会让人以为前面没做，于是重复劳动。
     * 所以这里不校对散文，只校对一个**机器可读的计数标记**。
     */
    const plan = read("docs/04-开发计划.md");
    const ticked = [...plan.matchAll(/^- \[x\] (T4-\d+)/gm)].map((match) => match[1] as string);
    const open = [...plan.matchAll(/^- \[ \] (T4-\d+)/gm)].map((match) => match[1] as string);
    // 绝对下限：M4 一共 12 条任务，解析不出来就是正则坏了，不能让"零命中"冒充一致
    expect(ticked.length + open.length).toBe(12);
    const handover = read("docs/08-交接文档-给QoderCN.md");
    const claim = /M4 进度：已勾 (\d+)\/(\d+)（未勾：([^）]*)）/.exec(handover);
    expect(claim, "交接文档 §1 缺『M4 进度：已勾 N/M（未勾：…）』这个机器可读标记").not.toBeNull();
    expect(`${claim?.[1]}/${claim?.[2]}`, `docs/04 实况是 ${ticked.length}/${ticked.length + open.length}`).toBe(
      `${ticked.length}/${ticked.length + open.length}`,
    );
    expect((claim?.[3] ?? "").split("、").map((id) => id.trim()).sort()).toEqual(open.slice().sort());
  });
});
