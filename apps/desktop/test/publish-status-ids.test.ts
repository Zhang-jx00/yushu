/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 发布状态的**四处口径必须逐字一致**（R105 / M5 T5-6）。
 *
 * 这条锁盯的是一处很具体、也很贵的漂移：发布状态在仓库里有**四份**写法——
 * ① 引擎的 `PUBLISH_STATUSES`（判定的唯一事实源）；
 * ② schema 的 `chapterSchema.status` 枚举（写盘前的校验）；
 * ③ `apps/desktop/src/shared/ipc.ts` 的 `PublishStatus`（**零依赖文件**，只能本地写一份）；
 * ④ `@yushu/core` 的 `ChapterStatus`（章节类型）。
 *
 * 少改一处不会立刻报错，但会出两种很难查的坏：
 * - 引擎认得、schema 不认 ⇒ 写出去的章**过不了自己的校验**（读回来就报错）；
 * - schema 认得、引擎不认 ⇒ 引擎把新状态当"未知"静默跳过，**状态机看起来在工作，其实没判**。
 *
 * 共享层那份为什么不能直接 import 引擎：那个文件明确保持零依赖（跨进程契约不许拖引擎包进来），
 * 于是"抄一份"不可避免——那就用这条锁把它钉死。
 */

const engine = readFileSync(new URL("../../../packages/@yushu/world-engine/src/publish.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../../packages/@yushu/schema/src/schemas.ts", import.meta.url), "utf8");
const shared = readFileSync(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
const core = readFileSync(new URL("../../../packages/@yushu/core/src/types.ts", import.meta.url), "utf8");

/** 从 `PUBLISH_STATUSES = ["draft", "revised", "published"] as const` 里取出三个值 */
function engineStatuses(): string[] {
  const match = /PUBLISH_STATUSES\s*=\s*\[([^\]]*)\]/.exec(engine);
  if (match === null) throw new Error("publish.ts 里找不到 PUBLISH_STATUSES（改了结构就要同步改这条锁）");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

/** 从 `status: { enum: ["draft", "revised", "published"] }` 里取出三个值 */
function schemaStatuses(): string[] {
  const match = /status:\s*\{\s*enum:\s*\[([^\]]*)\]/.exec(schema);
  if (match === null) throw new Error("schemas.ts 里找不到 chapterSchema 的 status 枚举");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

/** 从 `export type PublishStatus = "draft" | "revised" | "published";` 里取出三个值 */
function sharedStatuses(): string[] {
  const match = /export type PublishStatus\s*=\s*([^;]+);/.exec(shared);
  if (match === null) throw new Error("shared/ipc.ts 里找不到 PublishStatus 类型");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

/** 从 `export type ChapterStatus = "draft" | "revised" | "published";` 里取出三个值 */
function coreStatuses(): string[] {
  const match = /export type ChapterStatus\s*=\s*([^;]+);/.exec(core);
  if (match === null) throw new Error("core/types.ts 里找不到 ChapterStatus 类型");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

describe("发布状态四处口径逐字一致（R105）", () => {
  it("引擎的 PUBLISH_STATUSES 就是那三个值", () => {
    expect(engineStatuses()).toEqual(["draft", "revised", "published"]);
  });

  it("schema 的枚举与引擎逐字一致（写出去的章过得了自己的校验）", () => {
    expect(schemaStatuses()).toEqual(engineStatuses());
  });

  it("共享层的 PublishStatus 与引擎逐字一致（零依赖文件抄的那一份）", () => {
    expect(sharedStatuses()).toEqual(engineStatuses());
  });

  it("core 的 ChapterStatus 与引擎逐字一致", () => {
    expect(coreStatuses()).toEqual(engineStatuses());
  });

  it("状态名与 docs/03 §5.3 的枚举一致（架构文档是最高口径）", () => {
    // docs/03 §5.3：status: 'draft' | 'revised' | 'published'
    expect(engineStatuses()).toEqual(["draft", "revised", "published"]);
  });
});
