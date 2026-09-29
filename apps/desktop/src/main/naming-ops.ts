import { getNamingRules, makeNames, namingRulesForWorld } from "@yushu/world-engine";
import type { NamingGeneratePayload, NamingResultPayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { getWorldSummary } from "./project-ops.js";

/**
 * 命名生成器（T1-8）：本地无 AI、离线可用。
 * 文化规则按世界维度自动推导（玄幻→仙侠 / 西幻→西幻 / 现实都市→现代都市），
 * 也可由调用方显式指定 culture；显式 seed 时结果可复现。
 */
export async function generateNames(
  gateway: ProjectGateway,
  payload: NamingGeneratePayload,
): Promise<NamingResultPayload> {
  const world = await getWorldSummary(gateway).catch(() => null);
  const worldAxes = world?.genreAxes.world ?? [];
  const rules =
    (payload.culture ? getNamingRules(payload.culture) : null) ?? namingRulesForWorld(worldAxes);

  const seed = payload.seed ?? Date.now();
  const names = makeNames(payload.kind, { rules, seed, count: payload.count ?? 5 });
  return {
    rulesId: rules.id,
    rulesTitle: rules.title,
    pattern: rules.pattern,
    seed: String(seed),
    names,
  };
}