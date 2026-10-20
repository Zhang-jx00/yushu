/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 冷启动记忆衔接（M5 / T5-9，R95；纯函数，不碰 fs）。
 *
 * 任务原文：**导入后自动补卷/章摘要候选，避免长篇项目开场即失忆（I09 + T3-5）**。
 * 这一层只回答三个问题——**缺多少、缺在哪、先补哪几条最不至于失忆**。
 * 它一个字摘要都不生成：摘要内容要么由 AI 产出（走既有的「生成候选 → 采纳」，
 * 候选化原则不变、入库仍是作者显式动作），要么由作者自己写。
 *
 * 三条要紧的口径：
 * ① **没素材不列待补**：正文为空的章进 `noMaterial` 计数，不进批次——
 *    给一章空白内容"补摘要"只能靠编，那正是本项目一直拒绝做的事；
 * ② **覆盖率的分母只算有素材的目标**：否则空章会稀释分母，把"其实没几条能补"
 *    显示成"覆盖率很低急需补"，制造假紧迫；
 * ③ **一个能判的目标都没有 ⇒ 覆盖率给 null 并带原因**，不拿 0 冒充"一切正常"，
 *    也不拿 0 冒充"急需补"（与全书体检「没查过 ≠ 没问题」同一条口径）。
 *
 * 顺序：批次 = 卷摘要在前、章摘要按输入顺序（输入由主进程按三级大纲装配，
 * 而大纲序才是作者认定的顺序）；本模块不做任何字符串排序，因此不碰 `localeCompare`，
 * 同输入必得同输出（第六条红线）。
 */

export interface ColdStartTarget {
  layer: "volume_summary" | "chapter_summary";
  /** 卷摘要 = 卷纲 id（vol-*）；章摘要 = 章节实体 id（ch-*） */
  id: string;
  title: string;
  /** 所属卷（章摘要用得上；卷摘要可缺省） */
  volumeId?: string;
  /** 摘要素材字符数（章 = 正文长度；卷 = 各章正文之和） */
  sourceChars: number;
  hasSummary: boolean;
  /** 已有摘要的人工修订次数（>0 表示作者改过，AI 不得自动覆盖） */
  summaryRev: number;
}

export interface ColdStartLayerCount {
  total: number;
  /** 缺摘要且**有素材**的目标数（无素材的单列在 noMaterial） */
  missing: number;
  covered: number;
}

export interface ColdStartPlan {
  volumes: ColdStartLayerCount;
  chapters: ColdStartLayerCount;
  /** 正文为空、因此不列待补的目标数（两层合计） */
  noMaterial: number;
  /** 有素材的目标合计（覆盖率的分母） */
  materialTargets: number;
  /** materialTargets 为 0 时给 null（无从判断），否则 0..1 */
  coverageRatio: number | null;
  /** coverageRatio 为 null 时的实话；有数值时为 null */
  coverageReason: string | null;
  /** 第一篇章摘要是否缺失（"开场即失忆"最直接的那个信号） */
  firstChapterMissing: boolean;
  /** 建议先补的批次：卷摘要在前，章摘要按大纲顺序，截断到 batchSize */
  batch: ColdStartTarget[];
  /** 这批的素材字数合计（交给成本面板换算，本模块不猜单价） */
  batchChars: number;
  batchTruncated: boolean;
  /** 批次截断后仍缺的目标数 */
  stillMissing: number;
}

/** 界面不许自己猜批大小；调大调小由调用方显式传 */
export const COLD_START_DEFAULT_BATCH = 10;

function countLayer(targets: ColdStartTarget[]): ColdStartLayerCount {
  const material = targets.filter((item) => item.sourceChars > 0);
  return {
    total: targets.length,
    missing: material.filter((item) => !item.hasSummary).length,
    covered: material.filter((item) => item.hasSummary).length,
  };
}

