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
