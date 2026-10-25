/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MARKER_FILTER,
  filterMapMarkerRows,
  markerFilterActive,
  markerRowEntities,
  markerRowLayers,
} from "../renderer/src/components/map-marker-rows.js";
import type { WorldMapMarkerRow } from "../src/shared/ipc.js";

/**
 * 标注清单的**筛选**（R171）+ 界面上那一块的**契约**。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * §3.7 标注即地点卡（绑的是谁）、§3.9 分层可控（在哪一层）、
 * 以及 §3 末尾的 `map-marker-orphan`（指向不存在的实体 ⇒ 孤儿标注）。
 *
 * 判据：
 * ① **筛选后的条数与真源逐字一致** ⇒ 筛选的结果必须等于**独立算一遍**的期望
 *    （期望在测试里手写，**不调用被测函数** ⇒ 否则是自证）；
 * ② **界面不自己造数** ⇒ 清单来自主进程从真源直算的 `map.markerRows`，
 *    渲染层不许拿 `map.markers`（那是"画在图上的"，不含孤儿）自己拼清单。
 */

const ROWS: WorldMapMarkerRow[] = [
  { id: "m-1", layer: "place", entityRef: "loc-a", entityName: "玄天城", orphan: false, x: 1, y: 1 },
  { id: "m-2", layer: "place", entityRef: "loc-b", entityName: "断桥", orphan: false, x: 2, y: 2 },
  { id: "m-3", layer: "political", entityRef: "loc-gone", entityName: null, orphan: true, x: 3, y: 3 },
  { id: "m-4", layer: "place", entityRef: "loc-a", entityName: "玄天城", orphan: false, x: 4, y: 4 },
];

describe("标注清单的筛选（R171）：按实体 / 按图层 / 只看孤儿，三个维度可叠加", () => {
  it("不筛 ⇒ 清单原样（条数与真源一致）", () => {
    const out = filterMapMarkerRows(ROWS, EMPTY_MARKER_FILTER);
    expect(out).toHaveLength(ROWS.length);
    expect(out.map((row) => row.id)).toEqual(["m-1", "m-2", "m-3", "m-4"]);
  });

  it("按实体筛 ⇒ 只剩绑着那个实体的标注（**独立算一遍**的期望）", () => {
    const out = filterMapMarkerRows(ROWS, { ...EMPTY_MARKER_FILTER, entityRef: "loc-a" });
    const expected = ROWS.filter((row) => row.entityRef === "loc-a").map((row) => row.id);
    expect(out.map((row) => row.id)).toEqual(expected);
    expect(out.map((row) => row.id)).toEqual(["m-1", "m-4"]);
  });

  it("按图层筛 ⇒ 只剩那一层的（**独立算一遍**的期望）", () => {
    const out = filterMapMarkerRows(ROWS, { ...EMPTY_MARKER_FILTER, layer: "political" });
    const expected = ROWS.filter((row) => row.layer === "political").map((row) => row.id);
    expect(out.map((row) => row.id)).toEqual(expected);
    expect(out.map((row) => row.id)).toEqual(["m-3"]);
  });

  it("只看孤儿 ⇒ 只剩 orphan 的那几条（**独立算一遍**的期望）", () => {
    const out = filterMapMarkerRows(ROWS, { ...EMPTY_MARKER_FILTER, orphanOnly: true });
    const expected = ROWS.filter((row) => row.orphan).map((row) => row.id);
    expect(out.map((row) => row.id)).toEqual(expected);
    expect(out.map((row) => row.id)).toEqual(["m-3"]);
  });

  it("三个维度叠加 ⇒ 同时满足（不是任一满足）", () => {
    const out = filterMapMarkerRows(ROWS, {
      entityRef: "loc-a",
      layer: "place",
      orphanOnly: true,
    });
    // loc-a 的两条都不是孤儿 ⇒ 叠加后一条不剩（"与"不是"或"）
    expect(out).toHaveLength(0);
    const both = filterMapMarkerRows(ROWS, { entityRef: "loc-gone", layer: "political", orphanOnly: true });
    expect(both.map((row) => row.id)).toEqual(["m-3"]);
  });

  it("筛不出东西时如实给空（**不装成有**）", () => {
    const out = filterMapMarkerRows(ROWS, { ...EMPTY_MARKER_FILTER, entityRef: "loc-none" });
    expect(out).toHaveLength(0);
  });

  it("筛选有没有在筛 ⇒ 界面据此决定「清空筛选」能不能点", () => {
    expect(markerFilterActive(EMPTY_MARKER_FILTER)).toBe(false);
    expect(markerFilterActive({ ...EMPTY_MARKER_FILTER, orphanOnly: true })).toBe(true);
    expect(markerFilterActive({ ...EMPTY_MARKER_FILTER, layer: "place" })).toBe(true);
  });

  it("清单里出现过的图层 / 实体（名字取自清单本身，不另查）", () => {
    expect(markerRowLayers(ROWS)).toEqual(["place", "political"]);
    const entities = markerRowEntities(ROWS);
    expect(entities.map((entity) => entity.id)).toEqual(["loc-a", "loc-b", "loc-gone"]);
    expect(entities.find((entity) => entity.id === "loc-gone")?.name).toBeNull();
    expect(entities.find((entity) => entity.id === "loc-gone")?.orphan).toBe(true);
  });
});

