import { describe, expect, it } from "vitest";
import {
  IdError,
  isValidEntityId,
  makeId,
  parseId,
  qualifyId,
  splitQualifiedId,
} from "@yushu/core";

describe("ids", () => {
  it("makeId 带种子时输出确定", () => {
    const a = makeId("char", "林渊");
    const b = makeId("char", "林渊");
    expect(a).toBe(b);
    expect(a.startsWith("char-")).toBe(true);
    expect(isValidEntityId(a)).toBe(true);
  });

  it("makeId 不带种子时输出随机且合法", () => {
    const a = makeId("ch");
    const b = makeId("ch");
    expect(a).not.toBe(b);
    expect(isValidEntityId(a)).toBe(true);
    expect(isValidEntityId(b)).toBe(true);
  });

  it("parseId 解析前缀与本地段", () => {
    expect(parseId("char-linyuan")).toEqual({ prefix: "char", local: "linyuan" });
    expect(parseId("bad")).toBeNull();
    expect(parseId("zzz-linyuan")).toBeNull();
  });

  it("非法实体 ID 被拒绝", () => {
    expect(isValidEntityId("char-")).toBe(false);
    expect(isValidEntityId("char-LinYuan")).toBe(false);
    expect(isValidEntityId("char linyuan")).toBe(false);
    expect(isValidEntityId("unknown-linyuan")).toBe(false);
  });

  it("命名空间元素 ID 往返", () => {
    const q = qualifyId("xuanhuan-xitong", "realm-system");
    expect(q).toBe("xuanhuan-xitong/realm-system");
    expect(splitQualifiedId(q)).toEqual({
      namespace: "xuanhuan-xitong",
      elementId: "realm-system",
    });
    expect(splitQualifiedId("a/b/c")).toBeNull();
    expect(() => qualifyId("非法 命名空间", "x")).toThrow(IdError);
  });
});