export function planColdStart(input: {
  targets: ColdStartTarget[];
  batchSize?: number;
}): ColdStartPlan {
  const batchSize = input.batchSize ?? COLD_START_DEFAULT_BATCH;
  const volumes = input.targets.filter((item) => item.layer === "volume_summary");
  const chapters = input.targets.filter((item) => item.layer === "chapter_summary");
  const material = input.targets.filter((item) => item.sourceChars > 0);
  const gaps = material.filter((item) => !item.hasSummary);
  // 卷摘要先：一条卷摘要覆盖整卷的上下文，补它最省素材也最止得住"开场即失忆"
  const ordered = [
    ...gaps.filter((item) => item.layer === "volume_summary"),
    ...gaps.filter((item) => item.layer === "chapter_summary"),
  ];
  const batch = ordered.slice(0, batchSize);
  const firstChapter = chapters[0];

  return {
    volumes: countLayer(volumes),
    chapters: countLayer(chapters),
    noMaterial: input.targets.length - material.length,
    materialTargets: material.length,
    coverageRatio: material.length === 0 ? null : material.filter((item) => item.hasSummary).length / material.length,
    coverageReason:
      material.length === 0
        ? "项目里还没有任何有素材的摘要目标（正文尚未写入）——覆盖率无从计算，这不等于记忆没问题，也不等于急需补"
        : null,
    firstChapterMissing: firstChapter !== undefined && firstChapter.sourceChars > 0 && !firstChapter.hasSummary,
    batch,
    batchChars: batch.reduce((sum, item) => sum + item.sourceChars, 0),
    batchTruncated: ordered.length > batch.length,
    stillMissing: ordered.length - batch.length,
  };
}

/* ---------------- 批量补摘要的预算护栏联动（R106） ---------------- */

/**
 * 预算护栏（结构性参数；调用方从 `config/budget.yaml` 映射过来）。
 *
 * 这里**不 import `@yushu/llm`**：记忆包只依赖 `@yushu/core`（见 package.json），
 * 而预算配置的解析与校验属于 LLM 包那一边。两边共用**数值口径**，不共用类型。
 */
export interface ColdStartBatchBudget {
  /** 月度上限（金额，单位见 currency）；缺省 = 不设预算 */
  monthlyCap?: number;
  /** 单次调用预估超过该值需用户确认（J09 `per_call_confirm_over`） */
  perCallConfirmOver?: number;
  /** 临近上限的比例阈值（缺省 0.8） */
  warnRatio?: number;
  currency?: string;
}

/**
 * 一条候选的预估（调用方给）。
 *
 * **金额是 `number | null`，null 表示「算不出来」**——云端 provider 没配单价就是算不出来。
 * 它**不是 0**：拿 0 冒充会让月度上限形同虚设（那是最坏的静默）。
 * 真的 0 是本地端点那种情形（J09 §3.8「本地端点标注零成本」），由调用方如实给 0。
 */
export interface ColdStartBatchEstimate {
  id: string;
  /** 预估 prompt token（面板看"这批大概多少 token"） */
  promptTokens: number;
  /** 预估金额；null = 算不出来（没配单价），不是 0 */
  cost: number | null;
  currency: string;
}

export interface ColdStartBatchDecision {
  /** 这一批要跑哪些（按 batch 顺序：卷摘要在前） */
  ids: string[];
  /** 预估 token 合计 */
  estimatedTokens: number;
  /** 预估金额合计（**只算算得出来的**；算不出的不按 0 计入） */
  estimatedCost: number;
  /** 金额算不出来的条目 id（不参与上限计算，但要说明） */
  unpricedIds: string[];
  /** 跑完这批之后本月已用（按币种） */
  projected: Record<string, number>;
  /** 需要作者显式确认（超月度上限 / 单次超阈值 / 有条目算不出金额） */
  needsConfirm: boolean;
  /** 触发确认的理由（逐条，面板直接显示） */
  confirmReasons: string[];
  /** 只是提醒、不需要作者点头的事（未设上限 / 临近上限） */
  warnings: string[];
  /** 一句话结论（面板显示） */
  reason: string;
}

/**
 * 批量补摘要的**生成前成本预估 + 超预算确认**（J09 §3.3）。
 *
 * 四条口径：
 * ① **没设月度上限就不拦**（不设限就是不限），但**必须报预估**——作者有权知道这批要花多少；
 * ② **算不出金额 ≠ 零成本**：算不出的条目不进金额合计，而且**护栏对它们无效** ⇒ 必须显式确认
 *    （不能默认"反正算不出来就当免费"）；
 * ③ **超预算是"需用户确认"，不是自动拦停**（J09 §3.3 原话）——拦停是策略变更，得作者在场决定；
 * ④ **单次超阈值只针对那一条**（`per_call_confirm_over` 是单次口径，不是整批口径）。
 */
