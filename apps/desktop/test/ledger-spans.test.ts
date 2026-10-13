import { describe, expect, it } from "vitest";
import { locateLedgerEntrySpan } from "../src/main/ledger-spans.js";

/**
 * 台账（YAML 列表）里按 id 定位原文区间——给"伏笔结论并入全书体检"用（M4 / T4-2，R75）。
 *
 * 报告格式（T4-3）要求每条结论都能切片到原文，但伏笔的结论挂在 `world/foreshadow.yaml`
 * 的条目上，不在任何设定卡里。这里只做一件事：**找到那条目的字节区间**；
 * 找不到就返回 `null`，**不给 0-0 的假区间**（假区间会让面板跳到文件开头并高亮一行无关内容，
 * 那比不跳更糟——R53 立这条格式时就是冲着这个来的）。
 */

const LEDGER = [
  "apiVersion: yushu.foreshadow/v1",
  "entries:",
  "  - id: fs-a",
  "    name: 断剑的重铸",
  "    state: planted",
  "  - id: fs-b",
  "    name: 祖宅的青铜钥匙",
  "    state: due",
  "",
].join("\n");

describe("locateLedgerEntrySpan", () => {
  it("命中首条：区间从 `- id` 那行起，到下一条目前止", () => {
    const span = locateLedgerEntrySpan(LEDGER, "world/foreshadow.yaml", "fs-a");
    expect(span).not.toBeNull();
    expect(span!.file).toBe("world/foreshadow.yaml");
    expect(LEDGER.slice(span!.start, span!.end)).toContain("断剑的重铸");
    expect(LEDGER.slice(span!.start, span!.end)).not.toContain("祖宅的青铜钥匙");
    expect(span!.text.startsWith("- id: fs-a")).toBe(true);
  });

  it("命中末条：区间延伸到文件末尾", () => {
    const span = locateLedgerEntrySpan(LEDGER, "world/foreshadow.yaml", "fs-b");
    expect(span).not.toBeNull();
    expect(LEDGER.slice(span!.start)).toContain("祖宅的青铜钥匙");
    expect(span!.end).toBe(LEDGER.length);
  });

  it("id 不存在 ⇒ null，不给假区间", () => {
    expect(locateLedgerEntrySpan(LEDGER, "world/foreshadow.yaml", "fs-none")).toBeNull();
  });

  it("id 只是别的 id 的前缀时不误命中（fs-a 不能匹配 fs-ab）", () => {
    const text = LEDGER.replace("  - id: fs-b", "  - id: fs-ab");
    const ab = locateLedgerEntrySpan(text, "p", "fs-ab");
    expect(ab).not.toBeNull();
    expect(text.slice(ab!.start, ab!.end)).toContain("祖宅的青铜钥匙");
    const a = locateLedgerEntrySpan(text, "p", "fs-a");
    expect(a).not.toBeNull();
    // 相邻不重叠：a 的末点正好是 ab 的起点；且 a 的原文里不能混进下一条目的内容
    expect(a!.end).toBe(ab!.start);
    expect(a!.text).not.toContain("祖宅的青铜钥匙");
  });

  it("空文本与空 id 都安全返回 null", () => {
    expect(locateLedgerEntrySpan("", "p", "fs-a")).toBeNull();
    expect(locateLedgerEntrySpan(LEDGER, "p", "")).toBeNull();
  });

  it("同输入同输出：两次定位的区间逐字节相同", () => {
    const a = locateLedgerEntrySpan(LEDGER, "p", "fs-a");
    const b = locateLedgerEntrySpan(LEDGER, "p", "fs-a");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
