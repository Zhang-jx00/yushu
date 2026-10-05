import { describe, expect, it } from "vitest";
import { diffLines, merge3 } from "../renderer/src/chapter-merge";

describe("行级 diff（Myers，T2-6 三方合并内置）", () => {
  it("相同文本无差异块", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("纯追加 / 纯删除 / 行内替换", () => {
    expect(diffLines(["a", "b"], ["a", "b", "c"])).toEqual([{ baseStart: 2, baseEnd: 2, lines: ["c"] }]);
    expect(diffLines(["a", "b", "c"], ["a", "b"])).toEqual([{ baseStart: 2, baseEnd: 3, lines: [] }]);
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([{ baseStart: 1, baseEnd: 2, lines: ["x"] }]);
  });

  it("多处分散改动 → 多个块且按位置有序", () => {
    const hunks = diffLines(["1", "2", "3", "4", "5", "6", "7"], ["1", "X", "3", "4", "5", "Y", "7"]);
    expect(hunks).toEqual([
      { baseStart: 1, baseEnd: 2, lines: ["X"] },
      { baseStart: 5, baseEnd: 6, lines: ["Y"] },
    ]);
  });

  it("首尾改动与空输入", () => {
    expect(diffLines([], ["a"])).toEqual([{ baseStart: 0, baseEnd: 0, lines: ["a"] }]);
    expect(diffLines(["a"], [])).toEqual([{ baseStart: 0, baseEnd: 1, lines: [] }]);
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines(["a"], ["b", "a"])).toEqual([{ baseStart: 0, baseEnd: 0, lines: ["b"] }]);
    expect(diffLines(["a"], ["a", "b"])).toEqual([{ baseStart: 1, baseEnd: 1, lines: ["b"] }]);
  });

  it("较大文档两处远端改动仍精确定位（不整体替换）", () => {
    const base = Array.from({ length: 800 }, (_, i) => `line-${i}`);
    const local = base.slice();
    local[10] = "line-10-local";
    local[700] = "line-700-local";
    const hunks = diffLines(base, local);
    expect(hunks).toEqual([
      { baseStart: 10, baseEnd: 11, lines: ["line-10-local"] },
      { baseStart: 700, baseEnd: 701, lines: ["line-700-local"] },
    ]);
  });

  it("大段重写超过差异上限 → 回退整段替换单块（保守）", () => {
    const base = Array.from({ length: 1200 }, (_, i) => `a${i}`);
    const other = Array.from({ length: 1200 }, (_, i) => `b${i}`);
    const hunks = diffLines(base, other);
    expect(hunks).toEqual([{ baseStart: 0, baseEnd: 1200, lines: other }]);
  });
});

describe("三方合并 merge3（T2-6 完整版）", () => {
  it("无改动 / 仅单侧改动", () => {
    expect(merge3("a\nb", "a\nb", "a\nb")).toEqual({ clean: true, conflicts: 0, text: "a\nb" });
    expect(merge3("a\nb", "a\nb", "a\nr")).toEqual({ clean: true, conflicts: 0, text: "a\nr" });
    expect(merge3("a\nb", "a\nl", "a\nb")).toEqual({ clean: true, conflicts: 0, text: "a\nl" });
  });

  it("远端改开头 + 本地追加结尾 → 干净合并（双方改动都保留）", () => {
    const base = "第一行\n第二行\n第三行";
    const local = "第一行\n第二行\n第三行\n本地追加";
    const remote = "外部改第一行\n第二行\n第三行";
    const result = merge3(base, local, remote);
    expect(result.clean).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.text).toBe("外部改第一行\n第二行\n第三行\n本地追加");
  });

  it("远端删除一处 + 本地修改另一处 → 干净合并", () => {
    const base = "a\nb\nc\nd";
    const local = "a\nB\nc\nd";
    const remote = "a\nb\nd";
    const result = merge3(base, local, remote);
    expect(result.clean).toBe(true);
    expect(result.text).toBe("a\nB\nd");
  });

  it("双方改同一行（结果不同）→ 冲突，输出 diff3 标记与冲突数", () => {
    const result = merge3("a\nb\nc", "a\nlocal\nc", "a\nremote\nc");
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toContain("<<<<<<< 本地（编辑器）");
    expect(result.text).toContain("local");
    expect(result.text).toContain("||||||| 基础（上次保存）");
    expect(result.text).toContain("=======");
    expect(result.text).toContain("remote");
    expect(result.text).toContain(">>>>>>> 磁盘（外部改动）");
  });

  it("双方在文件末尾插入不同内容（零宽同位置）→ 冲突；插入相同内容 → 干净", () => {
    const conflict = merge3("a\nb", "a\nb\nlocal", "a\nb\nremote");
    expect(conflict.clean).toBe(false);
    expect(conflict.conflicts).toBe(1);
    const same = merge3("a\nb", "a\nb\nsame", "a\nb\nsame");
    expect(same.clean).toBe(true);
    expect(same.text).toBe("a\nb\nsame");
  });

  it("零宽插入与相邻改动（贴边）→ 保守判定为冲突", () => {
    const result = merge3("a\nb\nc", "a\nX\nb\nc", "a\nB\nc");
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
  });

  it("一侧删除整行、另一侧修改该行 → 冲突", () => {
    const result = merge3("a\nb\nc", "a\nc", "a\nB\nc");
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
  });

  it("多处冲突按簇计数；干净区段仍完成合并", () => {
    const base = "a\nb\nc\nd\ne\nf\ng";
    const local = "a\nL1\nc\nd\nL2\nf\ng";
    const remote = "a\nR1\nc\nd\nR2\nf\ng";
    const result = merge3(base, local, remote);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(2);
    expect(result.text.startsWith("a\n<<<<<<<")).toBe(true);
  });

  it("CRLF 归一为 LF；行尾连续换行按序列化细节归一（不带入结果）", () => {
    const result = merge3("a\r\nb\r\n", "a\r\nb\r\nc\r\n", "A\r\nb\r\n");
    expect(result.clean).toBe(true);
    expect(result.text).toBe("A\nb\nc");
  });

  it("尾换行口径差异不误判冲突（编辑器内容无尾换行 × 磁盘有尾换行；实测暴露的假冲突）", () => {
    const result = merge3("a\nb", "a\nb\n\n本地追加。", "外部改动\n\na\nb\n");
    expect(result.clean).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.text).toBe("外部改动\n\na\nb\n\n本地追加。");
  });

  it("冲突文本可经 sidecar 落盘（含完整三方内容）", () => {
    const result = merge3("base-1\nbase-2", "local-1\nbase-2", "remote-1\nbase-2");
    expect(result.clean).toBe(false);
    expect(result.text).toContain("base-1");
    expect(result.text).toContain("local-1");
    expect(result.text).toContain("remote-1");
  });
});