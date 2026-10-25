/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  CARD_CONTEXT_MAX_CHARS,
  summarizeCardContext,
} from "../renderer/src/components/card-context.js";

/**
 * 编辑器页右栏「出处 · 原文 · 相关实体」的**纯函数**判据（R165）。
 *
 * ① **出处不许丢**（路径 / 名字 / 类型都在）；
 * ② **原文截断了就说截断了**（不许把片段当全文）；
 * ③ **相关实体逐条列**；
 * ④ **换个卡就换一份**（不许写死字面量）。
 */

describe("编辑器页右栏的卡上下文摘要（R165）：出处 / 原文 / 相关实体", () => {
  it("出处、原文、相关实体三样都在", () => {
    const summary = summarizeCardContext({
      path: "world/cards/character/char-1.md",
      card: {
        name: "林渊",
        type: "character",
        body: "主角。开篇在边城醒来。",
        refs: [{ relation: "师承", target: "char-2" }],
      },
    });
    expect(summary.path).toBe("world/cards/character/char-1.md");
    expect(summary.name).toBe("林渊");
    expect(summary.type).toBe("character");
    expect(summary.body).toBe("主角。开篇在边城醒来。");
    expect(summary.truncated).toBe(false);
    expect(summary.totalChars).toBe(11);
    expect(summary.refs).toEqual([{ relation: "师承", target: "char-2" }]);
  });

  it("原文**截断了就说截断了**（不许把片段当全文）", () => {
    const long = "字".repeat(CARD_CONTEXT_MAX_CHARS + 50);
    const summary = summarizeCardContext({
      path: "world/cards/item/itm-1.md",
      card: { name: "玄铁令", type: "item", body: long },
    });
    expect(summary.truncated).toBe(true);
    expect(summary.body.length).toBe(CARD_CONTEXT_MAX_CHARS);
    expect(summary.totalChars).toBe(CARD_CONTEXT_MAX_CHARS + 50);
  });

  it("没到上限就**不截断**（不许替作者截）", () => {
    const exact = "字".repeat(CARD_CONTEXT_MAX_CHARS);
    const summary = summarizeCardContext({
      path: "a.md",
      card: { name: "x", type: "item", body: exact },
    });
    expect(summary.truncated).toBe(false);
    expect(summary.body.length).toBe(CARD_CONTEXT_MAX_CHARS);
  });

  it("**换个卡就换一份**（不许写死字面量）", () => {
    const one = summarizeCardContext({
      path: "a.md",
      card: { name: "甲", type: "character", body: "甲的正文", refs: [{ relation: "仇敌", target: "乙" }] },
    });
    const two = summarizeCardContext({
      path: "b.md",
      card: { name: "乙", type: "location", body: "乙的正文" },
    });
    expect(one.name).toBe("甲");
    expect(one.refs.length).toBe(1);
    expect(two.name).toBe("乙");
    expect(two.refs.length).toBe(0);
    expect(two.body).toBe("乙的正文");
  });
});
