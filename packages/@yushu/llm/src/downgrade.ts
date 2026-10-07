import type { CapabilityKey } from "./routing.js";

/**
 * 能力矩阵驱动的自动降级（T3-3，J01）：任务 `require` 未满足时不报错，而是给出可执行的降级方案：
 * - structured_output 缺失 → 「提示词约束 + JSON 后校验」（追加输出格式约束，回复用 extractJson 后校验）；
 * - stream 缺失 → 一次性返回（调用方用 chat 动词替代 stream）；
 * - tools 缺失 → 无降级路径（明确告知需更换 provider）；
 * - 其余能力缺失 → 记录提示（无降级路径，继续执行）。
 * 降级信息以用户可读 message 返回，由调用方展示（AI 副驾驶的 downgrade 事件）。
 */

export type DowngradeStrategy =
  | "prompt_constrained_json"
  | "one_shot"
  | "unsupported"
  | "prompt_note";

export interface DowngradeAction {
  capability: CapabilityKey;
  strategy: DowngradeStrategy;
  /** 用户可读提示（UI 展示） */
  message: string;
}

export interface DowngradePlan {
  actions: DowngradeAction[];
  /** 追加到请求末尾的提示词约束（无降级时为空串） */
  prompt_suffix: string;
  /** 回复是否需要 JSON 后校验（structured_output 降级时为 true） */
  post_validate_json: boolean;
}

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  tools: "工具调用（tools）",
  structured_output: "结构化输出（structured_output）",
  stream: "流式输出（stream）",
  usage: "用量回传（usage）",
  reasoning: "推理档（reasoning）",
  vision: "视觉输入（vision）",
  cache: "提示缓存（cache）",
  batch: "批量接口（batch）",
};

export const JSON_CONSTRAINT_SUFFIX =
  "\n\n【输出格式要求（能力降级约束）】只输出一个合法的 JSON 对象，不要输出任何解释、" +
  "Markdown 代码围栏或多余文本；无法确定的字段用 null 表示。";

/** 由路由的 unmet 能力列表生成降级方案 */
export function planDowngrade(unmet: CapabilityKey[]): DowngradePlan {
  const actions: DowngradeAction[] = unmet.map((capability) => {
    switch (capability) {
      case "structured_output":
        return {
          capability,
          strategy: "prompt_constrained_json" as const,
          message: "模型未声明结构化输出能力：已降级为「提示词约束 + JSON 后校验」",
        };
      case "stream":
        return {
          capability,
          strategy: "one_shot" as const,
          message: "模型未声明流式能力：已降级为一次性返回（生成期间无逐字打印）",
        };
      case "tools":
        return {
          capability,
          strategy: "unsupported" as const,
          message: "模型未声明工具调用能力且无降级路径：请更换 provider 或改用支持 tools 的模型",
        };
      default:
        return {
          capability,
          strategy: "prompt_note" as const,
          message: `模型未声明${CAPABILITY_LABELS[capability]}能力：继续执行（无降级路径）`,
        };
    }
  });
  const needsJson = actions.some((action) => action.strategy === "prompt_constrained_json");
  return {
    actions,
    prompt_suffix: needsJson ? JSON_CONSTRAINT_SUFFIX : "",
    post_validate_json: needsJson,
  };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 从 start 起截取第一个括号平衡的 JSON 片段（引号内忽略括号；未闭合返回 null） */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * JSON 后校验（T3-3 降级路径；T3-10 结构化抽取复用）：
 * 容忍 Markdown 代码围栏与前后解释文本——先整段解析，失败则扫描首个可解析的平衡对象 / 数组。
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct.ok) return direct;
    for (let start = 0; start < candidate.length; start += 1) {
      const ch = candidate[start];
      if (ch !== "{" && ch !== "[") continue;
      const slice = sliceBalanced(candidate, start);
      if (!slice) continue;
      const parsed = tryParse(slice);
      if (parsed.ok) return parsed;
    }
  }
  return { ok: false, error: "未在回复中找到可解析的 JSON 对象 / 数组" };
}