import { describe, expect, it } from "vitest";
import {
  collectMentionedEntities,
  findMentions,
  type EntityIndexEntry,
} from "../renderer/src/entity-mentions";

const linyuan: EntityIndexEntry = {
  id: "char-linyuan",
  name: "林渊",
  aliases: ["小渊"],
  type: "character",
  layer: "characters",
  filePath: "world/cards/character/char-linyuan.md",
};

const qingyun: EntityIndexEntry = {
  id: "loc-qingyun",
  name: "青云山脉",
  aliases: ["青云"],
  type: "location",
  layer: "geography",
  filePath: "world/cards/location/loc-qingyun.md",
};

// 构造一个"名称是另一实体名称前缀"的场景，验证最长匹配优先
const linyuanZhi: EntityIndexEntry = {
  id: "char-linyuanzhi",
  name: "林渊之",
  aliases: [],
  type: "character",
  layer: "characters",
  filePath: "world/cards/character/char-linyuanzhi.md",
};

const entities = [linyuan, qingyun];

describe("实体 @ 提及解析（T2-2）", () => {
  it("命中名称与别名，返回准确区间", () => {
    const text = "他说：@林渊 你先走，@小渊 别回头。";
    const matches = findMentions(text, entities);
    expect(matches.map((match) => match.matchedName)).toEqual(["林渊", "小渊"]);
    expect(matches.map((match) => match.entity.id)).toEqual(["char-linyuan", "char-linyuan"]);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe("@林渊");
    expect(text.slice(matches[1]!.start, matches[1]!.end)).toBe("@小渊");
  });

  it("最长匹配优先且区间不重叠", () => {
    const text = "@林渊之 与 @林渊 同时出现。";
    const matches = findMentions(text, [linyuan, linyuanZhi]);
    expect(matches.map((match) => match.entity.id)).toEqual(["char-linyuanzhi", "char-linyuan"]);
    const [first, second] = matches;
    expect(first!.end).toBeLessThanOrEqual(second!.start);
  });

  it("无 @ 前缀不命中；未建档名称不命中", () => {
    expect(findMentions("林渊走进了夜色里。", entities)).toEqual([]);
    expect(findMentions("@张三来了。", entities)).toEqual([]);
    expect(findMentions("@林渊", [])).toEqual([]);
  });

  it("提及面板：按首次出现顺序去重", () => {
    const text = "@林渊 与 @青云 同行，@小渊 落在后面，又见 @青云山脉。";
    const mentioned = collectMentionedEntities(text, entities);
    expect(mentioned.map((entity) => entity.id)).toEqual(["char-linyuan", "loc-qingyun"]);
  });
});