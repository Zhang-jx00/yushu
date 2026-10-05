import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "../renderer/src/virtual-list";

describe("虚拟滚动窗口（T2-4 切片 A）", () => {
  it("空列表 / 非法行高 → 空窗口", () => {
    expect(
      computeVirtualWindow({ itemCount: 0, itemHeight: 56, scrollTop: 0, viewportHeight: 400 }),
    ).toEqual({ start: 0, end: 0, padTop: 0, totalHeight: 0 });
    expect(
      computeVirtualWindow({ itemCount: 10, itemHeight: 0, scrollTop: 0, viewportHeight: 400 }),
    ).toEqual({ start: 0, end: 0, padTop: 0, totalHeight: 0 });
  });

  it("顶部：从 0 开始并含过扫描；总高 = 行数 × 行高", () => {
    const vw = computeVirtualWindow({ itemCount: 100, itemHeight: 50, scrollTop: 0, viewportHeight: 300, overscan: 2 });
    expect(vw.start).toBe(0);
    expect(vw.end).toBe(Math.ceil(300 / 50) + 2); // 可见 6 行 + 过扫描 2
    expect(vw.padTop).toBe(0);
    expect(vw.totalHeight).toBe(5000);
  });

  it("中部：窗口随滚动平移（起点含过扫描，顶部占位同步）", () => {
    const vw = computeVirtualWindow({ itemCount: 100, itemHeight: 50, scrollTop: 1000, viewportHeight: 300, overscan: 2 });
    expect(vw.start).toBe(18); // floor(1000/50) - 2
    expect(vw.end).toBe(28); // ceil(1300/50) + 2
    expect(vw.padTop).toBe(900);
  });

  it("底部与越界滚动：end 夹紧到 itemCount，start 不越界、窗口非空", () => {
    const bottom = computeVirtualWindow({ itemCount: 100, itemHeight: 50, scrollTop: 4700, viewportHeight: 300, overscan: 2 });
    expect(bottom.end).toBe(100);
    expect(bottom.start).toBe(92); // floor(4700/50) - 2
    const beyond = computeVirtualWindow({ itemCount: 100, itemHeight: 50, scrollTop: 99999, viewportHeight: 300, overscan: 2 });
    expect(beyond.start).toBe(99);
    expect(beyond.end).toBe(100);
  });

  it("行数少于视口：全量渲染且窗口不越界", () => {
    const vw = computeVirtualWindow({ itemCount: 3, itemHeight: 56, scrollTop: 0, viewportHeight: 600, overscan: 4 });
    expect(vw.start).toBe(0);
    expect(vw.end).toBe(3);
    expect(vw.totalHeight).toBe(168);
  });
});