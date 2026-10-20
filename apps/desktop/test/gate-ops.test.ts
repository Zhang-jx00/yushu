/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATE_CHECK_ORIGIN,
  MEMORY_FACTS_DIR,
  OUTLINE_PATH,
  parseOutline,
} from "@yushu/world-engine";
import type { InjectionConfigPayload } from "../src/shared/ipc.js";
import { gateReportFindings, gateUnreadable } from "../src/main/gate-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { saveMemoryFact } from "../src/main/memory-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 注入门控核对的桌面侧（M4 / T4-2 第五批·第二段，R104）。
 *
 * 判定全在引擎（`gate-check.ts`），这里验的是宿主级的四件事：
 * ① **门控真从两处源读出来**：事实（`memory/facts/*.md` 的 frontmatter）与设定卡（卡上的 `injection`）——
 *    现成读取没有一个能一次给全（`loadMemoryState` 只给事实还把默认配置合并进来、看不出"这条自己填过门控"，
 *    `readAllCards` 只给卡），漏掉哪一处，那一处的悬空就永远看不见；
 * ② **章序用的是 `outlineChapterOrder` 那份单一口径**（与 R103 的可见性核对拿同一答案）；
 * ③ 跨项目的事实**不参与**：它本来就进不了本项目的注入计划，喊它"门控坏了"是转移视线；
 * ④ 读不动的事实文件不静默丢掉，单条点名进表。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

let dir: string;
let gateway: ProjectGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-gate-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

/** 建大纲并给第 1 章建草稿：返回章序里唯一真实存在的那个章 id */
async function draftFirstChapter(): Promise<string> {
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const volume = outline.volumes[0];
  const chapter = volume?.chapters[0];
  if (volume === undefined || chapter === undefined) throw new Error("夹具没能生成大纲章纲");
  const created = await createOutlineChapter(gateway, { volumeId: volume.id, chapterId: chapter.id, baseHash: snap.hash });
  return created.chapterId;
}

function gate(revealGate: string): InjectionConfigPayload {
  return { mode: "always", priority: 60, position: "after_system", budget_tokens: 100, reveal_gate: revealGate };
}

/** 给卡加门控：走真 writer 建卡，再把 injection 块插进 frontmatter（界面上没有这个入口，只能落真源） */
async function addGatedCard(id: string, name: string, gate: string): Promise<string> {
  const written = await writeCardDoc(gateway, {
    card: { id, type: "character", name, layer: "characters", visibility: "hidden" },
    body: `## ${name}\n`,
  });
  const snap = await gateway.readDoc(written.path);
  const withGate = snap.content.replace(/\n---\n/, `\ninjection:\n  mode: always\n  reveal_gate: ${gate}\n---\n`);
  await gateway.writeDoc(written.path, withGate, snap.hash);
  return written.path;
}

describe("注入门控结论进体检表", () => {
  it("没有任何带门控的条目 ⇒ 零结论（没配置不该占一行）", async () => {
    await draftFirstChapter();
    expect(await gateReportFindings(gateway)).toEqual([]);
  });

  it("事实的门控指向不存在的章 ⇒ 一条 warn，主体是事实 id，证据说清它永不生效", async () => {
    await draftFirstChapter();
    const saved = await saveMemoryFact(gateway, { keys: ["玄铁令"], text: "门控写错章 id 的事实。", injection: gate("ch-zzz999") });
    const rows = await gateReportFindings(gateway);
    expect(rows.map((row) => [row.rule, row.severity, row.related])).toEqual([["gate-chapter-unknown", "warn", "ch-zzz999"]]);
    expect(rows[0]?.subject).toBe(saved.id);
    expect(rows[0]?.evidence).toContain("不注入");
    expect(rows[0]?.origin).toBe(GATE_CHECK_ORIGIN);
  });

  it("门控指向存在的章 ⇒ 零结论（未到章不注入是设计，不是缺陷）", async () => {
    const chapterId = await draftFirstChapter();
    await saveMemoryFact(gateway, { keys: ["玄铁令"], text: "门控正确的事实。", injection: gate(chapterId) });
    expect(await gateReportFindings(gateway)).toEqual([]);
  });

  it("卡上的 injection.reveal_gate 也读得到：这条链分散在两处真源，漏一处就永远看不见", async () => {
    await draftFirstChapter();
    await addGatedCard("char-gated", "被门控的卡", "co-1");
    const rows = await gateReportFindings(gateway);
    expect(rows.map((row) => [row.rule, row.subject, row.related])).toEqual([["gate-chapter-unknown", "char-gated", "co-1"]]);
    /** 章纲 id（co-…）不是正文章 id：拿它当门控等于永远解析不到 */
    expect(rows[0]?.evidence).toContain("co-1");
  });

  it("章序一条都取不到时只发一条总述，不逐条喊悬空", async () => {
    await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 1,
      chaptersPerVolume: 2,
    });
    await saveMemoryFact(gateway, { keys: ["甲"], text: "第一条带门控的事实。", injection: gate("ch-003") });
    await saveMemoryFact(gateway, { keys: ["乙"], text: "第二条带门控的事实。", injection: gate("ch-004") });
    const rows = await gateReportFindings(gateway);
    expect(rows.map((row) => row.rule)).toEqual(["gate-no-chapter-order"]);
    expect(rows[0]?.severity).toBe("info");
    /** 表上没有 message 列："判不了"那句必须落在 evidence 里（R103 的教训） */
    expect(rows[0]?.evidence).toContain("不等于");
  });

  it("跨项目的事实不参与核对：它本来就进不了本项目的注入计划", async () => {
    await draftFirstChapter();
    const { serializeFact } = await import("@yushu/memory");
    await gateway.writeDoc(
      `${MEMORY_FACTS_DIR}/fact-foreign.md`,
      serializeFact({
        layer: "fact",
        id: "fact-foreign",
        project_id: "world-someone-else",
        keys: ["外来"],
        text: "来自其它项目的事实。",
        updated_at: "2026-10-20T00:00:00.000Z",
        injection: { mode: "always", priority: 60, position: "after_system", budget_tokens: 100, reveal_gate: "ch-zzz999" },
      }),
    );
    expect(await gateReportFindings(gateway)).toEqual([]);
  });

  it("事实文件读不动 ⇒ 单条点名，不消失在零结论里", async () => {
    await draftFirstChapter();
    await gateway.writeDoc(`${MEMORY_FACTS_DIR}/fact-broken.md`, "---\nid: [坏 YAML\n---\n正文\n");
    const bad = await gateUnreadable(gateway);
    expect(bad.map((row) => row.path)).toEqual([`${MEMORY_FACTS_DIR}/fact-broken.md`]);
    const rows = await gateReportFindings(gateway);
    expect(rows.map((row) => [row.rule, row.severity, row.subject])).toEqual([
      ["gate-record-unreadable", "warn", `${MEMORY_FACTS_DIR}/fact-broken.md`],
    ]);
  });

  it("事实与卡混排时按 id 码点序，两次重跑逐字一致（红线 5）", async () => {
    await draftFirstChapter();
    await addGatedCard("char-zzz", "甲卡", "ch-nope");
    await saveMemoryFact(gateway, { keys: ["丙"], text: "一条事实。", injection: gate("ch-nope") });
    const first = await gateReportFindings(gateway);
    const second = await gateReportFindings(gateway);
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first.map((row) => row.subject)).toEqual([...first.map((row) => row.subject)].sort());
  });
});
