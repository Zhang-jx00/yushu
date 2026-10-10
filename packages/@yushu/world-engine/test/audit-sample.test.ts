import { describe, expect, it } from "vitest";
import { sampleForAudit } from "@yushu/world-engine";

/**
 * 全书体检的 AI 采样器（M4 / T4-4 的"重规则 + AI 采样"，R58）。
 *
 * 采样必须确定性：同一批正文两次结果逐字相同，否则作者没法比较两次体检，
 * 也没法定位"这条 AI 结论是从哪一段来的"。这里不引入随机数与 seed——
 * 规则本身就是确定的：按章轮转，每轮取该章下一段够长的正文。
 */

const chapter = (id: string, paragraphs: string[]) => ({
  chapterId: id,
  path: `chapters/vol-1/${id}.md`,
  body: paragraphs.join("\n\n"),
});

const LONG_A = "林渊按剑立在城口，夜色像水一样漫过整座边城。";
const LONG_B = "海泽带来一封没有落款的信，信纸边缘被火燎过。";
const LONG_C = "灵气潮汐在子时到达顶点，随后迅速退去，池底露出裂纹。";

describe("体检采样器", () => {
  it("按章轮转取段：不是把第一章刷满", () => {
    const samples = sampleForAudit(
      [
        chapter("ch-001", [LONG_A, LONG_A + LONG_A, LONG_A + LONG_A + LONG_A]),
        chapter("ch-002", [LONG_B]),
        chapter("ch-003", [LONG_C]),
      ],
      3,
    );
    expect(samples.map((s) => s.chapterId)).toEqual(["ch-001", "ch-002", "ch-003"]);
  });

  it("span 与正文切片逐字对齐（面板要按它高亮，偏一个字符就是错的）", () => {
    const c = chapter("ch-001", [LONG_A]);
    const samples = sampleForAudit([c], 1);
    expect(samples).toHaveLength(1);
    const sample = samples[0]!;
    expect(c.body.slice(sample.start, sample.end)).toBe(sample.quote);
    expect(sample.path).toBe("chapters/vol-1/ch-001.md");
  });

  it("同一批正文两次采样结果完全一致（确定性，不引入随机）", () => {
    const chapters = [chapter("ch-001", [LONG_A, LONG_B]), chapter("ch-002", [LONG_C, LONG_A])];
    expect(JSON.stringify(sampleForAudit(chapters, 4))).toBe(JSON.stringify(sampleForAudit(chapters, 4)));
  });

  it("太短的段落不参与采样：「今天写完了」这种没有核验价值", () => {
    const samples = sampleForAudit([chapter("ch-001", ["今天写完了。", LONG_A])], 5);
    expect(samples.map((s) => s.quote)).toEqual([LONG_A]);
  });

  it("limit 超过可用段落数时如实少给，不重复凑数", () => {
    const samples = sampleForAudit([chapter("ch-001", [LONG_A]), chapter("ch-002", [LONG_B])], 10);
    expect(samples).toHaveLength(2);
    expect(new Set(samples.map((s) => `${s.chapterId}:${s.start}`)).size).toBe(2);
  });

  it("没有正文时返回空数组，不报错", () => {
    expect(sampleForAudit([], 5)).toEqual([]);
    expect(sampleForAudit([chapter("ch-001", ["", "   "])], 5)).toEqual([]);
  });
});
