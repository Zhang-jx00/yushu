import { describe, expect, it } from "vitest";
import {
  CORE_SETTING_CARD_SCHEMA_ID,
  CORE_WORLD_SCHEMA_ID,
  SchemaRegistry,
  SchemaValidationError,
  createRegistry,
  validateSettingCard,
  validateWorld,
} from "@yushu/schema";

const validWorld = {
  apiVersion: "yushu.world/v1",
  id: "world-tianqi",
  title: "天启界",
  genre_axes: {
    channel: ["男频"],
    world: ["玄幻"],
    technique: ["系统流"],
    tone: ["爽文"],
    romance_mode_default: "无女主",
  },
  layers: {
    genesis: true,
    laws: true,
    geography: true,
    ecology: false,
    eras: true,
    civilizations: true,
    factions: true,
    characters: true,
    events: true,
    storylines: true,
    chapters: true,
  },
};

const validCard = {
  id: "char-linyuan",
  type: "character",
  layer: "characters",
  name: "林渊",
  aliases: ["渊哥"],
  refs: [{ relation: "师徒", target: "char-moxuan" }],
  source_chapters: ["ch-001"],
  visibility: "revealed",
  format_version: 1,
};

describe("schema 注册表", () => {
  it("核心 schema 预载且可校验通过", () => {
    const registry = createRegistry();
    expect(registry.ids()).toContain(CORE_WORLD_SCHEMA_ID);
    expect(registry.ids()).toContain(CORE_SETTING_CARD_SCHEMA_ID);
    expect(registry.validate(CORE_WORLD_SCHEMA_ID, validWorld).valid).toBe(true);
    expect(registry.validate(CORE_SETTING_CARD_SCHEMA_ID, validCard).valid).toBe(true);
  });

  it("world 缺 genre_axes / layers 不完整时给出问题清单", () => {
    const bad = { ...validWorld, genre_axes: undefined, layers: { genesis: true } };
    const result = validateWorld(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.keyword === "required")).toBe(true);
  });

  it("非法实体 ID 被打回并带路径", () => {
    const result = validateSettingCard({ ...validCard, id: "角色-林渊" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "/id")).toBe(true);
  });

  it("重复登记同一 $id 抛错", () => {
    const registry = new SchemaRegistry();
    registry.add({ $id: "test/one", type: "object" });
    expect(() => registry.add({ $id: "test/one", type: "object" })).toThrowError(
      /schema 已存在/,
    );
  });

  it("assertValid 失败时抛 SchemaValidationError 且携带 issues", () => {
    const registry = createRegistry();
    try {
      registry.assertValid(CORE_SETTING_CARD_SCHEMA_ID, { id: "x" });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const e = err as SchemaValidationError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.code).toBe("E_VALIDATION");
    }
  });

  it("未登记的 schema 查询抛错", () => {
    const registry = createRegistry();
    expect(() => registry.validate("not/exists", {})).toThrowError(/未登记的 schema/);
  });
});