import type { IndexEntityRow, IndexRefRow } from "./index-input.js";

/**
 * 关系图谱（M4 / T4-9 引擎侧，R69）。
 *
 * 输入是 T4-2 / T4-5 已经在用的 `entities` / `refs` 两张真源行表——**图谱只是它们的一个投影，
 * 不长第二套图结构**（再建一张"关系表"就等于给同一件事两个答案）。
 * 输出也不落盘：视图直接吃这个结果，删掉索引库照样算得出来（M4 验收 A5 的口径）。
 *
 * 三条不猜：
 * ① 两端有一端不存在 ⇒ **不成边**，但逐条进 `dangling`——悄悄丢边会让"关系少"看起来像"没问题"；
 * ② relation 名不在映射表里 ⇒ 归 `other` 并把名字列进 `unclassifiedRelations`，
 *    不猜它属于人物网还是势力网（猜错的代价是图谱上出现一条误导性的簇）；
 * ③ 聚焦子图深度封顶 ⇒ `truncated` 给出被砍掉的**下一层**，不是"下面没有了"。
 */

export type GraphNetKind = "characters" | "factions" | "geography" | "other";

/** 内置 relation → 网 的映射；界面与作者都能用 `relationKinds` 覆盖（数据驱动，不改代码换分类） */
export const DEFAULT_RELATION_KINDS: Record<string, GraphNetKind> = {
  rival_of: "characters",
  ally_of: "characters",
  kin_of: "characters",
  mentor_of: "characters",
  loves: "characters",
  member_of: "factions",
  leads: "factions",
  allied_with: "factions",
  at_war_with: "factions",
  located_in: "geography",
  controls: "geography",
  borders: "geography",
  originates_from: "geography",
};

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  layer: string;
  filePath: string;
  net: GraphNetKind;
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  net: GraphNetKind;
  selfLoop: boolean;
}

export interface GraphOptions {
  /** 聚焦节点 id（省略 = 全图） */
  focus?: string;
  /** 聚焦时的跳数上限（缺省 2） */
  maxDepth?: number;
  /** 覆盖 / 扩展内置的 relation → 网 映射 */
  relationKinds?: Record<string, GraphNetKind>;
}

export interface RelationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  kinds: Record<GraphNetKind, { nodes: number; edges: number }>;
  dangling: IndexRefRow[];
  unclassifiedRelations: string[];
  isolated: string[];
  duplicateEdges: number;
  selfLoops: number;
  focusMissing: boolean;
  truncated: { frontier: string[]; count: number } | null;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 节点属于哪张网：优先按实体自身类型（比 relation 更稳），认不出归 other */
function nodeNet(entity: IndexEntityRow): GraphNetKind {
  if (["character", "person"].includes(entity.type) || entity.layer === "characters") return "characters";
  if (["sect", "faction", "organization"].includes(entity.type) || entity.layer === "factions") return "factions";
  if (["place", "region", "city"].includes(entity.type) || entity.layer === "geography") return "geography";
  return "other";
}

