import { describe, expect, it } from "vitest";
import {
  checkStructure,
  checkStructureFromSources,
  createSettingCard,
  createWorldConfig,
  serializeCardFile,
  serializeWorldConfig,
  type IndexSourceReader,
  type StructureInput,
} from "@yushu/world-engine";

function readerOf(files: Record<string, string>): IndexSourceReader {
  return {
    listFiles: async () => Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

/**
 * 结构完整性规则（M4 / T4-2，docs/03 §分级规则 + K05）。
 * 输入是**纯真源产物**（实体行 + 引用行），不碰 SQLite——索引可删，删库后结论必须不变。
 */

const card = (id: string, layer: string, filePath = `world/cards/x/${id}.md`) => ({
  id,
  type: "character",
  layer,
  name: id,
  aliases: [],
  visibility: "revealed",
  filePath,
});

const ref = (referrer: string, target: string, relation = "depends_on") => ({ referrer, target, relation });

describe("ref-dangling 悬空引用", () => {
  it("引用指向不存在的实体 → 一条 error，证据说出谁在哪个文件用什么关系引了谁", () => {
    const input: StructureInput = {
      entities: [card("char-linyuan", "characters")],
      refs: [ref("char-linyuan", "char-ghost")],
    };
    const report = checkStructure(input);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      rule: "ref-dangling",
      severity: "error",
      subject: "char-linyuan",
      related: "char-ghost",
    });
    expect(report.findings[0]!.evidence).toContain("world/cards/x/char-linyuan.md");
    expect(report.findings[0]!.evidence).toContain("depends_on");
  });

  it("不该命中：引用全部指向存在的实体时零发现", () => {
    const input: StructureInput = {
      entities: [card("char-linyuan", "characters"), card("geo-qingyun", "geography")],
      refs: [ref("char-linyuan", "geo-qingyun")],
    };
    expect(checkStructure(input).findings).toEqual([]);
  });

  it("口径钉住「按 id 精确匹配」：target 写成某卡的名字也不算存在（否则真悬空会被洗成命中）", () => {
    const input: StructureInput = {
      entities: [{ ...card("char-linyuan", "characters"), name: "林渊", aliases: ["小渊"] }],
      refs: [ref("char-linyuan", "林渊"), ref("char-linyuan", "小渊")],
    };
    const report = checkStructure(input);
    expect(report.findings.map((finding) => finding.related)).toEqual(["小渊", "林渊"]);
    expect(report.findings.every((finding) => finding.rule === "ref-dangling")).toBe(true);
  });

  it("多条悬空按 主体→目标 稳定排序（同输入同输出，不依赖对象插入顺序）", () => {
    const input: StructureInput = {
      entities: [card("char-a", "characters"), card("char-b", "characters")],
      refs: [ref("char-b", "ghost-z"), ref("char-a", "ghost-y"), ref("char-a", "ghost-x")],
    };
    const first = checkStructure(input);
    const second = checkStructure({ ...input, refs: [...input.refs].reverse() });
    expect(first.findings.map((f) => `${f.subject}>${f.related}`)).toEqual([
      "char-a>ghost-x",
      "char-a>ghost-y",
      "char-b>ghost-z",
    ]);
    expect(second).toEqual(first);
  });

  it("ch- 前缀（章节引用）不在本轮实体表里：不判悬空，但必须如实登记「未纳入范围」而不是静默放过", () => {
    const input: StructureInput = {
      entities: [card("char-linyuan", "characters")],
      refs: [ref("char-linyuan", "ch-open", "appears_in"), ref("char-linyuan", "ghost-x")],
    };
    const report = checkStructure(input);
    expect(report.findings.map((finding) => finding.related)).toEqual(["ghost-x"]);
    expect(report.outOfScope).toHaveLength(1);
    expect(report.outOfScope[0]!.target).toBe("ch-open");
    expect(report.outOfScope[0]!.reason).toContain("未纳入");
  });
});

