/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CardReadResult,
  CardSummary,
  ChronicleBookPayload,
  ForeshadowBoardPayload,
  NamingKindPayload,
  NamingResultPayload,
  SatisfactionBoardPayload,
  TimelineViewPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";
import { cardTypeLabel, layerLabel } from "../card-labels";
import { Disclosure } from "../components/Disclosure";
import { RelationGraphPanel } from "../components/RelationGraphPanel";
import { ChronologyPanel } from "../components/ChronologyPanel";
import { SatisfactionPanel } from "../components/SatisfactionPanel";
import { WorldMapPanel } from "../components/WorldMapPanel";
import { SummaryRows } from "../components/SummaryRows";
import { ARCHIVE_ARTIFACT_MAX_ITEMS, summarizeArchiveArtifacts } from "../components/archive-artifacts";

const NAMING_KINDS: { kind: NamingKindPayload; label: string }[] = [
  { kind: "character", label: "角色名" },
  { kind: "place", label: "地名" },
  { kind: "sect", label: "门派" },
  { kind: "technique", label: "功法" },
];

/** 世界观档案（T1-9）：设定卡列表 + 可视化编辑（frontmatter 字段 + 正文，带并发检测）+ 取名助手（T1-8）；
 *  支持外部聚焦（T2-2：编辑器实体提及 → 跳转并选中该卡）。
 *
 *  R162 三栏化（docs/11 §7.41）：左=图谱与清单 / 中=地图与工作面板 / 右=伏笔·爽点·编年史的产物。
 *  骨架是**共用的** `.three-col`（R154 立的那副），不是这一页自己写的网格。
 */
