import { describe, expect, it } from "vitest";
import {
  BUILTIN_NAMING_RULES,
  NamingError,
  getNamingRules,
  makeNames,
  namingRulesForWorld,
  type NamingKind,
} from "@yushu/world-engine";

const KINDS: NamingKind[] = ["character", "place", "sect", "technique"];

describe("命名规则（T1-8）", () => {
  it("内置三套文化规则且字库齐全", () => {
    expect(BUILTIN_NAMING_RULES.map((rules) => rules.id)).toEqual(["xianxia", "western", "modern"]);
    for (const rules of BUILTIN_NAMING_RULES) {
      expect(rules.title).toBeTruthy();
      expect(rules.pattern).toBeTruthy();
      for (const key of [
        "surnames",
        "givenChars",
        "placePrefixes",
        "placeSuffixes",
        "sectPrefixes",
        "sectSuffixes",
        "techniquePrefixes",
        "techniqueSuffixes",
      ] as const) {
        expect(rules[key].length, `${rules.id}.${key}`).toBeGreaterThanOrEqual(4);
      }
    }
    expect(getNamingRules("xianxia")?.title).toBe("仙侠玄幻");
    expect(getNamingRules("nope")).toBeNull();
  });

  it("世界维度 → 规则：玄幻/西幻/都市各自映射，未知兜底仙侠", () => {
    expect(namingRulesForWorld(["玄幻"]).id).toBe("xianxia");
    expect(namingRulesForWorld(["西幻"]).id).toBe("western");
    expect(namingRulesForWorld(["现实都市"]).id).toBe("modern");
    expect(namingRulesForWorld(["未知维度"]).id).toBe("xianxia");
  });
});

describe("生成器", () => {
  it("显式种子 → 结果确定（可复现）", () => {
    for (const kind of KINDS) {
      const first = makeNames(kind, { seed: 42, count: 6 });
      const second = makeNames(kind, { seed: 42, count: 6 });
      expect(second).toEqual(first);
      expect(first).toHaveLength(6);
      expect(new Set(first).size).toBe(6); // 同批去重
    }
  });

  it("不同种子产生不同批次（大概率）", () => {
    const a = makeNames("character", { seed: 1, count: 8 }).join("|");
    const b = makeNames("character", { seed: 2, count: 8 }).join("|");
    expect(a).not.toBe(b);
  });

  it("结构符合规则：角色=姓+名，其余=前缀+后缀，且字符合法", () => {
    const rules = getNamingRules("xianxia")!;
    for (const name of makeNames("character", { rules, seed: "s", count: 20 })) {
      const surname = rules.surnames.find((item) => name.startsWith(item));
      expect(surname, `角色名 ${name} 应以字库姓氏开头`).toBeTruthy();
      expect(name.length).toBeGreaterThanOrEqual(2);
      expect(name.length).toBeLessThanOrEqual(4);
      const given = name.slice(surname!.length);
      for (const ch of given) expect(rules.givenChars).toContain(ch);
    }
    for (const name of makeNames("place", { rules, seed: "s", count: 10 })) {
      expect(rules.placeSuffixes.some((suffix) => name.endsWith(suffix))).toBe(true);
    }
    for (const name of makeNames("sect", { rules, seed: "s", count: 10 })) {
      expect(rules.sectSuffixes.some((suffix) => name.endsWith(suffix))).toBe(true);
    }
    for (const name of makeNames("technique", { rules, seed: "s", count: 10 })) {
      expect(rules.techniqueSuffixes.some((suffix) => name.endsWith(suffix))).toBe(true);
    }
  });

  it("按规则 id 字符串指定文化；未知规则与非法类型报错", () => {
    const names = makeNames("place", { rules: "western", seed: 7, count: 3 });
    expect(names).toHaveLength(3);
    expect(() => makeNames("character", { rules: "nope" })).toThrow(NamingError);
    expect(() => makeNames("unknown" as NamingKind, {})).toThrow(NamingError);
  });

  it("缺省种子 = 时间戳（每次换一批）", () => {
    const first = makeNames("character", { count: 5 });
    const second = makeNames("character", { count: 5 });
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    // 不强制不同（时间戳毫秒相同可能一样），仅验证可用性
  });
});