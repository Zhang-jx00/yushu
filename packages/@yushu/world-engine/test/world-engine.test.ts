import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "@yushu/schema";
import {
  DEFAULT_LAYERS,
  PROJECT_FORMAT_VERSION,
  ProjectConfigError,
  WORLD_CONFIG_PATH,
  cardPath,
  chapterPath,
  createProjectConfig,
  createSettingCard,
  createWorldConfig,
  parseProjectConfig,
  parseWorldConfig,
  readCardFile,
  serializeCardFile,
  serializeProjectConfig,
  serializeWorldConfig,
} from "@yushu/world-engine";

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主" as const,
};

describe("world 配置", () => {
  it("创建的世界默认全层级开启且通过校验", () => {
    const world = createWorldConfig({ title: "天启界", genreAxes: AXES });
    expect(world.apiVersion).toBe("yushu.world/v1");
    expect(world.id.startsWith("world-")).toBe(true);
    expect(world.layers).toEqual(DEFAULT_LAYERS);
  });

  it("层级开关可部分关闭（渐进披露）", () => {
    const world = createWorldConfig({
      title: "都市故事",
      genreAxes: { ...AXES, world: ["现实都市"] },
      layers: { ecology: false, eras: false },
    });
    expect(world.layers.ecology).toBe(false);
    expect(world.layers.eras).toBe(false);
    expect(world.layers.characters).toBe(true);
  });

  it("序列化-解析往返一致", () => {
    const world = createWorldConfig({ title: "天启界", genreAxes: AXES });
    const text = serializeWorldConfig(world);
    expect(parseWorldConfig(text)).toEqual(world);
  });

  it("非法配置抛 SchemaValidationError", () => {
    expect(() => createWorldConfig({ title: "", genreAxes: AXES })).toThrow(
      SchemaValidationError,
    );
  });

  it("解析非法 YAML 文本同样抛错", () => {
    expect(() => parseWorldConfig("apiVersion: yushu.world/v1\nid: bad\n")).toThrow(
      SchemaValidationError,
    );
  });
});

describe("设定卡", () => {
  it("按类型映射前缀生成稳定 ID 并通过校验", () => {
    const card = createSettingCard({ type: "character", name: "林渊", layer: "characters" });
    expect(card.id.startsWith("char-")).toBe(true);
    expect(card.visibility).toBe("hidden");
    expect(card.format_version).toBe(1);
    // 同名同类型 → 同 ID（稳定）
    const again = createSettingCard({ type: "character", name: "林渊", layer: "characters" });
    expect(again.id).toBe(card.id);
  });

  it("未知类型必须显式提供 id", () => {
    expect(() => createSettingCard({ type: "alien-artifact", name: "神秘造物" })).toThrowError(
      /未知实体类型/,
    );
    const card = createSettingCard({
      type: "alien-artifact",
      name: "神秘造物",
      id: "itm-kezhao",
    });
    expect(card.type).toBe("alien-artifact");
  });

  it("设定卡文件往返一致", () => {
    const card = createSettingCard({
      type: "location",
      name: "青云山脉",
      layer: "geography",
      aliases: ["青云山"],
      refs: [{ relation: "位于", target: "loc-zhongzhou" }],
    });
    const text = serializeCardFile(card, "主峰终年云雾缭绕，是宗门所在。\n");
    const { card: parsed, body } = readCardFile(text);
    expect(parsed).toEqual(card);
    expect(body).toBe("主峰终年云雾缭绕，是宗门所在。\n");
  });

  it("frontmatter 缺必填字段时抛错", () => {
    expect(() => readCardFile("---\nname: 无名\n---\n")).toThrow(SchemaValidationError);
  });
});

describe("项目文件布局", () => {
  it("路径常量与派生函数", () => {
    expect(WORLD_CONFIG_PATH).toBe("world/world.yaml");
    expect(cardPath("character", "char-linyuan")).toBe("world/cards/character/char-linyuan.md");
    expect(chapterPath("vol1", "ch-001")).toBe("chapters/vol1/ch-001.md");
  });
});

describe("project.toml 项目配置", () => {
  it("创建-序列化-解析往返一致", () => {
    const config = createProjectConfig({
      name: "天启界",
      packIds: ["xuanhuan-xitong"],
      axes: { ...AXES, technique: ["系统流", "凡人流"] },
      conflicts: [{ kind: "romance-mode-conflict", severity: "warn", message: "形态不一致" }],
      createdAt: "2026-09-29T08:00:00.000Z",
    });
    const text = serializeProjectConfig(config);
    expect(text).toContain("[project]");
    expect(text).toContain("[genre]");
    const parsed = parseProjectConfig(text);
    expect(parsed).toEqual(config);
    expect(parsed.project.format_version).toBe(PROJECT_FORMAT_VERSION);
  });

  it("项目名不能为空", () => {
    expect(() =>
      createProjectConfig({ name: "  ", packIds: [], axes: { channel: [], world: [], technique: [], tone: [] } }),
    ).toThrow(ProjectConfigError);
  });

  it("格式版本过新时拒绝加载", () => {
    const text = `[project]\nname = "x"\nformat_version = ${PROJECT_FORMAT_VERSION + 1}\ncreated_at = ""\n`;
    expect(() => parseProjectConfig(text)).toThrowError(/格式版本过新/);
  });

  it("缺 [project] 时给出明确错误", () => {
    expect(() => parseProjectConfig("[genre]\npacks = []\n")).toThrow(ProjectConfigError);
  });
});