export function planBatchAgainstBudget(input: {
  batch: ColdStartTarget[];
  estimates: ColdStartBatchEstimate[];
  /** 本自然月已发生金额（按币种） */
  spentThisMonth: Record<string, number>;
  budget: ColdStartBatchBudget | null;
}): ColdStartBatchDecision {
  const byId = new Map(input.estimates.map((item) => [item.id, item]));
  const ids: string[] = [];
  const unpricedIds: string[] = [];
  const confirmReasons: string[] = [];
  const warnings: string[] = [];
  let estimatedTokens = 0;
  let estimatedCost = 0;
  const projected: Record<string, number> = {};

  for (const target of input.batch) {
    const estimate = byId.get(target.id);
    ids.push(target.id);
    if (estimate === undefined) continue;
    estimatedTokens += estimate.promptTokens;
    if (estimate.cost === null) {
      unpricedIds.push(target.id);
      continue;
    }
    estimatedCost += estimate.cost;
    projected[estimate.currency] = (projected[estimate.currency] ?? 0) + estimate.cost;
  }
  for (const [currency, amount] of Object.entries(input.spentThisMonth)) {
    projected[currency] = (projected[currency] ?? 0) + amount;
  }

  const budget = input.budget;
  const cap = budget?.monthlyCap;
  if (cap !== undefined) {
    const currency = budget?.currency ?? Object.keys(projected)[0];
    const spent = currency === undefined ? 0 : (projected[currency] ?? 0);
    const ratio = spent / cap;
    const warnRatio = budget?.warnRatio ?? 0.8;
    if (ratio > 1) {
      confirmReasons.push(
        `本批跑完本月已用将达到 ${spent.toFixed(4)}，超过月度上限 ${cap}（${Math.round(ratio * 100)}%）`,
      );
    } else if (ratio >= warnRatio) {
      // 临近只是**提醒**，不是要作者点头的事（J09 §3.3 的确认条件是"超预算"）
      warnings.push(
        `本批跑完本月已用将达到 ${spent.toFixed(4)}，是月度上限 ${cap} 的 ${Math.round(ratio * 100)}%（临近阈值 ${Math.round(warnRatio * 100)}%）`,
      );
    }
  } else {
    warnings.push("未设月度上限（config/budget.yaml）——本批不按金额设限");
  }

  const perCall = budget?.perCallConfirmOver;
  if (perCall !== undefined) {
    for (const target of input.batch) {
      const estimate = byId.get(target.id);
      if (estimate === undefined || estimate.cost === null) continue;
      if (estimate.cost > perCall) {
        confirmReasons.push(
          `「${target.title}」这条预估 ${estimate.cost.toFixed(4)} 超过单次确认阈值 ${perCall}`,
        );
      }
    }
  }

  if (unpricedIds.length > 0) {
    confirmReasons.push(
      `本批有 ${String(unpricedIds.length)} 条算不出金额（provider 没配单价）——护栏对这几条无效，需你确认`,
    );
  }

  // 「未设月度上限」「临近上限」都只是**说明**，不需要作者点头：
  // 没设限就不需要确认，临近也只是提醒（J09 §3.3 的确认条件是"超预算"）。
  const needsConfirm = confirmReasons.length > 0;

  const parts: string[] = [];
  parts.push(`本批 ${String(ids.length)} 条，预估 ${String(estimatedTokens)} token`);
  if (unpricedIds.length === 0) {
    parts.push(`金额 ${estimatedCost.toFixed(4)} ${budget?.currency ?? ""}`.trim());
  } else {
    parts.push(
      `已知金额 ${estimatedCost.toFixed(4)}（另有 ${String(unpricedIds.length)} 条算不出金额，不计入）`,
    );
  }
  parts.push(...warnings);
  if (needsConfirm) {
    parts.push(`需显式确认：${confirmReasons.join("；")}`);
  }

  return {
    ids,
    estimatedTokens,
    estimatedCost,
    unpricedIds,
    projected,
    needsConfirm,
    confirmReasons,
    warnings,
    reason: parts.join(" ｜ "),
  };
}
