import { describe, expect, it } from "vitest";
import { propagate } from "@yushu/world-engine";
import type { IndexEntityRow, IndexRefRow } from "@yushu/world-engine";

/**
 * 影响传播的反向遍历（M4 / T4-5 引擎侧，R60）。
 *
 * 钉住五件事，每件都对应一种"作者会被误导"的情形：
 * ① **只沿反向边**走（谁引用了我），正向边不算——否则改一条法则会把法则自己引用的东西也算成受影响；
 * ② 深度封顶**如实点名**被截断的节点与条数——封顶是省算力，不是"下面没有了"；
 * ③ 成环**阻断并给出环路径**，不返回半成品清单（半张传播表比没有更危险，作者会以为那就是全部）；
 * ④ 权重衰减**没定义的边按 1 计并标 assumed**——编一个权重等于把"这条边影响小"写成事实；
 * ⑤ 同一输入两次调用**逐字一致**（含 proposalId），排序走码点序。
 */

const entity = (id: string, layer: string): IndexEntityRow => ({
  id,
  type: "law",
  layer,
  name: id,
  aliases: [],
  visibility: "public",
  filePath: `world/cards/${layer}/${id}.md`,
});

const ref = (referrer: string, relation: string, target: string): IndexRefRow => ({ referrer, relation, target });

const CHAIN = {
  entities: [
    entity("law-l1", "laws"),
    entity("geo-l2", "geography"),
    entity("civ-l3", "factions"),
    entity("char-l4", "characters"),
    entity("item-l5", "items"),
    entity("law-other", "laws"),
  ],
  refs: [
    ref("geo-l2", "依存", "law-l1"),
    ref("civ-l3", "遵循", "geo-l2"),
    ref("char-l4", "隶属", "civ-l3"),
    ref("item-l5", "出自", "char-l4"),
    // 正向边：被改实体自己引用别人，不算受影响
    ref("law-l1", "补充", "law-other"),
  ],
};

describe("propagate 反向 BFS", () => {
  it("只走反向边，深度决定级别与路径", () => {
    const out = propagate({ entity: "law-l1", field: "content" }, CHAIN);
    expect(out.impact.map((row) => [row.entity, row.depth, row.severity])).toEqual([
      ["geo-l2", 1, "error"],
      ["civ-l3", 2, "warn"],
      ["char-l4", 3, "info"],
    ]);
    expect(out.impact[2]?.path).toEqual(["law-l1", "geo-l2", "civ-l3", "char-l4"]);
    expect(out.status).toBe("awaiting_confirmation");
  });

  it("深度封顶时点名被截断的下一层节点（不假装下面没有了）", () => {
    const out = propagate({ entity: "law-l1", field: "content" }, CHAIN, { maxDepth: 2 });
    expect(out.impact.map((row) => row.entity)).toEqual(["geo-l2", "civ-l3"]);
    expect(out.truncated).not.toBeNull();
    // 报的是"封顶处被砍掉的那一层"，不是整棵未展开子树——传递闭包要全图走一遍，成本与收益不成比例
    expect(out.truncated?.frontier).toEqual(["char-l4"]);
    expect(out.truncated?.count).toBe(1);
  });

  it("成环阻断并给出环路径，impact 不给半成品", () => {
    const cyclic = {
      entities: [entity("a", "laws"), entity("b", "laws")],
      refs: [ref("a", "引用", "b"), ref("b", "引用", "a")],
    };
    const out = propagate({ entity: "a", field: "content" }, cyclic);
    expect(out.status).toBe("blocked");
    expect(out.cycle).toEqual(["a", "b", "a"]);
    expect(out.impact).toEqual([]);
  });

  it("自环同样按环处理（不靠运气终止）", () => {
    const selfRef = {
      entities: [entity("dup", "laws")],
      refs: [ref("dup", "指向", "dup")],
    };
    const out = propagate({ entity: "dup", field: "content" }, selfRef);
    expect(out.status).toBe("blocked");
    expect(out.cycle).toEqual(["dup", "dup"]);
  });

  it("权重按边累乘；没定义的边按 1 计并标 assumed", () => {
    const out = propagate({ entity: "law-l1", field: "content" }, CHAIN, {
      weights: { 依存: 1, 遵循: 0.5 },
    });
    expect(out.impact[0]?.weight).toBeCloseTo(1);
    expect(out.impact[1]?.weight).toBeCloseTo(0.5);
    expect(out.impact[2]?.weight).toBeCloseTo(0.5);
    expect(out.impact[2]?.weightAssumed).toBe(true);
    expect(out.impact[0]?.weightAssumed).toBe(false);
    // 只列**真的走过**的无权重边；被封顶没走到的那条（出自）不算
    expect(out.assumedRelations).toEqual(["隶属"]);
  });

  it("同输入两次调用逐字一致（含 proposalId）；改不同字段是另一份提案", () => {
    const first = propagate({ entity: "law-l1", field: "content" }, CHAIN);
    const second = propagate({ entity: "law-l1", field: "content" }, CHAIN);
    expect(second).toEqual(first);
    const otherField = propagate({ entity: "law-l1", field: "title" }, CHAIN);
    expect(otherField.proposalId).not.toBe(first.proposalId);
  });

  it("多个受影响者按码点序排（不用 localeCompare，换机器不换序）", () => {
    const many = {
      entities: [entity("law-l1", "laws"), entity("a", "laws"), entity("B", "laws"), entity("中", "laws")],
      refs: [ref("a", "依存", "law-l1"), ref("B", "依存", "law-l1"), ref("中", "依存", "law-l1")],
    };
    const out = propagate({ entity: "law-l1", field: "content" }, many);
    expect(out.impact.map((row) => row.entity)).toEqual(["B", "a", "中"]);
  });

  it("改的实体不存在时报错，而不是返回空清单冒充「没有影响」", () => {
    expect(() => propagate({ entity: "ghost", field: "content" }, CHAIN)).toThrow(/不在设定索引/);
  });
});
