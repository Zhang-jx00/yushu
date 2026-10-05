import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryViewPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { computeVirtualWindow } from "../virtual-list";

/**
 * 稿件总览（M2 / T2-4 切片 A「全库视图 + 虚拟滚动」）：
 * 一行一章展示全书（含未建草稿），固定行高 + 虚拟滚动（只挂载视窗内行，数百章项目不卡顿）；
 * 「打开」跳转编辑器并选中该章（由 ProjectScreen 协调）。
 */

/** 行高（px；固定行高是虚拟滚动的前提） */
const ROW_HEIGHT = 56;

export function LibraryView({ onOpen }: { onOpen: (path: string) => void }) {
  const [data, setData] = useState<LibraryViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const listRef = useRef<HTMLDivElement | null>(null);

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
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight || 360);
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

  const vw = computeVirtualWindow({
    itemCount: filtered.length,
    itemHeight: ROW_HEIGHT,
    scrollTop,
    viewportHeight,
  });
  const visible = filtered.slice(vw.start, vw.end);

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
      <div className="library-hint muted">
        全库视图（虚拟滚动）：当前渲染 {visible.length} / {filtered.length} 行；「打开」进入编辑器（未建草稿的章节请先在「三级大纲」创建草稿章节）
      </div>
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
                  <strong>{item.title}</strong>
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
      {error ? <div className="error-text pad">{error}</div> : null}
    </div>
  );
}