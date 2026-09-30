import { GENESIS_STEPS } from "./genesis-steps";

/**
 * 设定卡类型 / 世界层级的中文标签（渲染层展示用；复核修复 2026-09-30）。
 * - 层级标签直接派生自起源工作台步骤配置（单一来源，避免两处维护漂移）；
 * - 类型为手工映射（起源步骤的 type 与标题并非一一对应，如 geography→location）；
 * - 未收录的枚举原样回退（派系包扩展类型向前兼容）。
 */

const CARD_TYPE_LABELS: Record<string, string> = {
  character: "角色",
  faction: "势力",
  location: "地点",
  event: "事件",
  law: "法则",
  species: "物种",
  lore: "设定",
};

const LAYER_LABELS: Record<string, string> = Object.fromEntries(
  GENESIS_STEPS.map((step) => [step.layer, step.title]),
);

export function cardTypeLabel(type: string): string {
  return CARD_TYPE_LABELS[type] ?? type;
}

export function layerLabel(layer: string): string {
  return LAYER_LABELS[layer] ?? layer;
}