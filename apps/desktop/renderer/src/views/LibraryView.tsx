/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryChapterEntry, LibraryViewPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { Disclosure } from "../components/Disclosure";
import { ImportPanel } from "../components/ImportPanel";
import { PublishPanel } from "../components/PublishPanel";
import { computeVirtualWindow } from "../virtual-list";
import { buildOutlineTree, flattenOutlineRows } from "../components/outline-tree";

/**
 * 稿件总览（M2 / T2-4 切片 A「全库视图 + 虚拟滚动」）：
 * 一行一章展示全书（含未建草稿），固定行高 + 虚拟滚动（只挂载视窗内行，数百章项目不卡顿）；
 * 「打开」跳转编辑器并选中该章（由 ProjectScreen 协调）。
 *
 * 存量导入面板（M5 / T5-7，R77）挂在总览里，默认收起：导完就能在这里看到进来的章，
 * 收起状态不占列表高度（列表是 flex:1，展开时按真实高度让位）。
 *
 * **R155：三栏**（docs/11 §7.34）——
 * 左=**卷章树**（按卷分组，点一章就选中它）、
 * 中=**全库**（原来那一摞：提示 / 导入 / 发布状态 / 虚拟列表）、
 * 右=**选中的那章的产物**（字数 / 状态 / 草稿文件 / 快照 hash）。
 *
 * 为什么右栏摆的是这些：作者从总览这一页问的是「这一章到底写出来没有、写成了什么样」⇒
 * 右栏答的就是这个；数字全部从**同一份载荷**现算（不另取数 ⇒ 同一个数不会有两处）。
 */

/** 行高（px；固定行高是虚拟滚动的前提） */
const ROW_HEIGHT = 56;

/** R168：卷章树的行高（px）——卷头行与章行**同高**（固定行高是虚拟窗口算术的前提）；
   高度由 JS 内联到每一行（CSS 不另写一遍 ⇒ 一处定义，两处必然一致） */
const TREE_ROW_HEIGHT = 26;