export function buildRelationGraph(
  entities: IndexEntityRow[],
  refs: IndexRefRow[],
  options: GraphOptions = {},
): RelationGraph {
  const kindsMap = { ...DEFAULT_RELATION_KINDS, ...(options.relationKinds ?? {}) };
  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  const seenEdge = new Set<string>();
  const edges: GraphEdge[] = [];
  const dangling: IndexRefRow[] = [];
  const unclassified = new Set<string>();
  let duplicateEdges = 0;
  let selfLoops = 0;

  for (const row of refs) {
    const from = byId.get(row.referrer);
    const to = byId.get(row.target);
    if (!from || !to) {
      dangling.push({ referrer: row.referrer, relation: row.relation, target: row.target });
      continue;
    }
    const key = `${row.referrer}\u0000${row.target}\u0000${row.relation}`;
    if (seenEdge.has(key)) {
      duplicateEdges += 1;
      continue;
    }
    seenEdge.add(key);
    let net = kindsMap[row.relation];
    if (net === undefined) {
      net = "other";
      unclassified.add(row.relation);
    }
    const selfLoop = row.referrer === row.target;
    if (selfLoop) selfLoops += 1;
    edges.push({ from: row.referrer, to: row.target, relation: row.relation, net, selfLoop });
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    if (!edge.selfLoop) degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const focus = options.focus;
  let keepNodes: Set<string> | null = null;
  let truncated: RelationGraph["truncated"] = null;
  let focusMissing = false;

  if (focus !== undefined && focus !== "") {
    if (!byId.has(focus)) {
      focusMissing = true;
      keepNodes = new Set();
    } else {
      const maxDepth = options.maxDepth ?? 2;
      const adjacency = new Map<string, Set<string>>();
      for (const edge of edges) {
        if (edge.selfLoop) continue;
        (adjacency.get(edge.from) ?? adjacency.set(edge.from, new Set()).get(edge.from)!).add(edge.to);
        (adjacency.get(edge.to) ?? adjacency.set(edge.to, new Set()).get(edge.to)!).add(edge.from);
      }
      const depth = new Map<string, number>([[focus, 0]]);
      let frontier = [focus];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const neighbor of [...(adjacency.get(id) ?? [])].sort(byCodePoint)) {
            if (depth.has(neighbor)) continue;
            depth.set(neighbor, (depth.get(id) as number) + 1);
            next.push(neighbor);
          }
        }
        frontier = next;
      }
      const kept = new Set<string>();
      const cut = new Set<string>();
      for (const [id, d] of depth) {
        if (d <= maxDepth) kept.add(id);
        else if (d === maxDepth + 1) cut.add(id);
      }
      keepNodes = kept;
      truncated = cut.size > 0 ? { frontier: [...cut].sort(byCodePoint), count: cut.size } : null;
    }
  }

  const visibleEdges = (keepNodes === null ? edges : edges.filter((edge) => keepNodes.has(edge.from) && keepNodes.has(edge.to)));
  const visibleNodes = [...byId.values()]
    .filter((entity) => (keepNodes === null ? true : keepNodes.has(entity.id)))
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      layer: entity.layer,
      filePath: entity.filePath,
      net: nodeNet(entity),
      degree: degree.get(entity.id) ?? 0,
    }))
    .sort((a, b) => byCodePoint(a.id, b.id));
  visibleEdges.sort((a, b) => byCodePoint(`${a.from}\u0000${a.to}\u0000${a.relation}`, `${b.from}\u0000${b.to}\u0000${b.relation}`));

  const kinds = {
    characters: { nodes: 0, edges: 0 },
    factions: { nodes: 0, edges: 0 },
    geography: { nodes: 0, edges: 0 },
    other: { nodes: 0, edges: 0 },
  } as Record<GraphNetKind, { nodes: number; edges: number }>;
  // 每张网的节点数 = 该网边集里真的连着的端点，不是"该类型的实体总数"——
  // 孤立角色留在人物网里计数会把"关系稀疏"洗成"网络很大"
  const netEndpoints: Record<GraphNetKind, Set<string>> = {
    characters: new Set(),
    factions: new Set(),
    geography: new Set(),
    other: new Set(),
  };
  for (const edge of visibleEdges) {
    kinds[edge.net].edges += 1;
    netEndpoints[edge.net].add(edge.from);
    netEndpoints[edge.net].add(edge.to);
  }
  for (const net of Object.keys(kinds) as GraphNetKind[]) kinds[net].nodes = netEndpoints[net].size;

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    kinds,
    dangling: dangling.sort((a, b) => byCodePoint(`${a.referrer}\u0000${a.target}`, `${b.referrer}\u0000${b.target}`)),
    unclassifiedRelations: [...unclassified].sort(byCodePoint),
    isolated: visibleNodes.filter((node) => node.degree === 0).map((node) => node.id).sort(byCodePoint),
    duplicateEdges,
    selfLoops,
    focusMissing,
    truncated,
  };
}
