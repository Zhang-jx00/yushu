import { describe, expect, it } from "vitest";
import { REPETITION_DEFAULTS, checkRepetition, findRepetitions } from "@yushu/text";

/**
 * 重复表达检测（`proofread-repetition-high`，J14 §2.5 / §3.5）：
 * 字级 n-gram 频次（缺省 n=5、≥3 次、对话段不参与——与 J14 §5 配置草案同口径）。
 * 重复短语是 AI 生成与注水的典型特征（"心中一凛""嘴角勾起一抹弧度"），故为 `info` 级提示而非错误。
 */

const BODY = "林渊心中一凛，随即按剑而立。对面来人心中一凛，退后半步。暗中观察的人心中一凛，握紧了刀。";

describe("findRepetitions：命中", () => {
  it("超阈值短语按出现次数降序给出", () => {
    const found = findRepetitions(BODY);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.count).toBeGreaterThanOrEqual(REPETITION_DEFAULTS.minCount);
    expect(found[0]!.phrase).toContain("心中一凛");
    const counts = found.map((item) => item.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("每个短语的位置升序且可切片回原文", () => {
    for (const item of findRepetitions(BODY)) {
      expect(item.positions).toEqual([...item.positions].sort((a, b) => a - b));
      for (const at of item.positions) {
        expect(BODY.slice(at, at + item.phrase.length)).toBe(item.phrase);
      }
    }
  });

  it("同一批位置的短短语不重复报（只留信息量最大的那条）", () => {
    const items = findRepetitions(BODY);
    const seen = new Map<string, number>();
    for (const item of items) {
      const key = item.positions.join(",");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const count of seen.values()) expect(count).toBe(1);
    expect(items.every((item) => item.phrase.length >= REPETITION_DEFAULTS.minN)).toBe(true);
  });

  it("阈值可调：minCount 拉到 4 后本段不报", () => {
    expect(findRepetitions(BODY, { minCount: 4 })).toEqual([]);
  });

  it("同输入同输出（确定性，排序含短语兜底键）", () => {
    expect(JSON.stringify(findRepetitions(BODY))).toBe(JSON.stringify(findRepetitions(BODY)));
  });
});

describe("checkRepetition：结果条目", () => {
  it("info 级、autofix=false（改法属创作决策，交人或 AI 候选）", () => {
    const found = checkRepetition(BODY, { chapter: "ch-001" });
    expect(found.length).toBeGreaterThan(0);
    const hit = found[0]!;
    expect(hit.rule).toBe("proofread-repetition-high");
    expect(hit.severity).toBe("info");
    expect(hit.autofix).toBe(false);
    expect(hit.span.chapter).toBe("ch-001");
    expect(hit.suggestion).toContain("替换候选");
    expect(hit.evidence).toContain("出现");
    expect(hit.source.engine).toBe("stat:ngram");
    expect(typeof hit.source.conf).toBe("number");
  });

  it("span 落在首次出现处", () => {
    const hit = checkRepetition(BODY)[0]!;
    expect(BODY.slice(hit.span.start, hit.span.end)).toBe(hit.span.text);
    expect(hit.span.start).toBe(findRepetitions(BODY)[0]!.positions[0]);
  });
});

describe("不该命中（误报抑制）", () => {
  it("短文（不足一个 n-gram 窗口）零命中", () => {
    expect(findRepetitions("林渊拔剑而起。")).toEqual([]);
    expect(checkRepetition("")).toEqual([]);
  });

  it("未达阈值的复现不报（两次不算注水）", () => {
    const text = "他心中一凛。片刻后他心中一凛，再次握剑。";
    expect(findRepetitions(text)).toEqual([]);
  });

  it("对话段默认不参与（对白复用是自然语言），关掉开关后才报", () => {
    const line = "我说过很多次了";
    const dialogue = `“${line}！”“${line}！”“${line}！”他喊道。`;
    expect(findRepetitions(dialogue)).toEqual([]);
    const opened = findRepetitions(dialogue, { ignoreDialogue: false });
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[0]!.phrase).toContain(line);
  });

  it("纯标点与空白零命中", () => {
    expect(findRepetitions("。，！？……——")).toEqual([]);
    expect(findRepetitions("   \n\n ")).toEqual([]);
  });
});
