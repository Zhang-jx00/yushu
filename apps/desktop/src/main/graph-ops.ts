/* SPDX-License-Identifier: Apache-2.0 */
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
  // 汇总的**结构化行**（R126）：界面逐行渲染 ⇒ 窄栏里不会折成三四行。
  // 结构由**后端给**（不在界面里切字符串——切出来的项会丢掉句子里的限定词）。
  const summary = [
    { label: "实体", value: `${structure.entities.length} 个` },
    { label: "引用行", value: `${structure.refs.length} 条` },
    { label: "边", value: `${graph.edges.length} 条` },
    { label: "视图", value: focusOn ? `聚焦「${request.focus}」${maxDepth} 跳内` : "全图" },
    {
      label: "悬空引用",
      value: graph.dangling.length > 0 ? `${graph.dangling.length} 条未成边` : "无",
    },
  ];
  if (graph.unclassifiedRelations.length > 0) {
    summary.push({
      label: "未归类",
      value: `${graph.unclassifiedRelations.length} 种 relation 归入 other`,
    });
  }
  return {
    note,
    summary,
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
