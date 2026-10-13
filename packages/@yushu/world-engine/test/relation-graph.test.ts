import { describe, expect, it } from "vitest";
import { buildRelationGraph, type IndexEntityRow, type IndexRefRow } from "@yushu/world-engine";

/**
 * 关系图谱（M4 / T4-9 引擎侧，R69）。
 *
 * 输入就是 T4-2 / T4-5 已经在用的 `entities` / `refs` 两张真源行表——**不长第二套图结构**，
 * 图谱只是它们的一个投影。钉住四件事：
 * ① 悬空引用**不算边但逐条点名**（悄悄丢边会让"关系少"看起来像"关系没问题"）；
 * ② relation 名认不出归类时**进 `other` 并计数**，不猜它是人物关系还是势力关系；
 * ③ 聚焦子图的深度封顶**如实给被砍掉的下一层**（同 propagate 的口径）；
 * ④ 同输入同输出：节点与边全走码点序。
 */

const ent = (id: string, type: string, layer: string, name = id): IndexEntityRow => ({
  id,
  type,
  layer,
  name,
  aliases: [],
  visibility: "hidden",
  filePath: `world/cards/${type}/${id}.md`,
});

const ref = (referrer: string, relation: string, target: string): IndexRefRow => ({ referrer, relation, target });

const CHARACTERS = [ent("char-a", "character", "characters", "甲"), ent("char-b", "character", "characters", "乙"), ent("char-c", "character", "characters", "丙")];
const FACTIONS = [ent("sect-x", "sect", "factions", "剑派"), ent("sect-y", "sect", "factions", "刀派")];
const PLACES = [ent("geo-city", "place", "geography", "城"), ent("geo-peak", "place", "geography", "峰")];
const ALL = [...CHARACTERS, ...FACTIONS, ...PLACES];

describe("buildRelationGraph（三张网由真源直算）", () => {
  it("人物 / 势力 / 地点三张网各自成簇，kind 由 relation 名决定", () => {
    const graph = buildRelationGraph(ALL, [
      ref("char-a", "member_of", "sect-x"),
      ref("sect-x", "located_in", "geo-city"),
      ref("char-a", "rival_of", "char-b"),
    ]);
    expect(graph.kinds.characters.edges).toBe(1);
    expect(graph.kinds.factions.edges).toBe(1);
    expect(graph.kinds.geography.edges).toBe(1);
    expect(graph.kinds.characters.nodes).toBe(2);
  });

  it("认不出的 relation 归 other 并计数，不猜它属于哪张网", () => {
    const graph = buildRelationGraph(ALL, [ref("char-a", "weird_link", "char-b")]);
    expect(graph.kinds.other.edges).toBe(1);
    expect(graph.kinds.characters.edges).toBe(0);
    expect(graph.unclassifiedRelations).toEqual(["weird_link"]);
  });

  it("两端存在才成边；悬空引用逐条进 dangling，不静默丢", () => {
    const graph = buildRelationGraph(ALL, [
      ref("char-a", "rival_of", "char-b"),
      ref("char-a", "rival_of", "char-ghost"),
    ]);
    expect(graph.edges.length).toBe(1);
    expect(graph.dangling.length).toBe(1);
    expect(graph.dangling[0]?.target).toBe("char-ghost");
  });

  it("重复边（同 from/to/relation）只留一条并计数", () => {
    const graph = buildRelationGraph(ALL, [
      ref("char-a", "rival_of", "char-b"),
      ref("char-a", "rival_of", "char-b"),
    ]);
    expect(graph.edges.length).toBe(1);
    expect(graph.duplicateEdges).toBe(1);
  });

  it("自环保留并标记（自己指自己不是画错，是数据问题，得看见）", () => {
    const graph = buildRelationGraph(ALL, [ref("char-a", "rival_of", "char-a")]);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.selfLoop).toBe(true);
  });

  it("degree 如实统计，孤立节点单独列出", () => {
    const graph = buildRelationGraph(ALL, [ref("char-a", "rival_of", "char-b"), ref("char-b", "rival_of", "char-c")]);
    expect(graph.nodes.find((n) => n.id === "char-b")?.degree).toBe(2);
    expect(graph.nodes.find((n) => n.id === "char-a")?.degree).toBe(1);
    expect(graph.isolated.sort()).toEqual(["geo-city", "geo-peak", "sect-x", "sect-y"]);
  });

  it("聚焦子图：只取 maxDepth 跳内可达，被砍的下一层如实点名", () => {
    const chain = [ent("c1", "character", "characters"), ent("c2", "character", "characters"), ent("c3", "character", "characters"), ent("c4", "character", "characters")];
    const refs = [ref("c1", "rival_of", "c2"), ref("c2", "rival_of", "c3"), ref("c3", "rival_of", "c4")];
    const graph = buildRelationGraph(chain, refs, { focus: "c1", maxDepth: 1 });
    expect(graph.nodes.map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(graph.truncated).not.toBeNull();
    expect(graph.truncated?.frontier).toEqual(["c3"]);
    expect(graph.truncated?.count).toBe(1);
  });

  it("聚焦到不存在的节点 ⇒ 空图 + 悬空提示，不抛错也不画全图", () => {
    const graph = buildRelationGraph(ALL, [ref("char-a", "rival_of", "char-b")], { focus: "char-nope" });
    expect(graph.nodes).toEqual([]);
    expect(graph.focusMissing).toBe(true);
  });

  it("确定性：节点与边按码点序，同输入两次逐字一致", () => {
    const refs = [ref("char-c", "rival_of", "char-a"), ref("char-a", "rival_of", "char-b"), ref("sect-y", "located_in", "geo-peak")];
    const first = buildRelationGraph(ALL, refs);
    const second = buildRelationGraph(ALL, [...refs].reverse());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["char-a>char-b", "char-c>char-a", "sect-y>geo-peak"]);
  });

  it("自定义 relation→网 的映射覆盖内置表", () => {
    const graph = buildRelationGraph(ALL, [ref("char-a", "rival_of", "char-b")], {
      relationKinds: { rival_of: "geography" },
    });
    expect(graph.kinds.geography.edges).toBe(1);
    expect(graph.kinds.characters.edges).toBe(0);
  });

  it("空项目：0 节点 0 边，不报错", () => {
    const graph = buildRelationGraph([], []);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.isolated).toEqual([]);
  });
});
