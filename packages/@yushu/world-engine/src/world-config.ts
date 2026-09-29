import {
  LAYER_KEYS,
  WORLD_API_VERSION,
  makeId,
  type GenreAxes,
  type LayerKey,
  type WorldConfig,
} from "@yushu/core";
import {
  CORE_WORLD_SCHEMA_ID,
  SchemaValidationError,
  getDefaultRegistry,
} from "@yushu/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** 默认层级开关：全部开启；按流派预置可关闭（如现实都市关闭 ecology） */
export const DEFAULT_LAYERS: Record<LayerKey, boolean> = Object.fromEntries(
  LAYER_KEYS.map((key) => [key, true]),
) as Record<LayerKey, boolean>;

export interface CreateWorldInput {
  title: string;
  genreAxes: GenreAxes;
  /** 未提供时由标题派生稳定 ID */
  id?: string;
  layers?: Partial<Record<LayerKey, boolean>>;
  requiredFields?: string[];
}

/** 创建一个通过 schema 校验的世界根配置（渐进披露：仅少量必填） */
export function createWorldConfig(input: CreateWorldInput): WorldConfig {
  const world: WorldConfig = {
    apiVersion: WORLD_API_VERSION,
    id: input.id ?? makeId("world", input.title),
    title: input.title,
    genre_axes: input.genreAxes,
    layers: { ...DEFAULT_LAYERS, ...(input.layers ?? {}) },
    ...(input.requiredFields ? { required_fields: input.requiredFields } : {}),
  };
  assertWorldValid(world);
  return world;
}

/** 校验失败抛 SchemaValidationError（错误码 E_VALIDATION，附问题清单） */
export function assertWorldValid(world: unknown): asserts world is WorldConfig {
  const result = getDefaultRegistry().validate(CORE_WORLD_SCHEMA_ID, world);
  if (!result.valid) {
    throw new SchemaValidationError(CORE_WORLD_SCHEMA_ID, result.issues);
  }
}

/** 序列化为 world.yaml 文本（不折行，保持可读） */
export function serializeWorldConfig(world: WorldConfig): string {
  return stringifyYaml(world, { lineWidth: 0 });
}

/** 解析并校验 world.yaml 文本 */
export function parseWorldConfig(text: string): WorldConfig {
  const data = parseYaml(text) as unknown;
  assertWorldValid(data);
  return data;
}