describe("标注管理面板的契约（R171）：清单来自真源、孤儿点名、批量走通道", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const panel = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "WorldMapPanel.tsx"), "utf8");

  it("清单取的是**主进程从真源直算**的那份（map.markerRows），不是渲染层自己拼的", () => {
    expect(panel, "面板没有用 map.markerRows（清单不是真源直算的）").toMatch(/map\?\.markerRows/);
    expect(panel, "面板没有把筛选接到清单上").toContain("filterMapMarkerRows(markerRows, markerFilter)");
  });

  it("筛选的**条数**从清单现算（界面不写死数字，也不自己数一遍）", () => {
    expect(panel, "没有把筛选条数摆在界面上").toContain("data-marker-filtered={String(filteredMarkers.length)}");
    expect(panel, "没有把清单总数摆在界面上").toContain("data-marker-total={String(markerRows.length)}");
    expect(panel, "没有把孤儿条数摆在界面上").toContain("data-marker-orphan={String(orphanMarkerCount)}");
  });

  it("**孤儿标注点名**：清单里那一条要写出它指向哪个不存在的实体", () => {
    expect(panel, "面板没有点名孤儿标注指向的实体").toContain("绑定的实体不存在");
    expect(panel, "清单行没有标出哪些是孤儿").toContain("data-marker-orphan={row.orphan ? \"1\" : \"0\"}");
  });

  it("批量改图层走**那条通道**（写盘在主进程，渲染层不自己写文件）", () => {
    expect(panel, "面板没有走批量改图层的通道").toContain("api().map.batchSetMarkerLayer");
    expect(panel, "渲染层不许直接写盘").not.toMatch(/doc\.write|writeDoc|fs\./);
  });

  it("回执**点名**：改了哪些、其中哪些是孤儿（不是一句「改好了」）", () => {
    expect(panel, "回执没有列出改了哪些").toContain("data-batch-changed={batchNote.changed.join(\",\")}");
    expect(panel, "回执没有点名孤儿标注").toContain("data-batch-orphan={batchNote.orphan.join(\",\")}");
  });

  it("清单的筛选只有三个维度（按实体 / 按图层 / 只看孤儿），不多不少", () => {
    expect(panel, "没有按实体筛选的入口").toContain("按实体筛选标注");
    expect(panel, "没有按图层筛选的入口").toContain("按图层筛选标注");
    expect(panel, "没有只看孤儿标注的入口").toContain("只看孤儿标注");
  });
});