describe("ref-cycle 循环依赖", () => {
  const cycleInput = (refs: StructureInput["refs"], ids: string[]): StructureInput => ({
    entities: ids.map((id) => card(id, "characters")),
    refs,
  });
  const cyclesOf = (input: StructureInput) => checkStructure(input).findings.filter((f) => f.rule === "ref-cycle");

  it("自引用 → 一条 error，路径写出 a → a", () => {
    const cycles = cyclesOf(cycleInput([ref("char-a", "char-a")], ["char-a"]));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.severity).toBe("error");
    expect(cycles[0]!.path).toEqual(["char-a", "char-a"]);
    expect(cycles[0]!.evidence).toContain("char-a → char-a");
  });

  it("二元互指只报一次（一个环不因两条边重复出现）", () => {
    const cycles = cyclesOf(cycleInput([ref("char-a", "char-b"), ref("char-b", "char-a")], ["char-a", "char-b"]));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.path).toEqual(["char-a", "char-b", "char-a"]);
  });

  it("三节点环从环内最小 id 起笔（与输入顺序无关）", () => {
    const ring = [ref("char-mid", "char-top"), ref("char-top", "char-low"), ref("char-low", "char-mid")];
    const ids = ["char-top", "char-mid", "char-low"];
    const forward = checkStructure(cycleInput(ring, ids));
    const reversed = checkStructure(cycleInput([...ring].reverse(), [...ids].reverse()));
    expect(forward.findings.filter((f) => f.rule === "ref-cycle")).toHaveLength(1);
    expect(forward.findings[0]!.path).toEqual(["char-low", "char-mid", "char-top", "char-low"]);
    expect(reversed).toEqual(forward);
  });

  it("不该命中：有向无环图（A→B、A→C、B→C）零循环发现", () => {
    const cycles = cyclesOf(
      cycleInput([ref("char-a", "char-b"), ref("char-a", "char-c"), ref("char-b", "char-c")], ["char-a", "char-b", "char-c"]),
    );
    expect(cycles).toEqual([]);
  });

  it("不该命中：两条链汇入同一节点（A→B→C、D→C）", () => {
    const cycles = cyclesOf(
      cycleInput([ref("char-a", "char-b"), ref("char-b", "char-c"), ref("char-d", "char-c")], ["char-a", "char-b", "char-c", "char-d"]),
    );
    expect(cycles).toEqual([]);
  });

  it("同一对节点重复引用不产出两条环", () => {
    const cycles = cyclesOf(
      cycleInput([ref("char-a", "char-b"), ref("char-b", "char-a"), ref("char-a", "char-b", "derived_from")], ["char-a", "char-b"]),
    );
    expect(cycles).toHaveLength(1);
  });

  it("悬空目标不参与成环（指向不存在实体的边只归 ref-dangling）", () => {
    const report = checkStructure({
      entities: [card("char-a", "characters")],
      refs: [ref("char-a", "ghost"), ref("ghost", "char-a")],
    });
    expect(report.findings.map((f) => f.rule).sort()).toEqual(["ref-dangling", "ref-dangling"]);
  });

  it("超长链上的回指：深度上限生效时停止下探并计数，**不假装没有环**", () => {
    const ids = Array.from({ length: 90 }, (_unused, index) => `char-${String(index).padStart(3, "0")}`);
    const chain = ids.slice(1).map((id, index) => ref(ids[index]!, id));
    const closing = ref(ids[ids.length - 1]!, ids[0]!, "closes_loop");
    const report = checkStructure({ entities: ids.map((id) => card(id, "characters")), refs: [...chain, closing] });
    // 第 64 层即停：这个环（长度 90）超出上限，因此不产出环结论，但必须留下计数
    expect(report.findings.filter((f) => f.rule === "ref-cycle")).toEqual([]);
    expect(report.skipped.cycleDepthCapped).toBeGreaterThan(0);
  });

  it("上限之内的环照常报出（深度闸不误伤正常规模）", () => {
    const ids = Array.from({ length: 20 }, (_unused, index) => `char-${String(index).padStart(2, "0")}`);
    const chain = ids.slice(1).map((id, index) => ref(ids[index]!, id));
    const report = checkStructure({
      entities: ids.map((id) => card(id, "characters")),
      refs: [...chain, ref(ids[19]!, ids[0]!)],
    });
    expect(report.findings.filter((f) => f.rule === "ref-cycle")).toHaveLength(1);
    expect(report.skipped.cycleDepthCapped).toBe(0);
  });
});