export function ArchiveView({
  focusCardPath,
}: {
  /** 外部聚焦请求（tick 变化即触发一次选中）；由 ProjectScreen 传入 */
  focusCardPath?: { path: string; tick: number } | null;
} = {}) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<CardReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  /**
   * 时空联动（R132；K08 §3.8 后半句「选事件定位地图锚点」+「点 marker 跳到时间轴对应事件」）。
   *
   * 两个方向都靠**同一个事件 id**串起来：
   * - 地图那边点锚点 ⇒ `linkedEvent` = 那个事件 ⇒ 时间线那一行高亮并滚到眼前；
   * - 时间线那边点「地图上有锚点」⇒ `linkedEvent` = 那个事件 ⇒ 地图滚到眼前、那个锚点高亮。
   *
   * 为什么不用两套状态（"选中锚点" + "选中事件"）：两个状态会对不上 ⇒ 作者看到"高亮的行"
   * 和"高亮的点"不是同一件事 ⇒ 联动看起来像坏了。**一个事件 id 贯穿两头**。
   */
  const [linkedEvent, setLinkedEvent] = useState<string | null>(null);
  /** 地图上的锚点清单（由地图面板上报；时间线据此给「地图上有锚点」的入口） */
  const [mapAnchors, setMapAnchors] = useState<{ id: string; eventRef: string }[]>([]);
  /**
   * R133：**地点**方向的联动（K08 §3.8「点 marker 跳到时间轴对应事件」）。
   *
   * 与 `linkedEvent` **不是两套视图，是两件不同的事**：一个是"聚焦的事件"，一个是"聚焦的地点"
   * ⇒ 两者不会互相矛盾（一个事件可以就发生在这个地点上，两个同时被聚焦是正常的）。
   * 真正会矛盾的是"同一个东西两套状态"（R132 那条纪律管的是这个）。
   */
  const [linkedPlace, setLinkedPlace] = useState<string | null>(null);
  /** 地图上的地点实体清单（时间线据此判断「这个地点在地图上」） */
  const [mapPlaces, setMapPlaces] = useState<string[]>([]);
  /** 地图那边刚点了哪个标注（地点名 + 实体 id） */
  const [pickedPlace, setPickedPlace] = useState<{ entityRef: string; entityName: string } | null>(null);

  /** 地图那边点锚点 ⇒ 选事件 + 把时间线那一行滚到眼前 */
  const pickAnchor = useCallback((eventRef: string) => {
    setLinkedEvent(eventRef);
    requestAnimationFrame(() => {
      const row = document.querySelector('.timeline-table tr[data-event="' + eventRef + '"]');
      if (row !== null) row.scrollIntoView({ block: "center" });
    });
  }, []);

  /** 时间线那边点「地图上有锚点」⇒ 选事件 + 把地图滚到眼前 */
  const jumpToMap = useCallback((eventId: string) => {
    setLinkedEvent(eventId);
    requestAnimationFrame(() => {
      const panel = document.querySelector(".map-panel");
      if (panel !== null) panel.scrollIntoView({ block: "center" });
    });
  }, []);

  /** 地图那边点标注 ⇒ 记住这个地点（R133：父组件据此说"这个地点在时间线上有 N 条"） */
  const pickMarker = useCallback((entityRef: string, entityName: string) => {
    setPickedPlace({ entityRef, entityName });
    setLinkedPlace(entityRef);
  }, []);

  /** 时间线那边点「这个地点在地图上」⇒ 选地点 + 把地图滚到眼前 */
  const jumpToPlace = useCallback((entityRef: string) => {
    setLinkedPlace(entityRef);
    requestAnimationFrame(() => {
      const panel = document.querySelector(".map-panel");
      if (panel !== null) panel.scrollIntoView({ block: "center" });
    });
  }, []);

  // 取名助手（本地生成，离线可用）
  const [namingKind, setNamingKind] = useState<NamingKindPayload>("character");
  const [namingCount, setNamingCount] = useState(5);
  const [namingSeed, setNamingSeed] = useState("");
  const [namingResult, setNamingResult] = useState<NamingResultPayload | null>(null);
  const [namingNotice, setNamingNotice] = useState("");

  // 伏笔台账（T4-6，R66）：只读看板——判定在引擎，这里只摆出来，不给"一键改状态"的按钮
  const [board, setBoard] = useState<ForeshadowBoardPayload | null>(null);
  const [boardError, setBoardError] = useState("");
  useEffect(() => {
    let alive = true;
    api()
      .foreshadow.board()
      .then((result) => {
        if (alive) setBoard(result);
      })
      .catch((err: unknown) => {
        if (alive) setBoardError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 时间线（T4-7，R68）：历法下拉只换显示，不写文件——所以切换只是重新读一次视图
  const [timeline, setTimeline] = useState<TimelineViewPayload | null>(null);
  const [calendar, setCalendar] = useState("");
  const [timelineError, setTimelineError] = useState("");
  useEffect(() => {
    let alive = true;
    api()
      .timeline.view(calendar === "" ? {} : { calendar })
      .then((result) => {
        if (alive) setTimeline(result);
      })
      .catch((err: unknown) => {
        if (alive) setTimelineError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [calendar]);

  /**
   * R162：爽点与编年史的载荷**由面板上报**——面板自己去取数，取回来后把**同一个载荷对象**报上来。
   *
   * 为什么不让父组件再取一次：那就是**两个载荷** ⇒ 两个数可能对不上 ⇒ 右栏与中栏对不了账。
   * 为什么不让界面自己算：同一个数在一页里只能有一个出处（docs/11 §7.34）。
   */
  const [satisfactionBoard, setSatisfactionBoard] = useState<SatisfactionBoardPayload | null>(null);
  const [chronicleBook, setChronicleBook] = useState<ChronicleBookPayload | null>(null);

  /** 右栏三块产物的摘要：**纯函数**从那三份载荷现算（不写死字面量、不另取数） */
  const artifacts = useMemo(
    () =>
      summarizeArchiveArtifacts({
        foreshadow: board,
        satisfaction: satisfactionBoard,
        chronicle: chronicleBook,
      }),
    [board, satisfactionBoard, chronicleBook],
  );

  /**
   * R133：刚刚点中的那个地点，在时间线上有哪几条事件（`place_ref` 对上号的）。
   *
   * 为什么要在**地图面板旁边**说这件事：点标注的**主**含义是"打开那张地点卡"（K08 §3.7），
   * 若点一下就把页面滚到时间线，作者手里的卡就滚没了 ⇒ 两头都在眼前才接得上。
   */
  const placeEvents = useMemo(
    () =>
      (timeline?.rows ?? []).filter(
        (row) => pickedPlace !== null && row.placeRef !== null && row.placeRef === pickedPlace.entityRef,
      ),
    [timeline, pickedPlace],
  );

  const generateNames = async () => {
    try {
      setError(null);
      setNamingNotice("");
      const result = await api().naming.generate({
        kind: namingKind,
        count: namingCount,
        ...(namingSeed.trim() !== "" ? { seed: namingSeed.trim() } : {}),
      });
      setNamingResult(result);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyName = async (name: string) => {
    try {
      // 走主进程 Electron clipboard（渲染层 navigator.clipboard 在生产 file:// 下不可靠）
      await api().app.writeClipboard(name);
      setNamingNotice(`已复制「${name}」`);
    } catch (err) {
      setNamingNotice(`复制失败：${(err as Error).message}`);
    }
  };

  const refresh = useCallback(async () => {
    try {
      setCards(await api().card.list());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCard = async (path: string) => {
    try {
      setError(null);
      const result = await api().card.read(path);
      setSelected(path);
      setDoc(result);
      setDraft(result.body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 外部聚焦（T2-2）：编辑器实体提及跳转过来时自动选中该卡（tick 每次变化都会触发）
  useEffect(() => {
    if (focusCardPath) void openCard(focusCardPath.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCardPath?.tick]);

  const patch = (fields: Record<string, unknown>) => {
    if (!doc) return;
    setDoc({ ...doc, card: { ...doc.card, ...fields } });
  };

  const save = async () => {
    if (!doc) return;
    try {
      setError(null);
      const result = await api().card.write({
        path: doc.path,
        card: doc.card,
        body: draft,
        baseHash: doc.hash,
      });
      setDoc((prev) => (prev ? { ...prev, hash: result.hash } : prev));
      setStatus(
        `已保存 ${result.path}${
          result.warnings.length > 0 ? `（告警：${result.warnings.join("；")}）` : ""
        }`,
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="archive-scroll">
      <div className="archive three-col archive-three-col">
        {/* 左栏 = 图谱与清单（R162）：这一页"有哪些" */}
        <aside className="archive-col-graph">
          <RelationGraphPanel />
          <div className="panel-title">
            <span className="muted">设定卡（{cards.length}）</span>
            <button type="button" className="link" onClick={refresh}>
              刷新
            </button>
          </div>
          <ul className="card-list">
            {cards.map((card) => (
              <li
                key={card.path}
                className={card.path === selected ? "on" : ""}
              >
                {/* 键盘可达（R110）：真按钮 + aria-current 标选中态 */}
                <button
                  type="button"
                  aria-current={card.path === selected ? "true" : undefined}
                  onClick={() => openCard(card.path)}
                >
                  <div>
                    <strong>{card.name}</strong>
                    <span className="muted">
                      {cardTypeLabel(card.type)} · {layerLabel(card.layer)}
                    </span>
                  </div>
                  <div className="muted">
                    {card.id}
                    {card.visibility && ` · ${card.visibility}`}
                  </div>
                  {card.error && <div className="error-text">{card.error}</div>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* 中栏 = 地图与工作面板（R162）：这一页"我正在做什么" */}
        <div className="archive-col-work">
          <WorldMapPanel
            linkedEvent={linkedEvent}
            linkedPlace={linkedPlace}
            onAnchorPick={pickAnchor}
            onMarkerPick={pickMarker}
            onAnchors={setMapAnchors}
            onPlaces={setMapPlaces}
          />
          {pickedPlace !== null && placeEvents.length > 0 && (
            <div className="map-place-events">
              「{pickedPlace.entityName}」在时间线上有 {placeEvents.length} 条事件：
              {placeEvents.map((row) => row.title).join("、")}
              <button
                type="button"
                className="timeline-map-link"
                onClick={() => jumpToPlace(pickedPlace.entityRef)}
              >
                跳到时间线
              </button>
            </div>
          )}
          <section className="editor">
            {!doc && <div className="muted pad">选择左侧设定卡进行编辑；或在「起源工作台」逐步建档</div>}
            {doc && (
              <>
                <div className="panel-title">
                  <span className="muted">{doc.path}</span>
                  {draft !== doc.body && <span className="dirty">有未保存修改</span>}
                </div>

                <div className="card-fields">
                  <label className="field">
                    <span>名称</span>
                    <input value={doc.card.name} onChange={(event) => patch({ name: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>别名（逗号分隔，供提及追踪）</span>
                    <input
                      value={doc.card.aliases?.join(", ") ?? ""}
                      onChange={(event) =>
                        patch({
                          aliases: event.target.value
                            .split(/[,，]/)
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>来源章节（逗号分隔的章 id，供冰山台账与可见性核对）</span>
                    <input
                      className="card-source-chapters"
                      value={doc.card.source_chapters?.join(", ") ?? ""}
                      onChange={(event) =>
                        patch({
                          source_chapters: event.target.value
                            .split(/[,，]/)
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>可见性（冰山原则）</span>
                    <select
                      value={doc.card.visibility ?? "hidden"}
                      onChange={(event) => patch({ visibility: event.target.value })}
                    >
                      <option value="hidden">隐藏（未在正文出现）</option>
                      <option value="written_unrevealed">已写未揭示</option>
                      <option value="foreshadowed">已埋伏笔</option>
                      <option value="revealed">已揭示</option>
                    </select>
                  </label>
                </div>

                {doc.card.extensions && Object.keys(doc.card.extensions).length > 0 && (
                  <Disclosure className="extensions" label="扩展字段（派系包注入；M1 为只读预览）">
                    <pre>{JSON.stringify(doc.card.extensions, null, 2)}</pre>
                  </Disclosure>
                )}

                <textarea
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />

                <div className="editor-foot">
                  <button type="button" className="primary" onClick={save}>
                    保存（baseHash 并发检测）
                  </button>
                  {error ? <span className="error-text">{error}</span> : <span className="muted">{status}</span>}
                </div>
              </>
            )}
          </section>
          <section className="panel naming">
            <h3>
              取名助手 <span className="muted">本地生成 · 离线可用</span>
            </h3>
            <div className="master-grid">
              <label className="field">
                <span>类型</span>
                <select
                  value={namingKind}
                  onChange={(event) => setNamingKind(event.target.value as NamingKindPayload)}
                >
                  {NAMING_KINDS.map((item) => (
                    <option key={item.kind} value={item.kind}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>数量</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={namingCount}
                  onChange={(event) => setNamingCount(Number(event.target.value) || 5)}
                />
              </label>
              <label className="field">
                <span>种子（可留空=换一批）</span>
                <input
                  value={namingSeed}
                  placeholder="填同一个种子可复现"
                  onChange={(event) => setNamingSeed(event.target.value)}
                />
              </label>
            </div>
            <div className="outline-actions">
              <button type="button" onClick={generateNames}>
                生成
              </button>
              {namingResult && (
                <span className="muted">
                  {namingResult.rulesTitle} · 种子 {namingResult.seed}
                </span>
              )}
            </div>
            {namingResult && (
              <>
                <div className="muted naming-pattern">{namingResult.pattern}</div>
                <ul className="name-list">
                  {namingResult.names.map((name) => (
                    <li key={name}>
                      {/* 键盘可达（R110）：真按钮（照记忆页的约定） */}
                      <button type="button" onClick={() => void copyName(name)} title="点击复制">
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {namingNotice && <div className="muted">{namingNotice}</div>}
          </section>
          <section className="panel timeline-view">
            <div className="panel-title">
              时间线（只读 · 刻度统一，历法只是显示）
              {timeline !== null && timeline.calendars.length > 0 && (
                <select className="timeline-calendar" value={calendar} onChange={(event) => setCalendar(event.target.value)}>
                  <option value="">按各时间线自己的历法</option>
                  {timeline.calendars.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}（offset {item.offset}）
                    </option>
                  ))}
                </select>
              )}
            </div>
            {timelineError !== "" && <div className="error-text">{timelineError}</div>}
            {timeline !== null && timelineError === "" && (
              <>
                {/* 汇总**逐行渲染**（R128）：原先是「N 条事件 · 锚定「X」= Year 0 · 历法 M 套」一长串，
                    窄栏里折成三四行；结构**由后端给**（载荷带 summary 行），这里只排版。 */}
                {timeline.summary.length > 0 ? (
                  <SummaryRows rows={timeline.summary} />
                ) : (
                  <div className="timeline-summary muted">{timeline.note}</div>
                )}
                {timeline.findings.length > 0 && (
                  <ul className="timeline-findings">
                    {timeline.findings.map((finding, index) => (
                      <li key={`${finding.id}-${finding.rule}-${index}`} className={`timeline-finding ${finding.severity}`}>
                        <span className="timeline-sev">{finding.severity === "error" ? "冲突" : finding.severity === "warn" ? "存疑" : "提示"}</span>
                        <span className="muted">{finding.rule}</span>
                        <span>{finding.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {timeline.notEvaluated.length > 0 && (
                  <div className="timeline-skipped muted">
                    {timeline.notEvaluated.map((item) => (
                      <div key={item.rule}>
                        未判定 <code>{item.rule}</code>：{item.reason}
                        {item.ids.length > 0 ? `（${item.ids.join("、")}）` : ""}
                      </div>
                    ))}
                  </div>
                )}
                {timeline.rows.length > 0 && (
                  <table className="slot-table timeline-table">
                    <thead>
                      <tr>
                        <th>年份</th>
                        <th>事件</th>
                        <th>刻度</th>
                        <th>角色</th>
                        <th>地点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.rows.map((row) => {
                        const anchor = mapAnchors.find((item) => item.eventRef === row.id);
                        const placeRef = row.placeRef;
                        const placeOnMap = placeRef !== null && mapPlaces.indexOf(placeRef) >= 0;
                        const linked =
                          linkedEvent === row.id ||
                          (linkedPlace !== null && placeRef !== null && linkedPlace === placeRef);
                        return (
                          <tr key={row.id} className={linked ? "is-linked" : undefined} data-event={row.id}>
                            <td>{row.displayYear ?? "历法未识别"}</td>
                            <td>
                              {row.title} <span className="muted">{row.id}</span>
                              {/* 时空联动（R132）：这个事件在地图上有锚点 ⇒ 给一个入口跳过去 */}
                              {anchor !== undefined && (
                                <button
                                  type="button"
                                  className="timeline-map-link"
                                  onClick={() => jumpToMap(row.id)}
                                >
                                  地图上有锚点
                                </button>
                              )}
                              {/* 地点联动（R133）：这个事件发生的地点在地图上 ⇒ 给一个入口跳过去 */}
                              {placeOnMap && (
                                <button
                                  type="button"
                                  className="timeline-map-link"
                                  onClick={() => jumpToPlace(placeRef ?? "")}
                                >
                                  这个地点在地图上
                                </button>
                              )}
                              {/* 地点引用在、但地图上没这个地点 ⇒ **说出来**（不静默：
                                  可能是作者写错了 id，也可能是他还没把这个地点标上） */}
                              {placeRef !== null && !placeOnMap && (
                                <span className="muted"> 地点 {placeRef}（地图上没这个地点）</span>
                              )}
                            </td>
                            <td>{row.year}</td>
                            <td>{row.kind ?? "—"}</td>
                            <td>{row.location ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <div className="muted">
                  真源 <code>{timeline.path}</code> 只存内部数字年（锚定事件 = 0）；上面的历法切换不写文件。
                </div>
              </>
            )}
          </section>
          <section className="panel foreshadow-board">
            <div className="panel-title">伏笔台账（只读 · 判定在引擎）</div>
            {boardError !== "" && <div className="error-text">{boardError}</div>}
            {board !== null && boardError === "" && (
              <>
                {/* 汇总**逐行渲染**（R127）：原先是「读到 N 条伏笔；…；共 N 条 · 未回收 N · 已回收 N · …」
                    一长串，窄栏里折成三四行；结构**由后端给**（载荷带 summary 行），这里只排版。 */}
                {board.summary.length > 0 ? (
                  <SummaryRows rows={board.summary} />
                ) : (
                  <div className="foreshadow-summary muted">{board.note}</div>
                )}
                {board.findings.length > 0 && (
                  <ul className="foreshadow-findings">
                    {board.findings.map((finding, index) => (
                      <li key={`${finding.id}-${finding.rule}-${index}`} className={`foreshadow-finding ${finding.severity}`}>
                        <span className="foreshadow-sev">{finding.severity === "error" ? "必须处理" : finding.severity === "warn" ? "建议处理" : "提示"}</span>
                        <span className="muted">{finding.rule}</span>
                        <span>{finding.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {board.rows.length > 0 && (
                  <table className="slot-table foreshadow-table">
                    <thead>
                      <tr>
                        <th>伏笔</th>
                        <th>状态</th>
                        <th>看板</th>
                        <th>逾期</th>
                        <th>距上次动作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.rows.map((row) => (
                        <tr key={row.id}>
                          {/* R162：这两个 data-* 是**给右栏对账用的**——右栏的名单与这一行逐字对上（预演能核） */}
                          <td data-foreshadow-name={row.name}>
                            {row.name}
                            {row.isRedHerring ? <span className="foreshadow-rh">红鲱鱼</span> : null}
                          </td>
                          <td>{row.state}</td>
                          <td data-foreshadow-board={row.board}>
                            {row.board === "open" ? "未回收" : "已闭环"}
                          </td>
                          <td>{row.overdueBy === null ? "—" : `逾期 ${row.overdueBy} 章`}</td>
                          <td>{row.sinceAction === null ? "—" : `${row.sinceAction} 章`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="muted">
                  登记方式：直接编辑 <code>{board.path}</code>（真源）。引擎不替你写伏笔，只告诉你哪几条还欠读者一个兑现；
                  红鲱鱼与"放弃 + 理由"是合法终态，不会被报成问题。
                </div>
              </>
            )}
          </section>
          {/* R162：面板把**同一个载荷对象**报上来 ⇒ 右栏的产物摘要与中栏那张表读的是同一份载荷 */}
          <SatisfactionPanel onBoard={setSatisfactionBoard} />
          <ChronologyPanel onBook={setChronicleBook} />
        </div>

        {/* 右栏 = 产物（R162）：这一页"我做出了什么"（伏笔 / 爽点 / 编年史三块的结论摘要与名单） */}
        <aside className="archive-col-outputs">
          {artifacts.map((block) => (
            <section
              key={block.key}
              className="panel archive-artifacts"
              data-archive-artifacts={block.key}
              data-artifact-listed={String(block.counts.listed)}
              data-artifact-marked={String(block.counts.marked)}
              data-artifact-names={block.items.map((item) => item.name).join("、")}
              data-artifact-states={block.items.map((item) => item.state).join("、")}
            >
              <div className="panel-title">{block.title}</div>
              {block.note !== "" ? (
                <div className="muted">{block.note}</div>
              ) : (
                <>
                  {/* 结论摘要：载荷自己的结构化行（与中栏那张表读的是**同一份载荷** ⇒ 逐字对得上） */}
                  {block.summary.length > 0 && <SummaryRows rows={block.summary} />}
                  <ul className="archive-artifact-list">
                    {block.items.slice(0, ARCHIVE_ARTIFACT_MAX_ITEMS).map((item) => (
                      <li key={item.id}>
                        <span className="muted">{item.state}</span>
                        <span>{item.name}</span>
                      </li>
                    ))}
                  </ul>
                  {block.items.length > ARCHIVE_ARTIFACT_MAX_ITEMS && (
                    <div className="muted">
                      其余 {block.items.length - ARCHIVE_ARTIFACT_MAX_ITEMS} 条没列出来（清单在中栏那张表里）
                    </div>
                  )}
                  <div className="muted">
                    {`${block.counts.listedLabel} ${String(block.counts.listed)} 条 · ${block.counts.markedLabel} ${String(block.counts.marked)} 条`}
                    {block.counts.extra !== null &&
                      ` · ${block.counts.extra.label} ${String(block.counts.extra.value)}`}
                  </div>
                </>
              )}
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}
