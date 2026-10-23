/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { SummaryRow, WorldMapBasePayload, WorldMapViewPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { StateNote } from "./StateNote";
import { SummaryRows } from "./SummaryRows";

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

/**
 * 世界地图面板（M5 / T5-1，R120）。
 *
 * **联动几个 props 都是必填**（R132 时空联动 / R133 地点联动）：
 * - `linkedEvent`：被选中的事件 ⇒ 对应的锚点高亮；
 * - `linkedPlace`：被选中的地点实体 id ⇒ 对应的标注高亮；
 * - `onAnchorPick`：点锚点 ⇒ 上报它挂的事件（父组件去时间线那边定位）；
 * - `onMarkerPick`：点标注 ⇒ 上报它绑的地点实体（父组件知道那条事件在这个地点）；
 * - `onAnchors`：把锚点清单上报给父组件（父组件要知道哪个事件在地图上）；
 * - `onPlaces`：把地图上的地点实体清单上报给父组件（父组件据此判断"这个地点在地图上"）。
 *
 * 为什么必填而不是可选：锚点**始终**是键盘可达的按钮（契约 §6 的键盘债是 0），
 * 若"有时能点有时不能点"，扫描器与作者都要靠猜 ⇒ 这里让组件只有一个形态。
 */
export function WorldMapPanel(props: {
  /** 被选中的事件（时间线那边点过来的）⇒ 对应的锚点高亮 */
  linkedEvent: string | null;
  /** 被选中的地点实体 id ⇒ 对应的标注高亮 */
  linkedPlace: string | null;
  /** 点锚点 ⇒ 上报它挂的事件（父组件去时间线那边定位） */
  onAnchorPick: (eventRef: string) => void;
  /** 点标注 ⇒ 上报它绑的地点实体（父组件据此知道"这个地点在时间线上"） */
  onMarkerPick: (entityRef: string, entityName: string) => void;
  /** 锚点清单上报给父组件（父组件要知道哪个事件在地图上） */
  onAnchors: (anchors: { id: string; eventRef: string }[]) => void;
  /** 地图上的地点实体清单上报给父组件 */
  onPlaces: (entityRefs: string[]) => void;
}) {
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
  /** 底图（R123）：作者登记的那张图，读成 data URL 铺在坐标空间上 */
  const [base, setBase] = useState<WorldMapBasePayload | null>(null);

  useEffect(() => {
    // 下一帧再切到已入场，浏览器才认得出这是一次**状态变化**，过渡才会跑
    // （R109 开屏入场用的就是这一招）。
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let alive = true;
    api()
      .map.base()
      .then((payload) => {
        if (alive) setBase(payload);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
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

  /**
   * R135 底图登记（作者的入口）：挑一张图 ⇒ 拷进项目 ⇒ **边界按量出来的像素尺寸自动填**。
   *
   * 为什么值得做这一步：作者手填 `bounds` 填不对是常态（`map-bounds-missing` 那条诊断码就是这么来的）
   * ⇒ 让工具量 ⇒ 作者填不错。
   */
  const [uploadNote, setUploadNote] = useState("");
  const [uploadSnippet, setUploadSnippet] = useState<string | null>(null);
  /** 换底图（R136）时**换之前**的那三行 ⇒ 作者想换回去，把它们贴回去即可 */
  const [uploadPrevious, setUploadPrevious] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  /** 重新取数（地图 + 底图）：登记完底图要立刻看见它 */
  const reloadMap = useCallback(() => {
    void api()
      .map.view()
      .then((payload) => setMap(payload))
      .catch(() => undefined);
    void api()
      .map.base()
      .then((payload) => setBase(payload))
      .catch(() => undefined);
  }, []);

  const uploadBase = useCallback(async () => {
    setUploading(true);
    setUploadNote("");
    setUploadSnippet(null);
    setUploadPrevious([]);
    try {
      // 已经有底图登记 ⇒ 这一下就是**换**（作者点了"换底图"）；否则是**第一次登记**
      const hasBase = base !== null && base.exists;
      const result = await api().map.uploadBase({ mode: hasBase ? "replace" : "register" });
      setUploadNote(result.note);
      setUploadSnippet(result.snippet);
      setUploadPrevious(result.previous);
      if (!result.canceled) reloadMap();
    } catch (err: unknown) {
      setUploadNote(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, [base, reloadMap]);

  /**
   * R138 **框定边界**（口径回源 K08 §3.6「地图 = 图片底图 + bounds → 用户上传底图并**框定 bounds**」）。
   *
   * 作者的大图往往只有**中间一块**是地图 ⇒ 边界要能**框**，不能一律按整张图算
   * （R135 的登记底图把 bounds 按量出来的尺寸自动填 = 整张图，那只是"第一步"）。
   *
   * 三条口径：
   * ① **框定模式画的是整张图**（不是当前那一块）——否则作者在已裁切的画面上拖，
   *    永远框不到图外的地方；当前框用虚线画出来，他看得见自己框到哪了。
   * ② **键盘也能框**：方向键移动框（Shift = 细调）、`+`/`-` 改大小、回车定下来。
   *    拖拽只是"快"的那条路，不是唯一的路（契约 §6：键盘债是 0）。
   * ③ **只改 `bounds` 那一行**（写盘在主进程做，见 `setMapBounds`）⇒ 标注、图层、锚点原样留着。
   */
  const [framing, setFraming] = useState(false);
  /** 框定中的那一块（工作区：鼠标拖与键盘改都改它） */
  const [frameRect, setFrameRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [frameNote, setFrameNote] = useState("");
  const [framingBusy, setFramingBusy] = useState(false);
  /** 拖拽起点（SVG 用户坐标 = 底图像素） */
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const canvas = map?.canvas ?? FALLBACK_CANVAS;
  // R138：画布 = **作者框定的那一块**（bounds 那一块）；底图按它裁切显示
  const frame = map?.bounds ?? null;
  const frameW = frame === null ? canvas.width : frame.x1 - frame.x0;
  const frameH = frame === null ? canvas.height : frame.y1 - frame.y0;
  // 底图**声明**的像素尺寸（框定模式画整张图 ⇒ 拖出来的坐标就是底图像素坐标）
  const baseW = map?.baseSize?.width ?? (frameW > 0 ? frameW : FALLBACK_CANVAS.width);
  const baseH = map?.baseSize?.height ?? (frameH > 0 ? frameH : FALLBACK_CANVAS.height);
  // 视图尺寸：框定模式 = 整张底图；平时 = 框定的那一块
  const width = framing ? baseW : frameW > 0 ? frameW : FALLBACK_CANVAS.width;
  const height = framing ? baseH : frameH > 0 ? frameH : FALLBACK_CANVAS.height;
  // 底图在视图里的位置：平时按框裁切（往左挪 -x0）；框定模式 = 整张图
  const imageX = framing ? 0 : -(frame?.x0 ?? 0);
  const imageY = framing ? 0 : -(frame?.y0 ?? 0);
  /** 有没有底图尺寸可依（没有 base_size ⇒ 框不出范围，入口不给按） */
  const hasBaseSize = map?.baseSize != null;

  /** 进入/退出框定模式：进来时把当前那一块放进工作区（虚线画出来，他看得见自己框到哪了） */
  const toggleFraming = useCallback(() => {
    setFrameNote("");
    if (framing) {
      setFraming(false);
      setFrameRect(null);
      return;
    }
    setFrameRect(
      frame === null
        ? { x0: 0, y0: 0, x1: baseW, y1: baseH }
        : { x0: frame.x0, y0: frame.y0, x1: frame.x1, y1: frame.y1 },
    );
    setFraming(true);
  }, [framing, frame, baseW, baseH]);

  /** 把工作区里那一块写进 map.yaml（**只改 bounds 那一行**；范围由主进程校验、冲突由主进程报） */
  const commitFrame = useCallback(
    async (rect: { x0: number; y0: number; x1: number; y1: number }) => {
      if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) {
        setFrameNote("框太小了（按住拖一小块再松手）");
        return;
      }
      setFramingBusy(true);
      try {
        const result = await api().map.setBounds({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 });
        setFrameNote(result.note);
        if (result.ok) {
          setFraming(false);
          setFrameRect(null);
          reloadMap();
        }
      } catch (err: unknown) {
        setFrameNote(err instanceof Error ? err.message : String(err));
      } finally {
        setFramingBusy(false);
      }
    },
    [reloadMap],
  );

  /** SVG 客户端坐标 ⇒ 用户坐标（框定模式下用户坐标 = 底图像素） */
  const toImagePoint = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const ctm = svg.getScreenCTM();
    if (ctm === null) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const onFramePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!framing) return;
      const p = toImagePoint(event);
      if (p === null) return;
      dragStart.current = p;
      setFrameRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    },
    [framing, toImagePoint],
  );

  const onFramePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!framing || dragStart.current === null) return;
      const p = toImagePoint(event);
      if (p === null) return;
      const s = dragStart.current;
      setFrameRect({
        x0: Math.min(s.x, p.x),
        y0: Math.min(s.y, p.y),
        x1: Math.max(s.x, p.x),
        y1: Math.max(s.y, p.y),
      });
    },
    [framing, toImagePoint],
  );

  const onFramePointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!framing) return;
      const start = dragStart.current;
      dragStart.current = null;
      if (start === null) return;
      const p = toImagePoint(event);
      if (p === null) return;
      void commitFrame({
        x0: Math.min(start.x, p.x),
        y0: Math.min(start.y, p.y),
        x1: Math.max(start.x, p.x),
        y1: Math.max(start.y, p.y),
      });
    },
    [framing, toImagePoint, commitFrame],
  );

  /** 键盘框定：方向键移动、`+`/`-` 改大小、回车定下来（契约 §6：键盘债是 0） */
  const onFrameKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (!framing) return;
      const current = frameRect;
      if (current === null) return;
      const step = event.shiftKey ? 1 : 10;
      let next = current;
      if (event.key === "ArrowLeft") next = { ...current, x0: current.x0 - step, x1: current.x1 - step };
      else if (event.key === "ArrowRight") next = { ...current, x0: current.x0 + step, x1: current.x1 + step };
      else if (event.key === "ArrowUp") next = { ...current, y0: current.y0 - step, y1: current.y1 - step };
      else if (event.key === "ArrowDown") next = { ...current, y0: current.y0 + step, y1: current.y1 + step };
      else if (event.key === "+" || event.key === "=") {
        next = { x0: current.x0 - step, y0: current.y0 - step, x1: current.x1 + step, y1: current.y1 + step };
      } else if (event.key === "-" || event.key === "_") {
        next = { x0: current.x0 + step, y0: current.y0 + step, x1: current.x1 - step, y1: current.y1 - step };
      } else if (event.key === "Enter") {
        event.preventDefault();
        void commitFrame(current);
        return;
      } else {
        return;
      }
      event.preventDefault();
      setFrameRect(next);
    },
    [framing, frameRect, commitFrame],
  );

  /** 一键框回整张图（作者想回退时的**最短路**） */
  const useWholeImage = useCallback(() => {
    void commitFrame({ x0: 0, y0: 0, x1: baseW, y1: baseH });
  }, [baseW, baseH, commitFrame]);

  const shown = useMemo(
    () => (map?.markers ?? []).filter((marker) => !hidden.includes(marker.layer)),
    [map, hidden],
  );
  const selectedMarker = useMemo(
    () => (map?.markers ?? []).find((marker) => marker.id === selected) ?? null,
    [map, selected],
  );

  /**
   * R132 时空联动：把锚点清单**上报**给父组件（同一页的时间线要知道哪个事件在地图上）。
   *
   * 为什么上报而不是让父组件再取一次：地图取数要走 IPC 与真源解析，
   * 同一份数据取两次 ⇒ 两个地方可能对不上（作者会看到"时间线说有锚点、地图上没有"）。
   */
  useEffect(() => {
    if (map === null) return;
    props.onAnchors(map.anchors.map((anchor) => ({ id: anchor.id, eventRef: anchor.eventRef })));
  }, [map, props.onAnchors]);

  /** 地图上的**地点实体清单**（R133）：父组件据此判断"这个事件发生的地点在地图上" */
  useEffect(() => {
    if (map === null) return;
    props.onPlaces([...new Set(map.markers.map((marker) => marker.entityRef))]);
  }, [map, props.onPlaces]);

  /** 点锚点 ⇒ 告诉父组件它挂的事件（父组件去时间线那边定位并高亮） */
  const pickAnchor = useCallback(
    (eventRef: string) => {
      props.onAnchorPick(eventRef);
    },
    [props.onAnchorPick],
  );

  /** 地点卡的**键值行**（R126）：和面板汇总用**同一个**组件 ⇒ 键值行的样式只有一处，
      不会出现"汇总那套样式、地点卡另一套样式、后者还没跟上改名"的事。 */
  const cardRows: SummaryRow[] = useMemo(() => {
    if (selectedMarker === null) return [];
    const rows: SummaryRow[] = [
      { label: "id", value: selectedMarker.entityRef },
      { label: "图层", value: LAYER_LABEL[selectedMarker.layer] ?? selectedMarker.layer },
    ];
    if (selectedMarker.card === null) {
      rows.push({ label: "实体", value: "绑定的实体已不存在", tone: "warn" });
    } else {
      rows.push({ label: "类型", value: selectedMarker.card.type });
      if (selectedMarker.card.aliases.length > 0) {
        rows.push({ label: "别名", value: selectedMarker.card.aliases.join(" / ") });
      }
    }
    return rows;
  }, [selectedMarker]);

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
        <div className="map-upload">
          <button type="button" className="map-upload-btn" onClick={() => void uploadBase()} disabled={uploading}>
            {uploading ? "正在登记…" : "登记底图"}
          </button>
          <span className="muted">
            挑一张图 ⇒ 拷进项目 ⇒ 边界按**量出来的**像素尺寸自动填（作者手填边界填不对是常态）
          </span>
          {uploadNote !== "" && <div className="map-upload-note">{uploadNote}</div>}
        </div>
      </section>
    );
  }

  return (
    <section className="panel map-panel">
      <div className="panel-title">
        世界地图（底图与边界由作者定 · 其余由真源直算）
        <button
          type="button"
          className="map-upload-btn"
          onClick={() => void uploadBase()}
          disabled={uploading}
        >
          {uploading ? "正在登记…" : base !== null && base.exists ? "换底图" : "登记底图"}
        </button>
      </div>
      {/* R138 框定边界（K08 §3.6「用户上传底图并框定 bounds」）：
          入口与「登记底图」并列（同一件事的两步：先有图，再框出地图在图里的哪一块）。 */}
      <div className="map-frame-bar">
        <button
          type="button"
          className="map-upload-btn"
          onClick={toggleFraming}
          disabled={!hasBaseSize || framingBusy}
          title={hasBaseSize ? "" : "这张地图没有 base_size（不知道底图多大 ⇒ 框不出范围）"}
        >
          {framingBusy ? "正在写边界…" : framing ? "退出框定" : "框定边界"}
        </button>
        {framing && (
          <button type="button" className="map-upload-btn" onClick={useWholeImage} disabled={framingBusy}>
            框回整张图
          </button>
        )}
        <span className="muted">
          {framing
            ? "在整张图上拖一块（键盘也行：方向键移动，+ / - 改大小，回车定下来）"
            : "作者的大图常常只有中间一块是地图 ⇒ 在这里把那块框出来"}
        </span>
        {frameNote !== "" && <div className="map-upload-note">{frameNote}</div>}
      </div>
      {uploadNote !== "" && (
        <div className="map-upload-note">
          {uploadNote}
          {uploadSnippet !== null && (
            <pre className="map-upload-snippet">
              {uploadSnippet}
            </pre>
          )}
          {uploadPrevious.length > 0 && (
            <>
              <div>换回去就贴回这三行（旧图也还在项目里）：</div>
              <pre className="map-upload-snippet">
                {uploadPrevious.join("\n")}
              </pre>
            </>
          )}
        </div>
      )}

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
            className={
              "map-svg" + (entered ? " is-entered" : "") + (framing ? " is-framing" : "")
            }
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={
              framing
                ? `框定边界：整张底图 ${String(baseW)}×${String(baseH)}，拖一块或用方向键移动、回车定下来`
                : `世界地图坐标空间：${shown.length} 个标注，${map.layers.length} 个图层`
            }
            /* R138 框定模式：画布可拖（指针）+ 可键盘操作（方向键 / +- / 回车） */
            tabIndex={framing ? 0 : -1}
            onPointerDown={onFramePointerDown}
            onPointerMove={onFramePointerMove}
            onPointerUp={onFramePointerUp}
            onKeyDown={onFrameKeyDown}
          >
            {base !== null && base.dataUrl !== null && (
              <>
                {/* 底图：作者登记的那张图（K08 §3.6：底图 + bounds）。
                    **按框裁切**（R138）：平时把图往左挪 -x0 ⇒ 画布里露出的正好是作者框的那一块；
                    框定模式画整张图（挪 0）⇒ 作者能在整张图上框。
                    preserveAspectRatio=none ⇒ 图片像素与画布像素一一对应。 */}
                <image
                  className="map-base"
                  href={base.dataUrl}
                  x={imageX}
                  y={imageY}
                  width={baseW}
                  height={baseH}
                  preserveAspectRatio="none"
                />
                {/* 压暗层：底图是作者自己找的图，深浅不保证 ⇒ 压一层「地面色」
                    把底图拉到与界面同一档，标注与网格才读得出来。 */}
                <rect className="map-scrim" x={0} y={0} width={width} height={height} />
              </>
            )}
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
            {framing ? (
              /* 框定模式（R138）：标注与锚点**只看不点** —— 那一下是拖框，不是开卡。
                 这一支**不挂点击处理器** ⇒ 键盘债扫描器不算它债（可点的才必须键盘可达），
                 位置也按**底图像素**摆（那是整张图的坐标，他看得见自己框掉了哪些点）。 */
              <g className="map-frame-points" aria-hidden="true">
                {shown.map((marker, index) => (
                  <g
                    key={marker.id}
                    className="map-marker-in"
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <g className="map-marker" data-layer={marker.layer} data-marker={marker.id}>
                      <MarkerShape layer={marker.layer} cx={marker.x} cy={marker.y} />
                    </g>
                  </g>
                ))}
                {map.anchors.map((anchor) => (
                  <g
                    key={anchor.id}
                    className="map-anchor"
                    data-anchor={anchor.id}
                    data-event={anchor.eventRef}
                  >
                    <circle cx={anchor.x} cy={anchor.y} r={9} />
                    <circle cx={anchor.x} cy={anchor.y} r={2.5} className="map-anchor-core" />
                  </g>
                ))}
              </g>
            ) : (
              <>
            {shown.map((marker, index) => {
              const inside = marker.nx >= 0 && marker.nx <= 1 && marker.ny >= 0 && marker.ny <= 1;
              const cx = Math.min(Math.max(marker.nx, 0), 1) * width;
              const cy = Math.min(Math.max(marker.ny, 0), 1) * height;
              const isSelected = marker.id === selected;
              // R133：被时间线那边选中的地点 ⇒ 这个标注也高亮（两个方向一眼对得上）
              const placeLinked = props.linkedPlace !== null && props.linkedPlace === marker.entityRef;
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
                    (placeLinked ? " is-linked" : "") +
                    (inside ? "" : " is-outside")
                  }
                  data-layer={marker.layer}
                  data-marker={marker.id}
                  /* 键盘可达（R110）：SVG 里放不了 HTML 按钮 ⇒ 这个 <g> 自己当按钮
                     （role + tabIndex + 回车/空格），并给它一个可读的名字。 */
                  role="button"
                  tabIndex={0}
                  aria-label={`标注 ${marker.label}（${LAYER_LABEL[marker.layer] ?? marker.layer}）`}
                  onClick={() => {
                    selectMarker(marker.id);
                    // R133：点标注 ⇒ 顺带上报它绑的地点实体（父组件据此知道"这个地点在时间线上"）
                    props.onMarkerPick(marker.entityRef, marker.entityName);
                  }}
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
            {/* 事件锚点（R131，K08 §3.8：事件挂坐标 ⇒ 选事件能定位到地图上）：
                画成**空心环 + 中心点**，与地点标注的实心形状区分开（形状优先于颜色）。
                R132：锚点**可点** ⇒ 点它去时间线那边定位对应事件（时空联动的反向）。 */}
            {map.anchors.map((anchor) => {
              const inside = anchor.nx >= 0 && anchor.nx <= 1 && anchor.ny >= 0 && anchor.ny <= 1;
              const cx = Math.min(Math.max(anchor.nx, 0), 1) * width;
              const cy = Math.min(Math.max(anchor.ny, 0), 1) * height;
              const linked = props.linkedEvent !== null && props.linkedEvent === anchor.eventRef;
              return (
                <g
                  key={anchor.id}
                  className={
                    "map-anchor" +
                    (inside ? "" : " is-outside") +
                    (linked ? " is-linked" : "")
                  }
                  data-anchor={anchor.id}
                  data-event={anchor.eventRef}
                  /* 键盘可达（R110 / 契约 §6）：SVG 里放不了 HTML 按钮 ⇒ 这个 <g> 自己当按钮。
                     锚点**始终**是按钮（键盘债必须为 0）⇒ 三个属性都写成字面量。 */
                  role="button"
                  tabIndex={0}
                  aria-label={`事件锚点 ${anchor.label}（${anchor.eventRef}）`}
                  onClick={() => pickAnchor(anchor.eventRef)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      pickAnchor(anchor.eventRef);
                    }
                  }}
                >
                  <title>{`事件锚点 ${anchor.label}（${anchor.eventRef}）`}</title>
                  <circle cx={cx} cy={cy} r={9} />
                  <circle cx={cx} cy={cy} r={2.5} className="map-anchor-core" />
                </g>
              );
            })}
              </>
            )}
            {/* R138 框定模式：把「现在框到哪了」画出来（虚线）+ 拖动中的那一块（实线）。
                没有这两条，作者在整张图上拖的时候是盲的。 */}
            {framing && frameRect !== null && (
              <>
                <rect
                  className="map-frame-rect"
                  x={frameRect.x0}
                  y={frameRect.y0}
                  width={Math.max(frameRect.x1 - frameRect.x0, 0)}
                  height={Math.max(frameRect.y1 - frameRect.y0, 0)}
                />
                {frame !== null && (
                  <rect
                    className="map-frame-current"
                    x={frame.x0}
                    y={frame.y0}
                    width={Math.max(frame.x1 - frame.x0, 0)}
                    height={Math.max(frame.y1 - frame.y0, 0)}
                  />
                )}
              </>
            )}
          </svg>
          <div className="map-caption muted">
            <div>
              框定的那一块{" "}
              {map.bounds === null
                ? "（无有效边界，坐标未产出）"
                : `${map.bounds.x0},${map.bounds.y0} → ${map.bounds.x1},${map.bounds.y1}（${String(frameW)}×${String(frameH)}）`}
              {map.baseSize !== null && (
                <span className="muted">　底图整张 {map.baseSize.width}×{map.baseSize.height}</span>
              )}
            </div>
            <div>
              底图 {base !== null && base.path !== null ? `${base.path}${base.size === null ? "" : `（${base.size.width}×${base.size.height}）`}` : "没有登记"}
              {base !== null && base.exists && base.dataUrl === null ? `：${base.note}` : ""}
            </div>
          </div>
        </div>

        <div className="map-side">
          {selectedMarker === null ? (
            <div className="muted">点一个标注查它的地点卡</div>
          ) : (
            <div className="map-card">
              <div className="map-card-name">{selectedMarker.card?.name ?? selectedMarker.entityName}</div>
              <SummaryRows rows={cardRows} />
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
          {/* 摘要**按行渲染**（R124）：原先是一句「A · B；C」的自由文本，
              在窄栏里断成四五行、读起来像碎片 ⇒ 载荷带结构，这里逐行摆。 */}
          <SummaryRows
            rows={[
              { label: "标注", value: String(map.summary.markers) },
              { label: "图层", value: String(map.summary.layers) },
              { label: "实体", value: String(map.summary.entities) },
              { label: "体检", value: String(map.summary.findings) },
              { label: "事件锚点", value: String(map.summary.anchors) },
            ]}
          />
          {/* 锚点名单（R131）：逐个列出（事件 + 坐标）——作者要知道"哪个事件钉在地图哪一点" */}
          {map.anchors.length > 0 && (
            <ul className="map-anchors">
              {map.anchors.map((anchor) => (
                <li key={anchor.id}>
                  {anchor.label}（{anchor.eventRef}）· {anchor.x},{anchor.y}
                </li>
              ))}
            </ul>
          )}
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