describe("layer-order-violation 层级倒置", () => {
  it("上游层引用下游层 → error（K05 的例子：地理引用人物）", () => {
    const report = checkStructure({
      entities: [card("geo-qingyun", "geography"), card("char-linyuan", "characters")],
      refs: [ref("geo-qingyun", "char-linyuan", "located_story")],
    });
    const inverted = report.findings.filter((f) => f.rule === "layer-order-violation");
    expect(inverted).toHaveLength(1);
    expect(inverted[0]!.severity).toBe("error");
    expect(inverted[0]!.subject).toBe("geo-qingyun");
    expect(inverted[0]!.evidence).toContain("geography");
    expect(inverted[0]!.evidence).toContain("characters");
    expect(inverted[0]!.evidence).toContain("located_story");
  });

  it("不该命中：下游层引用上游层（人物依存于地理）是正常方向", () => {
    const report = checkStructure({
      entities: [card("char-linyuan", "characters"), card("geo-qingyun", "geography")],
      refs: [ref("char-linyuan", "geo-qingyun", "born_in")],
    });
    expect(report.findings).toEqual([]);
  });

  it("不该命中：同层互引不算倒置（环检测另有其规则）", () => {
    const report = checkStructure({
      entities: [card("char-a", "characters"), card("char-b", "characters")],
      refs: [ref("char-a", "char-b", "ally_of"), ref("char-b", "char-a", "rival_of")],
    });
    expect(report.findings.filter((f) => f.rule === "layer-order-violation")).toEqual([]);
  });

  it("跨度最大的倒置也报（创世层引用章节层）", () => {
    const report = checkStructure({
      entities: [card("law-origin", "genesis"), card("story-final", "storylines")],
      refs: [ref("law-origin", "story-final", "depends_on")],
    });
    expect(report.findings.map((f) => f.rule)).toEqual(["layer-order-violation"]);
  });

  it("层不在 LAYER_KEYS 表内时不判定（不猜层序，也不报倒置）", () => {
    const report = checkStructure({
      entities: [card("x-custom", "custom_layer"), card("char-a", "characters"), card("char-b", "characters")],
      refs: [ref("x-custom", "char-a"), ref("char-b", "x-custom")],
    });
    expect(report.findings).toEqual([]);
  });

  it("目标悬空时只报悬空：没有实体就没有层，不叠加倒置结论", () => {
    const report = checkStructure({
      entities: [card("geo-a", "geography")],
      refs: [ref("geo-a", "char-ghost")],
    });
    expect(report.findings.map((f) => f.rule)).toEqual(["ref-dangling"]);
  });

  it("未启用层的卡不参与倒置判定（与悬空同一道闸）", () => {
    const report = checkStructure({
      entities: [card("geo-a", "geography"), card("char-b", "characters")],
      refs: [ref("geo-a", "char-b")],
      enabledLayers: ["characters"],
    });
    expect(report.findings).toEqual([]);
    expect(report.skipped.disabledLayerEntities).toBe(1);
  });
});

