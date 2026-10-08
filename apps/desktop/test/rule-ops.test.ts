import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChapter } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { dryRunRule, readRuleCatalog } from "../src/main/rule-ops.js";

/**
 * 规则目录与沙箱试算的主进程接线（M4 / T4-1 桌面接入，R51）。
 *
 * 两条最要紧的断言：
 * ① **两个通道都只读**——跑完目录与试算后，磁盘正文必须逐字不变（真数据比对属 T4-2）；
 * ② **被沙箱拒绝不得回成"未命中"**——`ok:false` 必须带原始 `E_RULE_*` 原因，
 *    否则作者会把"这条规则没跑成"读成"这里没问题"。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

let dir: string;
let gateway: ProjectGateway;
let chapterPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-rules-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { type: "character", name: "林渊", layer: "characters", visibility: "revealed" },
    body: "边城少年，剑道天赋被夺。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: volume.chapters[0]!.id,
    baseHash: generated.hash,
  });
  chapterPath = draft.chapterPath;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HIT_FIXTURE = JSON.stringify({
  a: { chapter: "第 3 章", realm: { tier: 3 }, combat_power: 100 },
  b: { chapter: "第 4 章", realm: { tier: 4 }, combat_power: 80 },
});

describe("规则目录（rule:catalog）", () => {
  it("列出项目所选包携带的全部规则，并按件给出出处", async () => {
    const catalog = await readRuleCatalog(gateway);
    expect(catalog.packIds).toEqual(["xuanhuan-xitong"]);
    expect(catalog.loadError).toBeNull();
    expect(catalog.files.map((file) => file.file)).toEqual(["rules/power-consistency.yaml", "rules/realm-progress.yaml"]);
    expect(catalog.total).toBe(6);
    expect(catalog.brokenFiles).toBe(0);
    expect(catalog.problemRules).toBe(0);
    expect(catalog.duplicateIds).toEqual([]);
    const regress = catalog.files[0]!.rules.find((rule) => rule.id === "power-no-regress")!;
    expect(regress.severity).toBe("error");
    expect(regress.scope).toBe("cross_chapter");
    expect(regress.origin_source).toContain("D03");
  });

  /** 改项目所选派系包（project.toml 的 genre.packs），用于构造"没选包 / 包不存在"两种目录状态 */
  async function setPackIds(gateway: ProjectGateway, toml: string): Promise<void> {
    const snap = await gateway.readDoc("project.toml");
    expect(snap).not.toBeNull();
    await gateway.writeDoc("project.toml", snap!.content.replace(/packs = \[[^\]]*\]/, toml), snap!.hash);
  }

  it("未选包的项目给出空目录而不是报错", async () => {
    await setPackIds(gateway, "packs = []");
    const catalog = await readRuleCatalog(gateway);
    expect(catalog.packIds).toEqual([]);
    expect(catalog.total).toBe(0);
    expect(catalog.files).toEqual([]);
    expect(catalog.loadError).toBeNull();
  });

  it("包 id 不存在时 loadError 外显——空目录不得被读成「这个包没有规则」", async () => {
    await setPackIds(gateway, 'packs = ["not-a-pack"]');
    const catalog = await readRuleCatalog(gateway);
    expect(catalog.loadError).toContain("找不到派系包");
    expect(catalog.total).toBe(0);
  });
});

describe("沙箱试算（rule:dryRun）", () => {
  it("命中：结论占位符已代入，evidence 给出真正读到的四个值", async () => {
    const result = await dryRunRule(gateway, { ruleId: "power-no-regress", data: HIT_FIXTURE });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.message).toBe("境界提升但战力下降（第 3 章→第 4 章），疑似战力崩塌");
    expect(result.evidence["a.realm.tier"]).toBe("3");
    expect(Object.keys(result.evidence)).toHaveLength(4);
    expect(result.error).toBe("");
  });

  it("未命中也如实返回（不是错误）：战力没降时 matched=false", async () => {
    const result = await dryRunRule(gateway, {
      ruleId: "power-no-regress",
      data: JSON.stringify({
        a: { chapter: "A", realm: { tier: 3 }, combat_power: 100 },
        b: { chapter: "B", realm: { tier: 4 }, combat_power: 200 },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(false);
  });

  it("被沙箱拒绝 → ok=false 且带原始 E_RULE_* 原因，**不伪装成未命中**", async () => {
    const result = await dryRunRule(gateway, {
      ruleId: "power-no-regress",
      data: JSON.stringify({ a: { chapter: "A", realm: { tier: 3 } }, b: { chapter: "B", realm: { tier: 4 } } }),
    });
    expect(result.ok).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.error).toContain("E_RULE_UNORDERABLE");
  });

  it("夹具不是合法 JSON / 顶层不是对象 → 明确拒绝", async () => {
    const broken = await dryRunRule(gateway, { ruleId: "power-no-regress", data: "{不是 JSON" });
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("合法 JSON");

    const array = await dryRunRule(gateway, { ruleId: "power-no-regress", data: "[1,2]" });
    expect(array.ok).toBe(false);
    expect(array.error).toContain("顶层应为 JSON 对象");
  });

  it("规则 id 找不到 → E_RULE_NOT_FOUND（不静默给一条别的规则）", async () => {
    const result = await dryRunRule(gateway, { ruleId: "no-such-rule", data: HIT_FIXTURE });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到规则「no-such-rule」");
  });

  it("带上文件名可按件消歧；指到不含该 id 的件时明确报错", async () => {
    const ok = await dryRunRule(gateway, {
      ruleId: "power-no-regress",
      file: "rules/power-consistency.yaml",
      data: HIT_FIXTURE,
    });
    expect(ok.ok).toBe(true);
    const wrong = await dryRunRule(gateway, {
      ruleId: "power-no-regress",
      file: "rules/realm-progress.yaml",
      data: HIT_FIXTURE,
    });
    expect(wrong.error).toContain("找不到规则");
  });

  it("两个只读通道都不写盘：目录与试算跑完后正文逐字不变", async () => {
    const before = await readChapter(gateway, chapterPath);
    await readRuleCatalog(gateway);
    await dryRunRule(gateway, { ruleId: "power-no-regress", data: HIT_FIXTURE });
    await dryRunRule(gateway, { ruleId: "power-no-regress", data: "{坏夹具" });
    const after = await readChapter(gateway, chapterPath);
    expect(after.body).toBe(before.body);
    expect(after.hash).toBe(before.hash);
  });
});