export function LibraryView({ onOpen }: { onOpen: (path: string) => void }) {
  const [data, setData] = useState<LibraryViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  /** R168：卷章树的虚拟滚动（几百卷/几百章时只挂窗口内的几十行） */
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const [treeViewport, setTreeViewport] = useState(360);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** R155：右栏正在摆**哪一章**（空 = 还没选） */
  const [selectedId, setSelectedId] = useState("");

  const refresh = async () => {
    try {
      setError(null);
      setData(await api().library.list());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // 视口高度测量（窗口 / 布局变化时更新——虚拟窗口按真实高度计算）
  useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    const update = () => setViewportHeight(el.clientHeight || 360);
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [data]);

  // R168：卷章树视口高度测量（同全库列表一套做法）
  useEffect(() => {
    const el = treeRef.current;
    if (el === null) return;
    const update = () => setTreeViewport(el.clientHeight || 360);
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [data]);

  const filtered = useMemo(() => {
    const list = data?.chapters ?? [];
    const keyword = filter.trim();
    if (keyword === "") return list;
    return list.filter(
      (item) =>
        item.title.includes(keyword) ||
        item.volumeTitle.includes(keyword) ||
        (item.chapterPath?.includes(keyword) ?? false),
    );
  }, [data, filter]);

  /**
   * R155 左栏的**卷章树**：按卷分组（从同一份 `chapters` 现算 ⇒ 不另取数）。
   *
   * 分组只认 `volumeId` 相邻 ⇒ 顺序与总览里那一份完全一致（不重排、不排序）。
   *
   * R164：这棵树改走**共用**的 `buildOutlineTree`（大纲页那棵也是它 ⇒ 两页的树不会长歪）。
   */
  const volumes = useMemo(
    () =>
      buildOutlineTree(
        (data?.chapters ?? []).map((item) => ({
          id: item.chapterId,
          title: item.title,
          volumeId: item.volumeId,
          volumeTitle: item.volumeTitle,
          idx: item.idx,
          wordCount: item.wordCount,
          status: item.status,
          chapterPath: item.chapterPath,
        })),
      ),
    [data],
  );

  /** R155 右栏：选中那一章（**全库**与**卷章树**选中的是同一个 id ⇒ 两处不会各说各话） */
  const selected = useMemo(
    () => (data?.chapters ?? []).find((item) => item.chapterId === selectedId) ?? null,
    [data, selectedId],
  );

  const vw = computeVirtualWindow({
    itemCount: filtered.length,
    itemHeight: ROW_HEIGHT,
    scrollTop,
    viewportHeight,
  });
  const visible = filtered.slice(vw.start, vw.end);

  /** R168：卷章树的**扁平行**（共用模块摊平 ⇒ 与大纲页那棵同一顺序）+ 虚拟窗口（同全库列表一套算术） */
  const treeRows = useMemo(() => flattenOutlineRows(volumes), [volumes]);
  const treeVw = computeVirtualWindow({
    itemCount: treeRows.length,
    itemHeight: TREE_ROW_HEIGHT,
    scrollTop: treeScrollTop,
    viewportHeight: treeViewport,
  });
  const treeVisible = treeRows.slice(treeVw.start, treeVw.end);

  return (
    <div className="library">
      <div className="panel-title">
        <span className="muted">
          {data
            ? `${data.bookTitle || "（未命名）"} · 共 ${data.totals.chapters} 章（已建草稿 ${data.totals.drafted}）· 总计 ${data.totals.words.toLocaleString("zh-CN")} 字`
            : "加载中…"}
        </span>
        <span className="library-tools">
          <input
            value={filter}
            placeholder="过滤章节 / 卷"
            onChange={(event) => {
              setFilter(event.target.value);
              setScrollTop(0);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
          />
          <button type="button" className="link" onClick={() => void refresh()}>
            刷新
          </button>
        </span>
      </div>
      {/* R155：三栏（docs/11 §7.34）。左=卷章树 / 中=全库 / 右=选中的那章的产物。 */}
      <div className="three-col library-three-col">
        <aside className="library-col-tree">
          <section className="panel">
            <h3>卷章树</h3>
            {volumes.length === 0 ? (
              <p className="muted">还没有卷章（先在「三级大纲」建卷建章）。</p>
            ) : (
              /* R168：**虚拟滚动**——几百卷/几百章时只挂窗口内的几十行
                 （扁平行由共用模块摊平 ⇒ 与大纲页那棵同一顺序；
                   容器上摆 data-tree-* 总数对账锚点，预演按它对账） */
              <div
                className="library-tree-scroll"
                ref={treeRef}
                onScroll={(event) => setTreeScrollTop((event.target as HTMLDivElement).scrollTop)}
                data-tree-total={String(treeRows.length)}
                data-tree-chapters={String(data?.chapters.length ?? 0)}
              >
                <div className="library-tree-spacer" style={{ height: treeVw.totalHeight }}>
                  <div style={{ transform: `translateY(${treeVw.padTop}px)` }}>
                    {treeVisible.map((row) =>
                      row.kind === "volume" ? (
                        <div
                          className="library-tree-row-volume muted"
                          key={"v-" + row.volumeId}
                          style={{ height: TREE_ROW_HEIGHT }}
                        >
                          {row.title}（{row.chapterCount} 章）
                        </div>
                      ) : (
                        <div className="library-tree-row" key={"c-" + row.id} style={{ height: TREE_ROW_HEIGHT }}>
                          <button
                            type="button"
                            className={"library-tree-btn" + (row.id === selectedId ? " is-on" : "")}
                            aria-pressed={row.id === selectedId}
                            data-tree-chapter-id={row.id}
                            onClick={() => setSelectedId(row.id)}
                          >
                            第 {row.idx} 章 {row.title}
                          </button>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        </aside>

        <div className="library-col-work">
          <div className="library-hint muted">
            全库视图（虚拟滚动）：当前渲染 {visible.length} / {filtered.length} 行；「打开」进入编辑器（未建草稿的章节请先在「三级大纲」创建草稿章节）
          </div>
          <Disclosure className="library-import" label="导入存量稿件（先出三份报告，确认后才建卷建章）">
            <ImportPanel />
          </Disclosure>
          <Disclosure className="library-publish" label="发布状态（状态机 / 定时提醒 / 字数闸）">
            <PublishPanel />
          </Disclosure>
          <div
            className="library-list"
            ref={listRef}
            onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}
          >
            <div className="library-spacer" style={{ height: vw.totalHeight }}>
              <div className="library-window" style={{ transform: `translateY(${vw.padTop}px)` }}>
                {visible.map((item) => (
                  <div className="library-row" key={item.chapterId} style={{ height: ROW_HEIGHT }}>
                    <span className="library-idx">第 {item.idx} 章</span>
                    <div className="library-main">
                      {/* R155：标题做成**真按钮**（点它 = 选中这一章 ⇒ 右栏跟着换；
                          键盘也能到 ⇒ 键盘债 0） */}
                      <button
                        type="button"
                        className={"library-title-btn" + (item.chapterId === selectedId ? " is-on" : "")}
                        aria-pressed={item.chapterId === selectedId}
                        onClick={() => setSelectedId(item.chapterId)}
                      >
                        {item.title}
                      </button>
                      <span className="muted">
                        {item.volumeTitle}
                        {item.status ? ` · ${item.status}` : ""}
                      </span>
                    </div>
                    <span className="muted library-words">
                      {item.chapterPath ? `${item.wordCount.toLocaleString("zh-CN")} 字` : "未建草稿"}
                    </span>
                    <button
                      type="button"
                      disabled={!item.chapterPath}
                      title={item.chapterPath ? "打开编辑器并选中该章" : "尚未创建草稿章节（三级大纲 → 创建草稿章节）"}
                      onClick={() => {
                        if (item.chapterPath) onOpen(item.chapterPath);
                      }}
                    >
                      打开
                    </button>
                  </div>
                ))}
              </div>
            </div>
            {filtered.length === 0 && <div className="muted pad">无匹配章节</div>}
          </div>
        </div>

        <aside className="library-col-outputs">
          <section className="panel">
            <div className="panel-title">
              <span className="muted">选中的那章</span>
            </div>
            {selected === null ? (
              <p className="muted">左边点一章，这里摆它的产物（字数 / 状态 / 草稿文件 / 快照）。</p>
            ) : (
              <ul className="library-outputs">
                <li>
                  <span className="muted">标题</span>
                  <span>{selected.title}</span>
                </li>
                <li>
                  <span className="muted">卷 / 章序</span>
                  <span>
                    {selected.volumeTitle} · 第 {selected.idx} 章
                  </span>
                </li>
                <li>
                  <span className="muted">字数</span>
                  <span>
                    {selected.chapterPath === null
                      ? "未建草稿"
                      : `${selected.wordCount.toLocaleString("zh-CN")} 字`}
                  </span>
                </li>
                <li>
                  <span className="muted">状态</span>
                  <span>{selected.status === "" ? "—" : selected.status}</span>
                </li>
                <li>
                  <span className="muted">草稿文件</span>
                  <span>{selected.chapterPath ?? "—"}</span>
                </li>
                <li>
                  <span className="muted">快照</span>
                  <span>{selected.hash ?? "—"}</span>
                </li>
              </ul>
            )}
          </section>
        </aside>
      </div>
      {error ? <div className="error-text pad">{error}</div> : null}
    </div>
  );
}
