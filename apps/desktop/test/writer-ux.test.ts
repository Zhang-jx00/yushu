import { describe, expect, it } from "vitest";
import { diffSentences, mergeSelected, splitSentences } from "../renderer/src/candidate-diff";
import { TypewriterBuffer } from "../renderer/src/typewriter-buffer";

/**
 * T3-11 写作 UX 纯逻辑：
 * - 打字机缓冲（token 缓冲 + 每帧 flush；匀速 / 瞬时两档）；
 * - 候选句级 diff 与局部采纳（splitSentences / diffSentences / mergeSelected）。
 */

describe("打字机缓冲（T3-11，J08）", () => {
  it("匀速：每帧上限吐出，剩余进入下一帧；flushAll 整块直出", () => {
    const buffer = new TypewriterBuffer({ maxCharsPerFrame: 4 });
    buffer.push("天启");
    buffer.push("界的");
    buffer.push("夜色");
    expect(buffer.pending).toBe(6);
    expect(buffer.flushFrame()).toBe("天启界的");
    expect(buffer.text).toBe("天启界的");
    expect(buffer.pending).toBe(2);
    expect(buffer.flushFrame()).toBe("夜色");
    expect(buffer.flushFrame()).toBe("");
    expect(buffer.fullText).toBe("天启界的夜色");
  });

  it("瞬时：整块直出；空 chunk 不产生渲染", () => {
    const buffer = new TypewriterBuffer({ mode: "instant" });
    buffer.push("");
    expect(buffer.flushFrame()).toBe("");
    buffer.push("第一段。");
    buffer.push("第二段。");
    expect(buffer.flushFrame()).toBe("第一段。第二段。");
    expect(buffer.pending).toBe(0);
  });

  it("中途切换模式：待渲染缓冲按新档位 flush", () => {
    const buffer = new TypewriterBuffer({ maxCharsPerFrame: 2 });
    buffer.push("abcdef");
    expect(buffer.flushFrame()).toBe("ab");
    buffer.setMode("instant");
    expect(buffer.flushFrame()).toBe("cdef");
    expect(buffer.getMode()).toBe("instant");
  });

  it("flushAll：停止 / 完成时把剩余缓冲一次交付（无内容时为空串）", () => {
    const buffer = new TypewriterBuffer({ maxCharsPerFrame: 1 });
    buffer.push("甲乙丙");
    expect(buffer.flushFrame()).toBe("甲");
    expect(buffer.flushAll()).toBe("乙丙");
    expect(buffer.flushAll()).toBe("");
    expect(buffer.text).toBe("甲乙丙");
  });
});

describe("候选句级 diff 与局部采纳（T3-11，J15）", () => {
  it("splitSentences：中文终止符 / 连续终止符与收尾引号 / 换行", () => {
    expect(splitSentences("夜色压下来。林渊拔剑而起！他笑了……")).toEqual([
      "夜色压下来。",
      "林渊拔剑而起！",
      "他笑了……",
    ]);
    expect(splitSentences("「住手！」他喊道。")).toEqual(["「住手！」", "他喊道。"]);
    expect(splitSentences("第一段\n第二段")).toEqual(["第一段", "第二段"]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });

  it("diffSentences：新增 / 移除 / 共有与字数统计（确定性）", () => {
    const diff = diffSentences("夜色压下来。他走进了夜色里。", "夜色压下来。林渊拔剑而起（候选2）。");
    expect(diff.added).toEqual(["林渊拔剑而起（候选2）。"]);
    expect(diff.removed).toEqual(["他走进了夜色里。"]);
    expect(diff.shared).toBe(1);
    expect(diff.addedChars).toBe("林渊拔剑而起（候选2）。".length);
    expect(diff.removedChars).toBe("他走进了夜色里。".length);
  });

  it("mergeSelected：按勾选顺序合并（去空行）；局部采纳文本可复现", () => {
    expect(mergeSelected(["夜色压下来。", "", "林渊拔剑而起。"])).toBe("夜色压下来。\n林渊拔剑而起。");
    expect(mergeSelected(["  第二句。", " "])).toBe("第二句。");
  });
});