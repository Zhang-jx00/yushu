import { buildRelationGraph, checkStructureFromSources } from "@yushu/world-engine";
import type { GraphViewPayload, GraphViewRequestPayload } from "../shared/ipc.js";
import { gatewayReader } from "./index-ops.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 关系图谱的桌面接线（M4 / T4-9，R69）：**只读，且只读真源**。
 *
 * 数据源是 `checkStructureFromSources`——它从设定卡与正文直算 `entities` / `refs` 两张行表，
 * **不碰 SQLite**。这不是顺手复用，而是 M4 验收 A5 的正面回答：删掉 `.yushu/` 下那份派生索引之后，
 * 图谱与时间线照样画得出来，退化的只有检索。图谱也不长自己的存储：它是那两张表的一次投影。
 */

export async function relationGraphView(
  gateway: ProjectGateway,
  request: GraphViewRequestPayload = {},
): Promise<GraphViewPayload> {
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const maxDepth = Number.isInteger(request.maxDepth) && (request.maxDepth as number) > 0
    ? (request.maxDepth as number)
    : 2;
  const graph = buildRelationGraph(structure.entities, structure.refs, {
    ...(request.focus === undefined || request.focus === "" ? {} : { focus: request.focus }),
    maxDepth,
  });
  const focusOn = request.focus !== undefined && request.focus !== "";
  const note = [
    `${structure.entities.length} 个实体 · ${structure.refs.length} 条引用行 → ${graph.edges.length} 条边`,
    focusOn ? `聚焦「${request.focus}」${maxDepth} 跳内` : "全图",
    graph.dangling.length > 0 ? `悬空引用 ${graph.dangling.length} 条未成边` : "无悬空引用",
    graph.unclassifiedRelations.length > 0 ? `未归类 relation ${graph.unclassifiedRelations.length} 种归入 other` : "",
  ]
    .filter((part) => part !== "")
    .join("；");
  return {
    note,
    focus: focusOn ? (request.focus as string) : null,
    maxDepth,
    nodes: graph.nodes,
    edges: graph.edges,
    kinds: graph.kinds,
    dangling: graph.dangling,
    unclassifiedRelations: graph.unclassifiedRelations,
    isolated: graph.isolated,
    duplicateEdges: graph.duplicateEdges,
    selfLoops: graph.selfLoops,
    focusMissing: graph.focusMissing,
    truncated: graph.truncated,
  };
}
