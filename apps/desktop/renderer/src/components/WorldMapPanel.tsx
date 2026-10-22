/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorldMapViewPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { StateNote } from "./StateNote";

/**
 * 世界地图（M5 / T5-1，R120）：**只读**面板。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * ⑥ 地图 = 图片底图 + bounds（坐标是图片像素 / 归一化坐标，**不用经纬度**）；
 * ⑦ 标注即地点卡（点标注能查那张卡）；⑨ 分层可控（**图层独立显隐**）。
 *
 * **这一段只画"坐标空间"**：底图图片由作者上传，属另一段（K08 §3.6 的 `base_image`）。
 * 没有底图时画布仍然成立——它画的是**图片像素边界**这个坐标系本身：
 * 网格局部坐标、标注落点、越界的点被夹到边上并标成虚线环。
 * 画布空着不画，等于把"作者还没上传底图"和"这个项目没有地点"混成同一件事。
 *
 * **图层显隐在渲染层做**（不进 IPC）：切层是纯显示动作，绕一圈主进程就会让每次切层都等一次往返，
 * 动效也就没法跟手。显隐是读者的视角，不是作者的数据。
 *
 * **形状优先于颜色**：地点/政治/事件/行程线各有形状（圆/方/三角/菱形），
 * 色盲读者与黑白打印都还能分得开；颜色只用来做"选中"这一件事。
 */
const LAYER_LABEL: Record<string, string> = {
  base: "底图",
  place: "地名",
  political: "政治",
  event: "事件",
  route: "行程线",
  other: "其他",
};

/** 画布兜底尺寸（没有 base_size 时按 bounds 推；连 bounds 都没有就用这个比例） */
const FALLBACK_CANVAS = { width: 1000, height: 700 };

/** 网格线：五等分，够看出"这是个坐标系"，又不至于密成噪点 */
const GRID_STEPS = 5;

