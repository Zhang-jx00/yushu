/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import type { GraphViewPayload } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 关系图谱面板（M4 / T4-9，R69）：只读，数据来自真源行表投影（不碰索引库）。
 *
 * 布局是**自算的圆形排布**，不引图形库：节点顺序由引擎保证（码点序），
 * 所以同一份数据每次打开长同一个样子——这是可复现性，不是省事。
 * 半径按节点数自适应，超过 40 个节点只画度数最高的前 40 个并写明"未画"，
 * 因为一张糊成墨点的图等于没有信息。
 */

const NET_COLOR: Record<string, string> = {
  characters: "var(--accent)",
  factions: "var(--good)",
  geography: "var(--warn)",
  other: "var(--muted)",
};

const NET_LABEL: Record<string, string> = {
  characters: "人物",
  factions: "势力",
  geography: "地点",
  other: "未归类",
};

const MAX_DRAWN = 40;

export function RelationGraphPanel() {
  const [graph, setGraph] = useState<GraphViewPayload | null>(null);
  const [focus, setFocus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api()
      .graph.relation(focus === "" ? {} : { focus, maxDepth: 2 })
      .then((result) => {
        if (alive) setGraph(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [focus]);

  const drawn = graph === null ? [] : [...graph.nodes].sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1)).slice(0, MAX_DRAWN);
  const drawnIds = new Set(drawn.map((node) => node.id));
  const drawnEdges = graph === null ? [] : graph.edges.filter((edge) => drawnIds.has(edge.from) && drawnIds.has(edge.to));
  const width = 720;
  const height = 300;
  const radius = Math.min(width, height) / 2 - 34;
  const position = (index: number, total: number) => {
    const angle = total <= 1 ? -Math.PI / 2 : (index / total) * Math.PI * 2 - Math.PI / 2;
    return { x: width / 2 + radius * Math.cos(angle), y: height / 2 + radius * Math.sin(angle) };
  };
  const places = new Map(drawn.map((node, index) => [node.id, position(index, drawn.length)]));

  return (
    <section className="panel graph-panel">
      <div className="panel-title">
        关系图谱（只读 · 由真源直算，不依赖索引库）
        <select className="graph-focus" value={focus} onChange={(event) => setFocus(event.target.value)}>
          <option value="">全图</option>
          {(graph?.nodes ?? []).map((node) => (
            <option key={node.id} value={node.id}>
              聚焦 {node.name}（2 跳内）
            </option>
          ))}
        </select>
      </div>
      {error !== "" && <div className="error-text">{error}</div>}
      {graph !== null && error === "" && (
        <>
          <div className="graph-summary muted">{graph.note}</div>
          {graph.focusMissing && <div className="error-text">聚焦的节点已不存在（可能刚被删或改名），当前画的是空图</div>}
          {drawn.length > 0 && (
            <svg className="graph-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`关系图谱：${drawn.length} 个节点、${drawnEdges.length} 条边`}>
              {drawnEdges.map((edge, index) => {
                const from = places.get(edge.from);
                const to = places.get(edge.to);
                if (!from || !to) return null;
                if (edge.selfLoop) {
                  return <circle key={`${edge.from}-${index}`} cx={from.x} cy={from.y - 10} r={7} className="graph-selfloop" />;
                }
                return <line key={`${edge.from}-${edge.to}-${edge.relation}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={NET_COLOR[edge.net]} strokeWidth={edge.net === "other" ? 1 : 1.5} strokeOpacity={0.55} />;
              })}
              {drawn.map((node) => {
                const at = places.get(node.id);
                if (!at) return null;
                return (
                  <g key={node.id} className="graph-node" onClick={() => setFocus(node.id)}>
                    <circle cx={at.x} cy={at.y} r={Math.min(11, 4 + node.degree)} fill={NET_COLOR[node.net]} fillOpacity={focus === node.id ? 1 : 0.82} />
                    <text x={at.x} y={at.y - 14} textAnchor="middle">
                      {node.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          <div className="graph-legend muted">
            {(["characters", "factions", "geography", "other"] as const).map((net) => (
              <span key={net}>
                <i className="graph-dot" style={{ background: NET_COLOR[net] }} />
                {NET_LABEL[net]} {graph.kinds[net]?.nodes ?? 0} 点 / {graph.kinds[net]?.edges ?? 0} 边
              </span>
            ))}
            {drawn.length < (graph.nodes.length ?? 0) && <span>（只画度数最高的 {drawn.length} 个，共 {graph.nodes.length} 个）</span>}
          </div>
          {graph.dangling.length > 0 && (
            <div className="graph-notices">
              悬空引用 {graph.dangling.length} 条**未成边**：
              {graph.dangling.slice(0, 6).map((item, index) => (
                <span key={`${item.referrer}-${item.target}-${index}`}>
                  {item.referrer} —{item.relation}→ {item.target}
                </span>
              ))}
              {graph.dangling.length > 6 && <span>…（其余 {graph.dangling.length - 6} 条）</span>}
            </div>
          )}
          {graph.unclassifiedRelations.length > 0 && (
            <div className="graph-notices">未归类 relation（归入 other，不猜它属于哪张网）：{graph.unclassifiedRelations.join("、")}</div>
          )}
          {graph.truncated !== null && (
            <div className="graph-notices">
              深度封顶在第 2 跳，下一层还有 {graph.truncated.count} 个未展开：{graph.truncated.frontier.join("、")}
            </div>
          )}
          {graph.isolated.length > 0 && <div className="graph-notices">孤立节点 {graph.isolated.length} 个（一条关系都没有）：{graph.isolated.slice(0, 8).join("、")}{graph.isolated.length > 8 ? "…" : ""}</div>}
        </>
      )}
    </section>
  );
}
