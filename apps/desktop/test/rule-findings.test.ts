import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardPath } from "@yushu/world-engine";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createProject, writeCardDoc } from "../src/main/project-ops.js";
import { evaluatePackRules } from "../src/main/rule-findings.js";

/**
 * 派系包规则拿项目数据求值（M4 / T4-2 第一条语义规则，R57）。
 *
 * 分工裁决写在 docs/04 §7.3：战力"崩没崩"的判定只有一套，在包里的 DSL 规则
 * （`power-no-regress`）；御书只负责把设定卡 `extensions.power_log` 拼成 `{a, b}`。
 * 所以这里最要紧的两条断言是：
 * ① **命中来自包规则自己的表达式**（改数据才改结论，不是引擎里另写一份判定）；
 * ② **没数据可比的规则必须点名**（`notEvaluated`），否则作者会把"这条没跑"读成"这里没问题"。
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-power-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePowerCard(id: string, name: string, log: string): Promise<string> {
  await gateway.writeDoc(
    cardPath("character", id),
    [
      "---",
      `id: ${id}`,
      "type: character",
      `name: ${name}`,
      "layer: characters",
      "aliases: []",
      "refs: []",
      "source_chapters: []",
      "visibility: hidden",
      "format_version: 1",
      "extensions:",
      "  power_log:",
      log,
      "---",
      "",
      `${name} 的正文。`,
      "",
    ].join("\n"),
    undefined,
  );
  return cardPath("character", id);
}

const REGRESS_LOG = [
  "    - chapter: 第 3 章",
  "      tier: 3",
  "      combat_power: 100",
  "    - chapter: 第 4 章",
  "      tier: 4",
  "      combat_power: 80",
  "",
].join("\n");

describe("派系包规则求值（战力崩塌）", () => {
  it("台账显示境界升、战力降：结论来自包规则，带出处与可跳转的主体", async () => {
    await writePowerCard("char-linyuan", "林渊", REGRESS_LOG);
    const run = await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    const hit = run.findings.find((finding) => finding.rule === "power-no-regress");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.subject).toBe("char-linyuan");
    expect(hit!.related).toBe("第 4 章");
    expect(hit!.message).toContain("疑似战力崩塌");
    expect(hit!.origin).toContain("xuanhuan-xitong");
  });

  it("不该命中：战力也一起涨时零结论（误报是这条规则的生死线）", async () => {
    await writePowerCard(
      "char-haize",
      "海泽",
      [
        "    - chapter: 第 3 章",
        "      tier: 3",
        "      combat_power: 100",
        "    - chapter: 第 4 章",
        "      tier: 4",
        "      combat_power: 180",
        "",
      ].join("\n"),
    );
    const run = await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    expect(run.findings.filter((finding) => finding.rule === "power-no-regress")).toEqual([]);
  });

  it("台账写不出章号：记一条错误点名卡与条目，不装作没问题", async () => {
    await writePowerCard(
      "char-unknown",
      "无名者",
      ["    - chapter: 序章", "      tier: 1", "      combat_power: 10", ""].join("\n"),
    );
    const run = await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    expect(run.findings).toEqual([]);
    expect(run.errors.length).toBe(1);
    expect(run.errors[0]).toContain("char-unknown");
    expect(run.errors[0]).toContain("章号");
  });

  it("没有数据绑定的包规则逐条列成 notEvaluated 并给原因（沉默的校验器最坏）", async () => {
    await writePowerCard("char-linyuan", "林渊", REGRESS_LOG);
    const run = await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    expect(run.evaluated).toEqual(["power-no-regress"]);
    expect(run.notEvaluated.map((item) => item.id).sort()).toEqual([
      "power-ceiling-exceeded",
      "power-no-cost",
      "realm-breakthrough-uncelebrated",
      "realm-gap-too-large",
      "realm-lifespan-missing",
    ]);
    expect(run.notEvaluated[0]!.reason).toContain("数据绑定");
  });

  it("求值全程只读：跑完卡文件字节不变", async () => {
    const path = await writePowerCard("char-linyuan", "林渊", REGRESS_LOG);
    const before = await gateway.readDoc(path);
    await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    const after = await gateway.readDoc(path);
    expect(after!.content).toBe(before!.content);
    expect(after!.hash).toBe(before!.hash);
  });

  it("卡片段没有台账时不报错：power_log 是可选字段", async () => {
    await writeCardDoc(gateway, {
      card: { id: "char-plain", type: "character", name: "路人", layer: "characters" },
      body: "没有战力台账。",
    });
    const run = await evaluatePackRules(gateway, { packIds: ["xuanhuan-xitong"] });
    expect(run.errors).toEqual([]);
    expect(run.findings).toEqual([]);
  });
});
