import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPack,
  loadSchemaExtensions,
  validateExtensionCard,
  type SchemaExtension,
} from "@yushu/genre-engine";

const builtinDir = fileURLToPath(
  new URL("../../../../packs/xuanhuan-xitong", import.meta.url),
);

function loadRealmExtension(): SchemaExtension {
  const extension = loadSchemaExtensions(loadPack(builtinDir)).find(
    (e) => e.id === "realm-system",
  );
  if (!extension) throw new Error("内置包缺少 realm-system 扩展");
  return extension;
}

describe("schema 扩展点（T1-7）", () => {
  it("加载玄幻包的两个扩展并解析注入语义", () => {
    const extensions = loadSchemaExtensions(loadPack(builtinDir));
    expect(extensions.map((e) => e.id).sort()).toEqual(["realm-system", "system-panel"]);
    const realm = extensions.find((e) => e.id === "realm-system")!;
    expect(realm.extends).toBe("core/setting-card");
    expect(realm.unknown_field_policy).toBe("ignore_with_warning");
    expect(realm.inject?.["priority"]).toBe("high");
    expect(realm.fields["realms"]?.items?.required).toEqual([
      "name",
      "tier",
      "lifespan",
      "combat_power",
    ]);
  });

  it("合法境界数据通过校验", () => {
    const realm = loadRealmExtension();
    const result = validateExtensionCard(realm, {
      type: "realm-system",
      extensions: { realms: [{ name: "练气", tier: 1, lifespan: 120, combat_power: 10 }] },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("境界条目缺必填项逐个报错", () => {
    const realm = loadRealmExtension();
    const result = validateExtensionCard(realm, {
      extensions: { realms: [{ name: "练气", tier: 1 }] },
    });
    expect(result.errors.some((e) => e.includes("lifespan"))).toBe(true);
    expect(result.errors.some((e) => e.includes("combat_power"))).toBe(true);
  });

  it("未填写的扩展字段不强制（渐进披露）", () => {
    const realm = loadRealmExtension();
    const result = validateExtensionCard(realm, { extensions: {} });
    expect(result.errors).toEqual([]);
  });

  it("未知字段按 unknown_field_policy 处理", () => {
    const realm = loadRealmExtension();
    const relaxed = validateExtensionCard(realm, { extensions: { mystery: 1 } });
    expect(relaxed.errors).toEqual([]);
    expect(relaxed.warnings.some((w) => w.includes("mystery"))).toBe(true);

    const strict: SchemaExtension = { ...realm, unknown_field_policy: "reject" };
    const rejected = validateExtensionCard(strict, { extensions: { mystery: 1 } });
    expect(rejected.errors.some((e) => e.includes("mystery"))).toBe(true);
  });

  it("数组字段类型错误时报错", () => {
    const realm = loadRealmExtension();
    const result = validateExtensionCard(realm, { extensions: { realms: "不是数组" } });
    expect(result.errors.some((e) => e.includes("应为数组"))).toBe(true);
  });
});