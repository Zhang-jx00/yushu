/**
 * 虚拟滚动窗口计算（M2 / T2-4 切片 A「全库视图虚拟滚动」）：
 * 固定行高列表 → 由滚动位置与视口高度算出「应渲染的行区间」与上下占位，
 * 百万字 / 数百章级项目只挂载视窗内的行（其余以占位高度撑起滚动条）。
 * 纯函数、零依赖，便于单测钉住边界（空列表 / 底部夹紧 / 过扫描）。
 */

export interface VirtualWindow {
  /** 渲染区间 [start, end)（含上下过扫描行） */
  start: number;
  end: number;
  /** 顶部占位高度（px）：start 之前的总高 */
  padTop: number;
  /** 列表内容总高（px）：用于撑起滚动条 */
  totalHeight: number;
}

export function computeVirtualWindow(params: {
  itemCount: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  /** 视口上下各多渲染几行（滚动更顺滑；默认 4） */
  overscan?: number;
}): VirtualWindow {
  const { itemCount, itemHeight, scrollTop, viewportHeight } = params;
  const overscan = Math.max(0, Math.floor(params.overscan ?? 4));
  if (itemCount <= 0 || itemHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
  }
  const safeScrollTop = Math.max(0, scrollTop);
  // start 夹紧到 [0, itemCount - 1]：越界 scrollTop（内容收缩后的陈旧值）不应产生空窗口
  const first = Math.min(
    Math.max(0, Math.floor(safeScrollTop / itemHeight) - overscan),
    Math.max(0, itemCount - 1),
  );
  const last = Math.ceil((safeScrollTop + Math.max(0, viewportHeight)) / itemHeight) + overscan;
  const end = Math.min(itemCount, Math.max(last, first + 1));
  return { start: first, end, padTop: first * itemHeight, totalHeight: itemCount * itemHeight };
}