export function WorldMapPanel() {
  const [map, setMap] = useState<WorldMapViewPayload | null>(null);
  const [error, setError] = useState("");
  /** 被隐藏的图层（空 = 全显） */
  const [hidden, setHidden] = useState<string[]>([]);
  /** 选中的标注 id */
  const [selected, setSelected] = useState<string | null>(null);
  /** 地点卡正文（点「打开地点卡」后取回的第一段） */
  const [cardBody, setCardBody] = useState("");
  const [cardError, setCardError] = useState("");
  /** 是否已入场（R122：标注的错峰落位靠它触发） */
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // 下一帧再切到已入场，浏览器才认得出这是一次**状态变化**，过渡才会跑
    // （R109 开屏入场用的就是这一招）。
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let alive = true;
    api()
      .map.view()
      .then((payload) => {
        if (alive) setMap(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 选中一个标注（鼠标与键盘走同一条路） */
  const selectMarker = useCallback((id: string) => {
    setSelected(id);
    setCardBody("");
    setCardError("");
  }, []);

  const toggleLayer = useCallback((kind: string) => {
    setHidden((prev) => (prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind]));
  }, []);

  const canvas = map?.canvas ?? FALLBACK_CANVAS;
  const width = canvas.width > 0 ? canvas.width : FALLBACK_CANVAS.width;
  const height = canvas.height > 0 ? canvas.height : FALLBACK_CANVAS.height;

  const shown = useMemo(
    () => (map?.markers ?? []).filter((marker) => !hidden.includes(marker.layer)),
    [map, hidden],
  );
  const selectedMarker = useMemo(
    () => (map?.markers ?? []).find((marker) => marker.id === selected) ?? null,
    [map, selected],
  );

  /** 打开地点卡：走既有的 `card:read` 通道读卡，取第一段（正文全文在「世界观档案」页） */
  const openPlaceCard = useCallback(async (filePath: string) => {
    setCardError("");
    setCardBody("");
    try {
      const result = await api().card.read(filePath);
      const body = String(result.body ?? "").trim();
      const firstParagraph = body.split(/\n{2,}/).find((part) => part.trim() !== "") ?? "";
      setCardBody(firstParagraph.trim() === "" ? "（这张卡还没有正文）" : firstParagraph.trim());
    } catch (err: unknown) {
      setCardError(`地点卡读不了：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  if (error !== "") {
    return (
      <section className="panel map-panel">
        <div className="panel-title">世界地图（只读 · 由真源直算）</div>
        <div className="error-text">{error}</div>
      </section>
    );
  }
  if (map === null) {
    return (
      <section className="panel map-panel">
        <div className="panel-title">世界地图（只读 · 由真源直算）</div>
        <div className="muted">正在读地图…</div>
      </section>
    );
  }
  if (!map.exists) {
    return (
      <section className="panel map-panel">
        <div className="panel-title">世界地图（只读 · 由真源直算）</div>
        <StateNote kind="empty" title="还没有世界地图">
          {map.note}
        </StateNote>
      </section>
    );
  }

  return (
    <section className="panel map-panel">
      <div className="panel-title">世界地图（只读 · 由真源直算）</div>

      <div className="map-layers" role="group" aria-label="图层显隐">
        {map.layers.length === 0 && <span className="muted">这张图还没有声明图层</span>}
        {map.layers.map((layer) => {
          const on = !hidden.includes(layer.kind);
          return (
            <button
              key={layer.kind}
              type="button"
              className={"map-layer-toggle" + (on ? " is-on" : "")}
              aria-pressed={on}
              onClick={() => toggleLayer(layer.kind)}
            >
              <span className="map-layer-dot" data-layer={layer.kind} aria-hidden="true" />
              {LAYER_LABEL[layer.kind] ?? layer.kind}
              <span className="map-layer-count">{layer.markerCount}</span>
            </button>
          );
        })}
      </div>

      <div className="map-layout">
        <div className="map-canvas-wrap">
          <svg
            className={"map-svg" + (entered ? " is-entered" : "")}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`世界地图坐标空间：${shown.length} 个标注，${map.layers.length} 个图层`}
          >
            {Array.from({ length: GRID_STEPS + 1 }, (_, index) => {
              const x = (width * index) / GRID_STEPS;
              const y = (height * index) / GRID_STEPS;
              return (
                <g key={`grid-${index}`} className="map-grid" aria-hidden="true">
                  <line x1={x} y1={0} x2={x} y2={height} />
                  <line x1={0} y1={y} x2={width} y2={y} />
                </g>
              );
            })}
            {shown.map((marker, index) => {
              const inside = marker.nx >= 0 && marker.nx <= 1 && marker.ny >= 0 && marker.ny <= 1;
              const cx = Math.min(Math.max(marker.nx, 0), 1) * width;
              const cy = Math.min(Math.max(marker.ny, 0), 1) * height;
              const isSelected = marker.id === selected;
              return (
                <g
                  key={marker.id}
                  className="map-marker-in"
                  style={{ "--i": index } as React.CSSProperties}
                >
                <g
                  className={
                    "map-marker" +
                    (isSelected ? " is-selected" : "") +
                    (inside ? "" : " is-outside")
                  }
                  data-layer={marker.layer}
                  data-marker={marker.id}
                  /* 键盘可达（R110）：SVG 里放不了 HTML 按钮 ⇒ 这个 <g> 自己当按钮
                     （role + tabIndex + 回车/空格），并给它一个可读的名字。 */
                  role="button"
                  tabIndex={0}
                  aria-label={`标注 ${marker.label}（${LAYER_LABEL[marker.layer] ?? marker.layer}）`}
                  onClick={() => selectMarker(marker.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectMarker(marker.id);
                    }
                  }}
                >
                  <title>{`${marker.label}（${LAYER_LABEL[marker.layer] ?? marker.layer}）`}</title>
                  <MarkerShape layer={marker.layer} cx={cx} cy={cy} />
                </g>
                </g>
              );
            })}
          </svg>
          <div className="map-caption muted">
            坐标空间：图片像素边界 {map.bounds === null ? "（无有效边界，坐标未产出）" : `${map.bounds.x0},${map.bounds.y0} → ${map.bounds.x1},${map.bounds.y1}`}
            ；底图由作者上传（另做一段）
          </div>
        </div>

        <div className="map-side">
          {selectedMarker === null ? (
            <div className="muted">点一个标注查它的地点卡</div>
          ) : (
            <div className="map-card">
              <div className="map-card-name">{selectedMarker.card?.name ?? selectedMarker.entityName}</div>
              <div className="map-card-meta muted">
                {selectedMarker.entityRef} · {LAYER_LABEL[selectedMarker.layer] ?? selectedMarker.layer}
                {selectedMarker.card === null ? " · 绑定的实体已不存在" : ` · ${selectedMarker.card.type}`}
              </div>
              {selectedMarker.card !== null && selectedMarker.card.aliases.length > 0 && (
                <div className="map-card-meta muted">别名：{selectedMarker.card.aliases.join(" / ")}</div>
              )}
              {selectedMarker.card !== null && (
                <button
                  type="button"
                  className="map-card-open"
                  onClick={() => {
                    void openPlaceCard(selectedMarker.card?.filePath ?? "");
                  }}
                >
                  打开地点卡
                </button>
              )}
              {cardError !== "" && <div className="error-text">{cardError}</div>}
              {cardBody !== "" && <div className="map-card-body">{cardBody}</div>}
            </div>
          )}
          <div className="map-summary muted">{map.note}</div>
          {map.findings.length > 0 && (
            <ul className="map-findings">
              {map.findings.map((finding, index) => (
                <li key={`${finding.code}-${index}`} className={"map-finding " + finding.severity}>
                  <span className="map-finding-code">{finding.code}</span>
                  <span className="map-finding-text">{finding.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** 按图层换形状：形状优先于颜色（色盲与黑白打印都还能分得开） */
function MarkerShape({ layer, cx, cy }: { layer: string; cx: number; cy: number }) {
  if (layer === "political") return <rect x={cx - 7} y={cy - 7} width={14} height={14} rx={2} />;
  if (layer === "event") return <polygon points={`${cx},${cy - 8} ${cx + 8},${cy + 7} ${cx - 8},${cy + 7}`} />;
  if (layer === "route") return <polygon points={`${cx},${cy - 8} ${cx + 8},${cy} ${cx},${cy + 8} ${cx - 8},${cy}`} />;
  if (layer === "base") return <rect x={cx - 5} y={cy - 5} width={10} height={10} rx={1} />;
  return <circle cx={cx} cy={cy} r={7} />;
}
