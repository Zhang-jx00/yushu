/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  IMPORT_SPLIT_OUTPUT_SCHEMA,
  IMPORT_SPLIT_SCHEMA_ID,
  IMPORT_SPLIT_TASK_ID,
  parseImportSplitOutput,
} from "../src/import-split.js";

/**
 * AI 二次筛选切分的**输出契约**（M5 / T5-7 第二段，R107）。
 *
 * 判据回源 **I09 §3.4**（两段式「规则海选 → AI 筛选」）与 **T3-10 抽取任务的既有做法**
 * （JSON Schema 唯一契约 + `additionalProperties:false` + **AI 只能指认我们给它的候选**）。
 *
 * 三条口径：
 * ① **AI 只能指认候选表里的序号**（不给行号、不给原文）——模型自己编的行号一律丢弃；
 * ② **越界与重复逐条丢弃并计数**（与 `audit-sample` 的 rejected 口径一致），
 *    不是"整份作废"：一个跑偏的条目不该带走同批有效结论；
 * ③ **schema 不过 = 本轮筛失败**（keeps 为空 + issues 非空），调用方据此回退正则切分并说清楚。
 */

describe("AI 筛选切分的输出契约", () => {
  it("契约 id 与任务 id 固定（提示词靠它识别，mock 也靠它识别）", () => {
    expect(IMPORT_SPLIT_TASK_ID).toBe("yushu.import/split_filter/v1");
    expect(IMPORT_SPLIT_SCHEMA_ID).toBe("yushu.import/split-decisions/v1");
    expect(IMPORT_SPLIT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it("正常输出：保留的序号按序去重", () => {
    const result = parseImportSplitOutput({ keeps: [{ index: 0 }, { index: 2 }] }, 3);
    expect(result.keeps).toEqual([0, 2]);
    expect(result.rejected).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("越界的序号被丢弃并点名（AI 指认了不存在的候选）", () => {
    const result = parseImportSplitOutput({ keeps: [{ index: 0 }, { index: 9 }] }, 3);
    expect(result.keeps).toEqual([0]);
    expect(result.rejected.join("")).toContain("9");
  });

  it("重复的序号只留一次（不把一条候选切两次）", () => {
    const result = parseImportSplitOutput({ keeps: [{ index: 1 }, { index: 1 }] }, 3);
    expect(result.keeps).toEqual([1]);
  });

  it("schema 不过 ⇒ 本轮筛失败（keeps 空 + issues 非空），不半信半疑地采纳一半", () => {
    const result = parseImportSplitOutput({ keeps: "not-an-array" }, 3);
    expect(result.keeps).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("多出来的键被拒（悄悄加一个代码不认识的字段比报错危险）", () => {
    const result = parseImportSplitOutput({ keeps: [{ index: 0, extra: 1 }] }, 3);
    expect(result.keeps).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("非整数 / 负数的序号被拒", () => {
    expect(parseImportSplitOutput({ keeps: [{ index: -1 }] }, 3).keeps).toEqual([]);
    expect(parseImportSplitOutput({ keeps: [{ index: 1.5 }] }, 3).keeps).toEqual([]);
  });

  it("空输出是合法结果（AI 判定一条都不像章节标题）——但调用方要据此回退", () => {
    const result = parseImportSplitOutput({ keeps: [] }, 3);
    expect(result.keeps).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
