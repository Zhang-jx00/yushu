import type { ConsistencySpan } from "@yushu/world-engine";

/**
 * 台账（YAML 列表）里按 id 定位原文区间（M4 / T4-2，R75）。
 *
 * 伏笔结论挂在 `world/foreshadow.yaml` 的条目上，不在任何设定卡里，而 T4-3 的报告格式
 * 要求每条结论都能切片到原文。这里只做定位：**找不到就返回 `null`，绝不给 0-0 的假区间**——
 * 假区间会让面板跳到文件开头高亮一行无关内容，比不跳更糟。
 *
 * 只认**顶层列表的条目起始行**（`  - id: <值>`，整行就是这个键值）：
 * 前缀相同的 id（`fs-a` 与 `fs-ab`）不会互相误命中，因为比对的是整行的值而不是 `includes`。
 */

const ENTRY_START = /^([ \t]*)-[ \t]+id:[ \t]*(\S+)[ \t]*$/;

export function locateLedgerEntrySpan(text: string, file: string, entryId: string): ConsistencySpan | null {
  if (text === "" || entryId.trim() === "") return null;
  let offset = 0;
  let target: { start: number; indent: string } | null = null;
  let next: number | null = null;
  for (const line of text.split("\n")) {
    const match = ENTRY_START.exec(line);
    if (match !== null) {
      const indent = match[1] as string;
      const id = match[2] as string;
      if (target === null && id === entryId) {
        target = { start: offset, indent };
      } else if (target !== null && next === null && indent === target.indent) {
        next = offset;
      }
    }
    offset += line.length + 1;
  }
  if (target === null) return null;
  const end = next ?? text.length;
  // 区间是原始字节（面板切片用 `start`/`end`），text 只作展示：两头空白都去掉
  return { file, start: target.start, end, text: text.slice(target.start, end).trim() };
}
