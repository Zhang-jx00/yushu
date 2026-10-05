import { describe, expect, it } from "vitest";
import { findMentions, type EntityIndexEntry } from "../renderer/src/entity-mentions";
import { detectMentionQuery, filterMentionCandidates } from "../renderer/src/mention-suggest";

const linyuan: EntityIndexEntry = {
  id: "char-linyuan",
  name: "林渊",
  aliases: ["小渊"],
  type: "character",
  layer: "characters",
  filePath: "world/cards/character/char-linyuan.md",
};

const linyuanZhi: EntityIndexEntry = {
  id: "char-linyuanzhi",
  name: "林渊之",
  aliases: [],
  type: "character",
  layer: "characters",
  filePath: "world/cards/character/char-linyuanzhi.md",
};

const qingyun: EntityIndexEntry = {
  id: "loc-qingyun",
  name: "青云山脉",
  aliases: ["青云"],
  type: "location",
  layer: "geography",
  filePath: "world/cards/location/loc-qingyun.md",
};

// 名称包含查询词但不以其开头（验证「前缀优先于包含」）
const shenyel: EntityIndexEntry = {
  id: "loc-shenyel",
  name: "深夜林",
  aliases: [],
  type: "location",
  layer: "geography",
  filePath: "world/cards/location/loc-shenyel.md",
};

const entities = [linyuan, linyuanZhi, qingyun];

describe("富文本 @ 候选触发检测（T2-2 富文本尾巴）", () => {
  it("@ 触发：空查询 / 前缀查询 / 中文前缀均有效，返回 @ 下标与查询词", () => {
    expect(detectMentionQuery("@")).toEqual({ query: "", at: 0 });
    expect(detectMentionQuery("他@")).toEqual({ query: "", at: 1 });
    expect(detectMentionQuery("@林渊")).toEqual({ query: "林渊", at: 0 });
    expect(detectMentionQuery("走@小")).toEqual({ query: "小", at: 1 });
    expect(detectMentionQuery("别回头@@")).toEqual({ query: "", at: 4 });
  });

  it("防误触与中断：英文前缀 / 空白 / 换行 / 超长查询不触发", () => {
    expect(detectMentionQuery("")).toBeNull();
    expect(detectMentionQuery("他说")).toBeNull();
    expect(detectMentionQuery("a@b")).toBeNull(); // 邮箱 / 英文账号：@ 前一字符是 ASCII 字母
    expect(detectMentionQuery("user1@")).toBeNull(); // 数字结尾
    expect(detectMentionQuery("a_@")).toBeNull(); // 下划线结尾
    expect(detectMentionQuery("@林 渊")).toBeNull(); // 空格中断（@ 与光标之间断开）
    expect(detectMentionQuery("@林\n渊")).toBeNull(); // 换行中断（跨段不触发）
    expect(detectMentionQuery(`@${"a".repeat(20)}`)).toEqual({ query: "a".repeat(20), at: 0 }); // 上限内有效
    expect(detectMentionQuery(`@${"a".repeat(21)}`)).toBeNull(); // 超长不触发
  });
});

describe("富文本 @ 候选过滤（T2-2 富文本尾巴）", () => {
  it("前缀优先于包含，同分短名在前", () => {
    // 「林」：林渊 / 林渊之 前缀（3 分，短名在前）→ 深夜林 包含（2 分）
    expect(filterMentionCandidates([shenyel, linyuanZhi, linyuan], "林").map((e) => e.name)).toEqual([
      "林渊",
      "林渊之",
      "深夜林",
    ]);
  });

  it("别名命中与大小写不敏感", () => {
    expect(filterMentionCandidates(entities, "小渊").map((e) => e.name)).toEqual(["林渊"]);
    expect(filterMentionCandidates(entities, "青云").map((e) => e.name)).toEqual(["青云山脉"]);
    const latin: EntityIndexEntry = { ...linyuan, id: "latin", name: "Alice", aliases: [] };
    expect(filterMentionCandidates([latin], "ali").map((e) => e.name)).toEqual(["Alice"]);
  });

  it("空查询返回全部（短名在前）；无匹配返回空；limit 截断", () => {
    expect(filterMentionCandidates(entities, "").map((e) => e.name)).toEqual(["林渊", "林渊之", "青云山脉"]);
    expect(filterMentionCandidates(entities, "张三")).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...linyuan,
      id: `e${i}`,
      name: `候补${i}`,
      aliases: [],
    }));
    expect(filterMentionCandidates(many, "候补", 8)).toHaveLength(8);
  });

  it("候选插入的 @名称 与源码形态解析同口径（选中即可被 findMentions 命中）", () => {
    const picked = filterMentionCandidates(entities, "小渊")[0]!;
    const text = `他说：@${picked.name} 别回头。`;
    const matches = findMentions(text, entities);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.entity.id).toBe("char-linyuan");
  });
});