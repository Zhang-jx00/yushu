/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import {
  RULE_STATS_API_VERSION,
  computeRuleNoise,
  parseRuleThresholds,
  serializeRuleThresholds,
  type RuleNoiseInput,
} from "../src/rule-stats.js";

/**
 * 规则噪音率与可校准阈值（M4 / T4-11 的后半）。
 *
 * 第 55 轮把 T4-11 留在这里没勾，理由就是"阈值仍是测试里写死的 0"。本轮补的是**可配置**这一半，
 * 但要先说清一件事：产品里能真正拿到的信号是**作者把哪些结论豁免掉了**（`config/consistency.yaml`
 * 每条都带 reason，A6 的审计入口），不是"作者标注了这条是误报"。
 * 所以这里的指标叫**豁免率**，不叫误报率——
 * 豁免既可能是"报错了"（误报），也可能是"确实有问题但我选择留白"。
 * 把两者混成一个词，就是拿一个代理指标冒充ground truth，等真有语料时反而说不清历史口径。
 *
 * 四条判定纪律（都是"不许把没判的显示成没问题"的具体化）：
 * ① 未配置阈值 ⇒ `not-configured`，**但仍然把率算出来给作者看**（有数据没结论 ≠ 没数据）；
 * ② 样本不足 ⇒ `insufficient-sample`（两条里豁免一条就是 50%，那不该被当成结论）；
 * ③ 分母为 0 ⇒ `rate: null`（不编造 0%，"这条规则一次都没报过"与"报了且都对"是两回事）；
 * ④ 判定用**严格大于**：正好等于阈值算"还行"，越线才吵。
 */

const rows = (...items: Array<[string, number, number]>): RuleNoiseInput[] =>
  items.map(([rule, reported, suppressed]) => ({ rule, reported, suppressed }));

describe("规则豁免率与可校准阈值（T4-11）", () => {
  it("配置解析：apiVersion 必填、未知键拒绝、阈值必须在 (0,1]", () => {
    expect(
      parseRuleThresholds(`apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 0.3\n`),
    ).toMatchObject({ suppression_rate: 0.3 });
    const bad = [
      "suppression_rate: 0.3",
      `apiVersion: yushu.consistency-thresholds/v99\n`,
      `apiVersion: ${RULE_STATS_API_VERSION}\nunknown_key: 1\n`,
      `apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 0\n`,
      `apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 1.5\n`,
      `apiVersion: ${RULE_STATS_API_VERSION}\nmin_samples: 0\n`,
      `apiVersion: ${RULE_STATS_API_VERSION}\nmin_samples: 2.5\n`,
    ];
    for (const text of bad) {
      let code = "";
      try {
        parseRuleThresholds(text);
      } catch (err) {
        code = err instanceof YushuError ? err.code : "NOT-YUSHU-ERROR";
      }
      expect(code, `这段配置本该被拒：${text.trim()}`).toBe("E_RULE_STATS");
    }
  });

  it("序列化往返：写出去再读回来必须等值（否则作者手改一次就丢字段）", () => {
    const parsed = parseRuleThresholds(
      `apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 0.25\nmin_samples: 8\n`,
    );
    expect(parseRuleThresholds(serializeRuleThresholds(parsed))).toEqual(parsed);
    // 缺省项不落盘：没写的键不该被写成"显式默认值"，那是把契约钉死在文件里
    expect(serializeRuleThresholds({ apiVersion: RULE_STATS_API_VERSION })).not.toContain("min_samples");
  });

  it("未配置阈值 ⇒ not-configured，但率照样算出来（有数据没结论 ≠ 没问题）", () => {
    const result = computeRuleNoise(rows(["ref-dangling", 4, 4]), {});
    expect(result[0]).toMatchObject({
      rule: "ref-dangling",
      rate: 0.5,
      verdict: "not-configured",
    });
  });

  it("样本不足 ⇒ insufficient-sample（两条里豁免一条不该被当成结论）", () => {
    const result = computeRuleNoise(rows(["ref-dangling", 1, 1]), {
      suppression_rate: 0.2,
      min_samples: 5,
    });
    expect(result[0]).toMatchObject({ rate: 0.5, verdict: "insufficient-sample" });
    // 达到样本数才判：同样数据、下限降到 2 ⇒ 立刻判 noisy
    const enough = computeRuleNoise(rows(["ref-dangling", 1, 1]), {
      suppression_rate: 0.2,
      min_samples: 2,
    });
    expect(enough[0]?.verdict).toBe("noisy");
  });

  it("阈值判定用严格大于：正好等于阈值算 ok，越线才吵", () => {
    const atThreshold = computeRuleNoise(rows(["a", 7, 3]), {
      suppression_rate: 0.3,
      min_samples: 5,
    });
    expect(atThreshold[0]).toMatchObject({ rate: 0.3, verdict: "ok" });
    const over = computeRuleNoise(rows(["a", 6, 4]), { suppression_rate: 0.3, min_samples: 5 });
    expect(over[0]).toMatchObject({ rate: 0.4, verdict: "noisy" });
  });

  it("一次都没报过 ⇒ rate 为 null 且判「样本不足」（不编造 0%，也绝不判成 noisy）", () => {
    const result = computeRuleNoise(rows(["never-fired", 0, 0]), {
      suppression_rate: 0.1,
      min_samples: 1,
    });
    // 0 条样本 < min_samples ⇒ 是"没数据"，不是"配了阈值就硬给个结论"；
    // 判成 not-configured 更糟——那会把"这条规则从没响过"和"没配阈值"混成一格
    expect(result[0]).toMatchObject({ rate: null, verdict: "insufficient-sample" });
  });

  it("排序确定性：吵的在前（rate 降序），同率按规则码点序（不用 localeCompare）", () => {
    const result = computeRuleNoise(
      rows(["z-rule", 1, 9], ["a-rule", 1, 9], ["mid-rule", 8, 2]),
      { suppression_rate: 0.5, min_samples: 2 },
    );
    // z-rule 与 a-rule 都是 9/10 = 0.9（并列，按码点 a < z）；mid-rule 只有 2/10 = 0.2 排最后
    expect(result.map((row) => row.rule)).toEqual(["a-rule", "z-rule", "mid-rule"]);
    // 再跑一次逐字一致（确定性是本项目的红线之一）
    const again = computeRuleNoise(
      rows(["z-rule", 1, 9], ["a-rule", 1, 9], ["mid-rule", 8, 2]),
      { suppression_rate: 0.5, min_samples: 2 },
    );
    expect(again).toEqual(result);
  });

  it("负数输入直接拒（不夹成 0 后继续算，那是把调用方的 bug 藏起来）", () => {
    expect(() => computeRuleNoise(rows(["x", -1, 2]), {})).toThrow(/负/);
    expect(() => computeRuleNoise(rows(["x", 2, -1]), {})).toThrow(/负/);
  });
});