describe("从真源直接校验（不依赖索引库）", () => {
  const cardText = (name: string, refs: Array<{ relation: string; target: string }>, layer = "characters") =>
    createSettingCard({ type: "character", name, layer, aliases: [], refs });

  it("卡文件里的悬空引用被检出，实体与引用计数来自真源", async () => {
    const card = cardText("林渊", [{ relation: "师从", target: "fac-ghost" }]);
    const report = await checkStructureFromSources(
      readerOf({ "world/cards/character/char-linyuan.md": serializeCardFile(card, "边城少年，剑道天赋被夺。") }),
    );
    expect(report.findings.map((f) => [f.rule, f.subject, f.related])).toEqual([["ref-dangling", card.id, "fac-ghost"]]);
    expect(report.checked).toEqual({ entities: 1, refs: 1 });
    expect(report.sources.entities).toBe(1);
  });

  it("world.yaml 关掉某层后，该层的卡整条不参与校验（未启用层不参与校验与传播）", async () => {
    const card = cardText("林渊", [{ relation: "师从", target: "fac-ghost" }]);
    // 用权威写入器造 world.yaml，免得手写格式与 schema 对不上导致解析静默失败
    const world = serializeWorldConfig(
      createWorldConfig({
        title: "天启界",
        id: "world-x",
        genreAxes: {
          channel: ["男频"],
          world: ["玄幻"],
          technique: ["系统流"],
          tone: ["爽文"],
          romance_mode_default: "无女主",
        } as never,
        layers: { characters: false },
      }),
    );
    const report = await checkStructureFromSources(
      readerOf({
        "world/world.yaml": world,
        "world/cards/character/char-linyuan.md": serializeCardFile(card, "正文"),
      }),
    );
    expect(report.worldNote).toBeNull(); // 解析失败会退回"全部启用"，那样这条断言就成了假绿
    expect(report.findings).toEqual([]);
    expect(report.skipped.disabledLayerEntities).toBe(1);
    // 关闭的层要能在结果里看见，否则"零发现"会被读成"结构没问题"
    expect(report.enabledLayers).toContain("factions");
    expect(report.enabledLayers).not.toContain("characters");
  });

  it("没有设定卡的项目返回空报告而不是报错；world.yaml 不合式时如实给出降级说明", async () => {
    const report = await checkStructureFromSources(readerOf({ "world/world.yaml": "apiVersion: yushu.world/v1\nid: w\ntitle: t\n" }));
    expect(report.findings).toEqual([]);
    expect(report.checked).toEqual({ entities: 0, refs: 0 });
    // 极简 world.yaml 缺 genre_axes → 解析失败：按全部层启用，并把这件事写在 worldNote 里
    expect(report.worldNote).toContain("按全部层启用");
    expect(report.enabledLayers).toContain("characters");
  });
});

describe("结构校验的输入边界", () => {
  it("未启用层整条跳过并计数（不把「没跑」当成「没问题」）", () => {
    const input: StructureInput = {
      entities: [card("char-a", "characters"), card("geo-x", "geography"), card("law-y", "laws")],
      refs: [ref("char-a", "ghost-1"), ref("geo-x", "ghost-2"), ref("law-y", "ghost-3")],
      enabledLayers: ["characters"],
    };
    const report = checkStructure(input);
    expect(report.findings.map((f) => f.related)).toEqual(["ghost-1"]);
    expect(report.skipped.disabledLayerEntities).toBe(2);
    expect(report.checked).toEqual({ entities: 3, refs: 3 });
  });

  it("空项目（无实体无引用）不报错、零发现", () => {
    const report = checkStructure({ entities: [], refs: [] });
    expect(report.findings).toEqual([]);
    expect(report.outOfScope).toEqual([]);
    expect(report.checked).toEqual({ entities: 0, refs: 0 });
  });

  it("引用发起方本身不在实体表里（孤儿引用）：仍报悬空并点名主体", () => {
    const report = checkStructure({ entities: [card("char-a", "characters")], refs: [ref("char-ghost-source", "char-a")] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.subject).toBe("char-ghost-source");
    expect(report.findings[0]!.related).toBe("char-a");
  });
});
