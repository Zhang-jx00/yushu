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
  const [framingBusy, setFramingBusy] = useState(false);
  /**
   * **一条状态行**（R141 的 UI 收拾）：框定 / 放标注 / 挪标注 三件事的回执放同一处 ⇒
   * 面板上只有一行「刚才那一下怎么了」，不再三四处各挂一句。
   */
  const [status, setStatus] = useState("");
  /** 拖拽起点（SVG 用户坐标 = 底图像素） */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  /**
   * R139 **挪标注**（K08 §5「上传底图 → 框定 bounds → **放 marker**」那一步）：
   * 作者手填的坐标常常差一点 ⇒ 让他在图上**拖**；**键盘也能挪**（方向键）⇒ 拖拽不是唯一的路。
   */
  /** 正在拖的那个东西（标注 / 锚点；预览位置；x / y 是**底图像素**） */
  const [dragging, setDragging] = useState<{
    kind: "marker" | "anchor";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  /** 拖拽起点（种类 + 那个东西的 id + 指针落点） */
  const dragItemStart = useRef<{
    kind: "marker" | "anchor";
    id: string;
    px: number;
    py: number;
  } | null>(null);
  /** 拖拽途中的位置（放在 ref 里：pointerup 读它，别读可能还没刷新的 state） */
  const dragItemPos = useRef<{
    kind: "marker" | "anchor";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  /** 刚拖过 ⇒ 接下来的那次 click 不算数（否则拖完会顺手把地点卡也打开） */
  const suppressClick = useRef(false);
  /**
   * R140 **放标注**（K08 §5「放 marker、区域、行程线 → 绑定实体」）：
   * 选一个**地点实体** ⇒ 在图上点一下 ⇒ 落一个标注（写盘只追加那一行）。
   */
  const [placing, setPlacing] = useState(false);
  /** 放什么：地点标注（绑地点实体）还是事件锚点（绑时间线上的事件） */
  const [placeKind, setPlaceKind] = useState<"marker" | "anchor">("marker");
  /** 放置时选中的那个 id（地点实体 id 或事件 id；空 = 还没选） */
  const [placeEntity, setPlaceEntity] = useState("");
  /**
   * R143 **放区域 / 放行程线**（K08 §5 的后两样）：在图上点出一串点 ⇒ 落一个面 / 一条线。
   * 顶点用**底图像素**（与标注/锚点同一套坐标空间）。
   */
  const [shapeKind, setShapeKind] = useState<"region" | "route" | null>(null);
  /** 已经点出来的顶点（底图像素） */
  const [shapePoints, setShapePoints] = useState<{ x: number; y: number }[]>([]);
  /** 放标注时的**十字光标**（视图坐标）：鼠标点哪儿、方向键走到哪儿，它就在哪儿 */
  const [placeCursor, setPlaceCursor] = useState<{ x: number; y: number } | null>(null);

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
    setStatus("");
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
        setStatus("框太小了（按住拖一小块再松手）");
        return;
      }
      setFramingBusy(true);
      try {
        const result = await api().map.setBounds({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 });
        setStatus(result.note);
        if (result.ok) {
          setFraming(false);
          setFrameRect(null);
          reloadMap();
        }
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setFramingBusy(false);
      }
    },
    [reloadMap],
  );

  /**
   * 地图的**结构化行**（R141 的 UI 收拾）：与其他面板**同一套**汇总行 ⇒
   * 不再是几行各自为政的 div（标签与值挤在一行、值一长就折行 ⇒ 读起来像碎片）。
   */
  const mapSummaryRows: SummaryRow[] = useMemo(() => {
    const bounds = map?.bounds ?? null;
    const baseSize = map?.baseSize ?? null;
    const rows: SummaryRow[] = [
      {
        label: "框定的那一块",
        value:
          bounds === null
            ? "（无有效边界，坐标未产出）"
            : `${bounds.x0},${bounds.y0} → ${bounds.x1},${bounds.y1}（${String(frameW)}×${String(frameH)}）`,
      },
      {
        label: "底图",
        value:
          base !== null && base.path !== null
            ? `${base.path}${base.size === null ? "" : `（${base.size.width}×${base.size.height}）`}`
            : "没有登记",
      },
    ];
    if (baseSize !== null) {
      rows.push({ label: "底图整张", value: `${baseSize.width}×${baseSize.height}` });
    }
    return rows;
  }, [map, base, frameW, frameH]);

  /** SVG 客户端坐标 ⇒ 用户坐标（框定模式下用户坐标 = 底图像素）
   *  参数只取**要用的那三样**（clientX / clientY / currentTarget）⇒ 指针事件与鼠标事件都能传进来。 */
  const toImagePoint = useCallback(
    (event: { clientX: number; clientY: number; currentTarget: SVGGraphicsElement }) => {
    // 用**所属的 `<svg>`** 的变换算：标注自己有悬停放大（transform），
    // 拿标注自己的 CTM 会把落点算偏（放大是绕中心缩放的 ⇒ 偏几个像素，作者看不出来但会烦）。
    const owner = event.currentTarget.ownerSVGElement;
    const svg = owner ?? (event.currentTarget as unknown as SVGSVGElement);
    const ctm = svg.getScreenCTM();
    if (ctm === null) return null;
    // DOMPoint 而不是 svg.createSVGPoint()：后者只在 <svg> 上有，标注那个 <g> 上没有
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  /** 挪标注：写盘（**只改那一个标注的 x / y**；范围由主进程校验、冲突由主进程报） */
  const moveMarker = useCallback(
    async (markerId: string, x: number, y: number) => {
      try {
        const result = await api().map.setMarker({ markerId: markerId, x: x, y: y });
        setStatus(result.note);
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        // 成没成都重新取数：成了要让图上那个点真的挪过去，没成要把预览位置退回去
        reloadMap();
      }
    },
    [reloadMap],
  );

  /** 挪事件锚点（R141）：写盘（**只改那一个锚点的 x / y**；范围由主进程校验、冲突由主进程报） */
  const moveAnchor = useCallback(
    async (anchorId: string, x: number, y: number) => {
      try {
        const result = await api().map.setAnchor({ anchorId: anchorId, x: x, y: y });
        setStatus(result.note);
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        reloadMap();
      }
    },
    [reloadMap],
  );

  const onItemPointerDown = useCallback(
    (event: ReactPointerEvent<SVGGraphicsElement>, kind: "marker" | "anchor", id: string) => {
      const p = toImagePoint(event);
      if (p === null) return;
      dragItemStart.current = { kind: kind, id: id, px: p.x, py: p.y };
      dragItemPos.current = null;
    },
    [toImagePoint],
  );

  const onItemPointerMove = useCallback(
    (event: ReactPointerEvent<SVGGraphicsElement>, kind: "marker" | "anchor", id: string) => {
      const start = dragItemStart.current;
      if (start === null || start.id !== id || start.kind !== kind) return;
      const p = toImagePoint(event);
      if (p === null) return;
      // 动得不够 ⇒ 那还是一次**点击**（开地点卡 / 去时间线定位），不是拖动
      if (Math.hypot(p.x - start.px, p.y - start.py) < 3) return;
      dragItemPos.current = { kind: kind, id: id, x: p.x, y: p.y };
      setDragging(dragItemPos.current);
    },
    [toImagePoint],
  );

  const onItemPointerUp = useCallback(
    (event: ReactPointerEvent<SVGGraphicsElement>, kind: "marker" | "anchor", id: string) => {
      const start = dragItemStart.current;
      const moved = dragItemPos.current;
      dragItemStart.current = null;
      dragItemPos.current = null;
      setDragging(null);
      if (start === null || moved === null || moved.id !== id || moved.kind !== kind) return;
      // 拖过了 ⇒ 接下来的那次 click 不算数（否则拖完会顺手把地点卡也打开）
      suppressClick.current = true;
      const p = toImagePoint(event);
      if (p === null) return;
      if (kind === "marker") void moveMarker(id, p.x, p.y);
      else void moveAnchor(id, p.x, p.y);
    },
    [toImagePoint, moveMarker, moveAnchor],
  );

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

  /** 进入/退出**画形状**模式（区域 / 行程线；与框定、放标注互斥：一次只做一件事） */
  const toggleShape = useCallback(
    (kind: "region" | "route") => {
      setStatus("");
      if (shapeKind === kind) {
        setShapeKind(null);
        setShapePoints([]);
        return;
      }
      setFraming(false);
      setFrameRect(null);
      setPlacing(false);
      setPlaceEntity("");
      setShapeKind(kind);
      setShapePoints([]);
    },
    [shapeKind],
  );

  /** 把点出来的那串点写成地图上的一个形状（只追加那一行；范围由主进程校验） */
  const commitShape = useCallback(async () => {
    if (shapeKind === null) return;
    const minPoints = shapeKind === "region" ? 3 : 2;
    if (shapePoints.length < minPoints) {
      setStatus(`${shapeKind === "region" ? "区域" : "行程线"}至少要 ${String(minPoints)} 个点（现在 ${String(shapePoints.length)} 个）`);
      return;
    }
    try {
      const result = await api().map.createShape({ kind: shapeKind, points: shapePoints });
      setStatus(result.note);
      if (result.ok) {
        setShapeKind(null);
        setShapePoints([]);
        reloadMap();
      }
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [shapeKind, shapePoints, reloadMap]);

  /** 一键框回整张图（作者想回退时的**最短路**） */
  const useWholeImage = useCallback(() => {
    void commitFrame({ x0: 0, y0: 0, x1: baseW, y1: baseH });
  }, [baseW, baseH, commitFrame]);

  /** 进入/退出**放标注**模式（与框定模式互斥：一次只做一件事） */
  const togglePlacing = useCallback(
    (kind: "marker" | "anchor") => {
      setStatus("");
      if (placing && placeKind === kind) {
        setPlacing(false);
        setPlaceEntity("");
        setPlaceCursor(null);
        return;
      }
      setFraming(false);
      setFrameRect(null);
      setShapeKind(null);
      setShapePoints([]);
      setPlaceKind(kind);
      setPlaceEntity("");
      // 光标从**框的正中间**起步（作者一眼看得见起点，方向键一按就能挪）
      setPlaceCursor({ x: Math.round(frameW / 2), y: Math.round(frameH / 2) });
      setPlacing(true);
    },
    [placing, placeKind, frameW, frameH],
  );

  /** 在图上落一个东西（标注或锚点；写盘只追加那一行；范围与对象由主进程校验） */
  const placeAt = useCallback(
    async (userX: number, userY: number) => {
      if (placeEntity === "") {
        setStatus(placeKind === "marker" ? "先选一个地点，再在图上点一下" : "先选一个事件，再在图上点一下");
        return;
      }
      // 视图坐标 ⇒ 底图像素（框的原点要加回去）
      const x = Math.round(userX + (frame?.x0 ?? 0));
      const y = Math.round(userY + (frame?.y0 ?? 0));
      try {
        const result =
          placeKind === "marker"
            ? await api().map.createMarker({ entityRef: placeEntity, x: x, y: y })
            : await api().map.createAnchor({ eventRef: placeEntity, x: x, y: y });
        setStatus(result.note);
        if (result.ok) {
          setPlacing(false);
          setPlaceEntity("");
          setPlaceCursor(null);
          reloadMap();
        }
      } catch (err: unknown) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    [placeEntity, placeKind, frame, reloadMap],
  );

  /** 放标注的键盘路（契约 §6：键盘债是 0）：方向键挪十字光标、回车落点 */
  const onPlaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGRectElement>) => {
      const cursor = placeCursor;
      if (cursor === null) return;
      const step = event.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else if (event.key === "Enter") {
        event.preventDefault();
        void placeAt(cursor.x, cursor.y);
        return;
      } else {
        return;
      }
      event.preventDefault();
      setPlaceCursor({
        x: Math.min(Math.max(cursor.x + dx, 0), width),
        y: Math.min(Math.max(cursor.y + dy, 0), height),
      });
    },
    [placeCursor, width, height, placeAt],
  );

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
          入口与「登记底图」并列（同一件事的两步：先有图，再框出地图在图里的哪一块）。
          R141 的 UI 收拾：**按钮归一组**，模式相关的控件（框回整张图 / 地点下拉）只在该模式里出现。 */}
      <div className="map-frame-bar">
        {/* R144 的 UI 收口：五个入口（框定 / 放标注 / 放锚点 / 放区域 / 放行程线）**收成一个分段控件**
            —— 它们是「编辑地图」的几种做法，不是五件不相干的事。
            **当前模式看得出来**（分段按钮高亮 + aria-pressed），**模式相关的控件只在该模式里出现**。 */}
        <span className="map-mode-label">编辑地图</span>
        <div className="map-mode-group" role="group" aria-label="编辑地图">
          <button
            type="button"
            className={"map-mode-btn" + (framing ? " is-on" : "")}
            aria-pressed={framing}
            onClick={toggleFraming}
            disabled={!hasBaseSize || framingBusy}
            title={hasBaseSize ? "框定边界：把地图在底图里的哪一块框出来" : "这张地图没有 base_size（不知道底图多大 ⇒ 框不出范围）"}
          >
            {framingBusy ? "正在写边界…" : "框定边界"}
          </button>
          {/* R140 放标注 / R142 放锚点 / R143 放区域与行程线：五种做法各管一件事，
              但**看起来**是同一个控件的五个档位（分段控件）。 */}
          <button
            type="button"
            className={"map-mode-btn" + (placing && placeKind === "marker" ? " is-on" : "")}
            aria-pressed={placing && placeKind === "marker"}
            onClick={() => togglePlacing("marker")}
            disabled={placing ? false : map.places.length === 0}
            title={map.places.length === 0 ? "项目里还没有地点实体（标注要绑真实地点）" : "放标注：选一个地点，在图上点一下"}
          >
            放标注
          </button>
          <button
            type="button"
            className={"map-mode-btn" + (placing && placeKind === "anchor" ? " is-on" : "")}
            aria-pressed={placing && placeKind === "anchor"}
            onClick={() => togglePlacing("anchor")}
            disabled={placing ? false : map.events.length === 0}
            title={map.events.length === 0 ? "项目里还没有时间线事件（锚点要挂真实的事件）" : "放锚点：选一个事件，在图上点一下"}
          >
            放锚点
          </button>
          <button
            type="button"
            className={"map-mode-btn" + (shapeKind === "region" ? " is-on" : "")}
            aria-pressed={shapeKind === "region"}
            onClick={() => toggleShape("region")}
            title="放区域：点出一串点，落一个闭合的面"
          >
            放区域
          </button>
          <button
            type="button"
            className={"map-mode-btn" + (shapeKind === "route" ? " is-on" : "")}
            aria-pressed={shapeKind === "route"}
            onClick={() => toggleShape("route")}
            title="放行程线：点出一串点，落一条线"
          >
            放行程线
          </button>
        </div>
        {framing && (
          <button type="button" className="map-upload-btn" onClick={useWholeImage} disabled={framingBusy}>
            框回整张图
          </button>
        )}
        {shapeKind !== null && (
          <button type="button" className="map-upload-btn" onClick={() => void commitShape()}>
            画完了（{shapePoints.length} 个点）
          </button>
        )}
          {placing && (
            <select
              className="map-place-select"
              value={placeEntity}
              onChange={(event) => setPlaceEntity(event.target.value)}
              aria-label={placeKind === "marker" ? "选一个地点" : "选一个事件"}
            >
              <option value="">{placeKind === "marker" ? "选一个地点…" : "选一个事件…"}</option>
              {placeKind === "marker"
                ? map.places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))
                : map.events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.title}
                    </option>
                  ))}
            </select>
          )}
        {status !== "" && <div className="map-status">{status}</div>}
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
              <span className="map-layer-count">
                {layer.markerCount}
                {layer.shapeCount > 0 ? ` + ${layer.shapeCount}` : ""}
              </span>
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
              // R139：正在拖的那个点**跟着指针走**（预览位置 = 底图像素 - 框的原点）
              const isDragging =
                dragging !== null && dragging.kind === "marker" && dragging.id === marker.id;
              const cx = isDragging
                ? dragging.x - (frame?.x0 ?? 0)
                : Math.min(Math.max(marker.nx, 0), 1) * width;
              const cy = isDragging
                ? dragging.y - (frame?.y0 ?? 0)
                : Math.min(Math.max(marker.ny, 0), 1) * height;
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
                  /* R139：标注**可拖**（在图上挪到新位置 ⇒ 写盘只改那一个标注的 x / y） */
                  onPointerDown={(event) => onItemPointerDown(event, "marker", marker.id)}
                  onPointerMove={(event) => onItemPointerMove(event, "marker", marker.id)}
                  onPointerUp={(event) => onItemPointerUp(event, "marker", marker.id)}
                  onClick={() => {
                    // 刚拖完的那一下 click 不算数（否则拖一下会顺手把地点卡也打开）
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    selectMarker(marker.id);
                    // R133：点标注 ⇒ 顺带上报它绑的地点实体（父组件据此知道"这个地点在时间线上"）
                    props.onMarkerPick(marker.entityRef, marker.entityName);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectMarker(marker.id);
                      return;
                    }
                    // R139：方向键**挪标注**（键盘也能挪 ⇒ 拖拽不是唯一的路）
                    const step = event.shiftKey ? 10 : 1;
                    let dx = 0;
                    let dy = 0;
                    if (event.key === "ArrowLeft") dx = -step;
                    else if (event.key === "ArrowRight") dx = step;
                    else if (event.key === "ArrowUp") dy = -step;
                    else if (event.key === "ArrowDown") dy = step;
                    else return;
                    event.preventDefault();
                    void moveMarker(marker.id, marker.x + dx, marker.y + dy);
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
              // R141：正在拖的那个锚点**跟着指针走**（预览位置 = 底图像素 - 框的原点）
              const isDragging =
                dragging !== null && dragging.kind === "anchor" && dragging.id === anchor.id;
              const cx = isDragging
                ? dragging.x - (frame?.x0 ?? 0)
                : Math.min(Math.max(anchor.nx, 0), 1) * width;
              const cy = isDragging
                ? dragging.y - (frame?.y0 ?? 0)
                : Math.min(Math.max(anchor.ny, 0), 1) * height;
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
                  /* R141：锚点**可拖**（在图上挪到新位置 ⇒ 写盘只改那一个锚点的 x / y） */
                  onPointerDown={(event) => onItemPointerDown(event, "anchor", anchor.id)}
                  onPointerMove={(event) => onItemPointerMove(event, "anchor", anchor.id)}
                  onPointerUp={(event) => onItemPointerUp(event, "anchor", anchor.id)}
                  onClick={() => {
                    // 刚拖完的那一下 click 不算数（否则拖一下会顺手跳去时间线）
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    pickAnchor(anchor.eventRef);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      pickAnchor(anchor.eventRef);
                      return;
                    }
                    // R141：方向键**挪锚点**（键盘也能挪 ⇒ 拖拽不是唯一的路）
                    const step = event.shiftKey ? 10 : 1;
                    let dx = 0;
                    let dy = 0;
                    if (event.key === "ArrowLeft") dx = -step;
                    else if (event.key === "ArrowRight") dx = step;
                    else if (event.key === "ArrowUp") dy = -step;
                    else if (event.key === "ArrowDown") dy = step;
                    else return;
                    event.preventDefault();
                    void moveAnchor(anchor.id, anchor.x + dx, anchor.y + dy);
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
            {/* R140 放标注模式：一层**透明覆盖层**接住"点一下"，
                十字光标是**键盘可达**的（方向键挪、回车落点）⇒ 键盘债是 0。
                它盖在标注之上 ⇒ 放标注时点标注不会误放一个。 */}
            {/* R143：地图上的区域（面）与行程线（线）——从真源直算，顶点已归一化 */}
            {map.shapes.filter((shape) => !hidden.includes(shape.layer)).map((shape) => {
              const points = shape.points.map((point) => `${String(point.x * width)},${String(point.y * height)}`).join(" ");
              return shape.kind === "region" ? (
                <polygon key={shape.id} className="map-region" data-shape={shape.id} points={points}>
                  <title>{shape.name ?? shape.id}</title>
                </polygon>
              ) : (
                <polyline key={shape.id} className="map-route" data-shape={shape.id} points={points}>
                  <title>{shape.name ?? shape.id}</title>
                </polyline>
              );
            })}
            {/* 画到一半的那串点（还没落盘 ⇒ 虚线 + 小点，让作者看得见自己画到哪了） */}
            {shapeKind !== null && shapePoints.length > 0 && (
              <g className="map-shape-pending" aria-hidden="true" pointerEvents="none">
                {shapePoints.length > 1 && (
                  <polyline
                    points={shapePoints
                      .map((point) => `${String(point.x - (frame?.x0 ?? 0))},${String(point.y - (frame?.y0 ?? 0))}`)
                      .join(" ")}
                  />
                )}
                {shapePoints.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x - (frame?.x0 ?? 0)}
                    cy={point.y - (frame?.y0 ?? 0)}
                    r={3.5}
                  />
                ))}
              </g>
            )}
            {(placing || shapeKind !== null) && (
              <>
                <rect
                  className="map-place-overlay"
                  x={0}
                  y={0}
                  width={width}
                  height={height}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    shapeKind !== null
                      ? "画形状：点一下加一个顶点；键盘用方向键挪十字光标、回车加点、退格删点"
                      : "放标注：在图上点一下落点；键盘用方向键挪十字光标、回车落点"
                  }
                  onClick={(event) => {
                    const p = toImagePoint(event);
                    if (p === null) return;
                    setPlaceCursor({ x: p.x, y: p.y });
                    if (shapeKind !== null) {
                      // 画形状：点一下是**加一个顶点**
                      setShapePoints((prev) => [
                        ...prev,
                        { x: Math.round(p.x + (frame?.x0 ?? 0)), y: Math.round(p.y + (frame?.y0 ?? 0)) },
                      ]);
                      return;
                    }
                    void placeAt(p.x, p.y);
                  }}
                  onKeyDown={(event) => {
                    if (shapeKind !== null) {
                      // 画形状：回车加一个顶点、退格删掉最后一个（键盘也能画）
                      if (event.key === "Enter" && placeCursor !== null) {
                        event.preventDefault();
                        setShapePoints((prev) => [
                          ...prev,
                          {
                            x: Math.round(placeCursor.x + (frame?.x0 ?? 0)),
                            y: Math.round(placeCursor.y + (frame?.y0 ?? 0)),
                          },
                        ]);
                        return;
                      }
                      if (event.key === "Backspace") {
                        event.preventDefault();
                        setShapePoints((prev) => prev.slice(0, -1));
                        return;
                      }
                      return;
                    }
                    onPlaceKeyDown(event);
                  }}
                />
                {placeCursor !== null && (
                  <g className="map-place-cursor" aria-hidden="true" pointerEvents="none">
                    <line x1={placeCursor.x - 10} y1={placeCursor.y} x2={placeCursor.x + 10} y2={placeCursor.y} />
                    <line x1={placeCursor.x} y1={placeCursor.y - 10} x2={placeCursor.x} y2={placeCursor.y + 10} />
                  </g>
                )}
              </>
            )}
          </svg>
          <div className="map-caption">
            <SummaryRows rows={mapSummaryRows} />
            {/* 一行**作者语言**的操作提示（不露实现细节：作者不关心改的是哪个文件） */}
            <div className="map-hint">
              {shapeKind !== null
                ? `点一下加一个顶点（键盘：方向键挪十字光标、回车加点、退格删点），点够了按「画完了」`
                : placing
                  ? placeKind === "marker"
                    ? "选好地点后在图上点一下（键盘：方向键挪十字光标、回车落点）"
                    : "选好事件后在图上点一下（键盘：方向键挪十字光标、回车落点）"
                  : framing
                    ? "在整张图上拖一块（键盘：方向键移动，+ / - 改大小，回车定下来）"
                    : "拖标注可以改位置；「框定边界」把地图在图里的那一块框出来"}
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
