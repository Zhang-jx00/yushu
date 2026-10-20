/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  PUBLISH_STATUSES,
  buildPublishEvent,
  canTransition,
  checkWordGate,
  parsePublishLedger,
  parsePublishRules,
  planPublishReminders,
  serializePublishLedger,
  type PublishEvent,
  type PublishScheduleRow,
} from "../src/publish";

/**
 * 发布状态机 + 定时发布（本地提醒队列）+ 章节字数闸（R105 / M5 T5-6，引擎侧）。
 *
 * 判据回源：
 * - **docs/03 §5.3** 的 `Chapter.status: 'draft' | 'revised' | 'published'`——架构文档与已实现的
 *   `chapterSchema` 枚举逐字一致，本模块**只认这三个**，不另立一套；
 * - **I01 §5 更新状态机**：`draft → stock → scheduled → published → revised`，"均可回退，回退记录留痕"。
 *   存稿（stock）与定时（scheduled）是"还没发"的两副面孔，投影到三态就是 `draft`；
 *   `revised` 只在 `published` 之后成立（从没发过的章不存在"修订"）——
 *   所以 `draft → revised` 是**非法迁移**，不是"少见但允许"；
 * - **I01 §3.7 / §5**：定时发布是**本地提醒队列**，应用离线时启动后补发提示，**不代替平台发布**；
 * - **I01 §5 校验规则** `chapter-word-floor`：单章字数低于平台下限 ⇒ warn，
 *   **规则参数来自平台规则包**（I07 §3.1：平台规则外置，每条带 source_url / effective_date / version），
 *   应用只读不硬编码 ⇒ **包里没声明下限就不判**（宁缺毋造，不拿别的平台的数字来凑）；
 * - **番茄官方口径**（I08 §3.2/§3.3）："章节结构优先，字数并不在优先考虑的范围"
 *   ⇒ 番茄**不设单章下限**；它的字数门槛是**当日**全勤档（普通 4,000 / 进阶 6,000）。
 *
 * **两条不做**：① 不查平台、不代替作者发布（`status` 记的是作者自己登记的本地状态）；
 * ② 不算平台"有效字数"——番茄的口径是"后台打卡口径（自然月内每日有效过审字数）"，
 * 本地算不了就把口径名带出来，**不拿本地字数冒充有效字数**。
 */

const AT = "2026-10-20T20:00:00+08:00";

function row(overrides: Partial<PublishScheduleRow> = {}): PublishScheduleRow {
  return { id: "ch-001", title: "第1章 夜探藏经阁", status: "draft", wordCount: 3120, ...overrides };
}

describe("发布状态机 — 合法迁移与回退（I01 §5）", () => {
  it("三态与 docs/03 §5.3、chapterSchema 枚举逐字一致（不多不少不少改）", () => {
    expect([...PUBLISH_STATUSES]).toEqual(["draft", "revised", "published"]);
  });

  it("草稿 → 已发布、已发布 → 修订中、修订中 → 已发布：都是合法迁移", () => {
    expect(canTransition("draft", "published").ok).toBe(true);
    expect(canTransition("published", "revised").ok).toBe(true);
    expect(canTransition("revised", "published").ok).toBe(true);
  });

  it("草稿 → 修订中非法：没发过的章不存在「修订」（I01 的 revised 只接在 published 之后）", () => {
    const result = canTransition("draft", "revised");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("E_PUBLISH_TRANSITION_INVALID");
    expect(result.reason).toContain("修订");
  });

  it("回退合法：已发布 / 修订中 → 草稿，并标记为回退（回退要留痕）", () => {
    const back1 = canTransition("published", "draft");
    const back2 = canTransition("revised", "draft");
    expect(back1.ok).toBe(true);
    expect(back1.rollback).toBe(true);
    expect(back2.ok).toBe(true);
    expect(back2.rollback).toBe(true);
  });

  it("向前迁移不算回退", () => {
    expect(canTransition("draft", "published").rollback).toBe(false);
    expect(canTransition("published", "revised").rollback).toBe(false);
  });

  it("同状态迁移幂等（不重复记账）", () => {
    const result = canTransition("draft", "draft");
    expect(result.ok).toBe(true);
    expect(result.rollback).toBe(false);
  });

  it("未知状态被拒，不当默认值放行", () => {
    const result = canTransition("draft", "archived");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("E_PUBLISH_STATUS_UNKNOWN");
  });

  it("留痕事件带齐 from / to / 时刻 / 当时字数 / 是否回退", () => {
    const event = buildPublishEvent({ chapterId: "ch-001", from: "draft", to: "published", at: AT, wordCount: 3120 });
    expect(event).toMatchObject({
      chapterId: "ch-001",
      from: "draft",
      to: "published",
      at: AT,
      wordCount: 3120,
      rollback: false,
    });
  });
});

describe("定时发布 — 本地提醒队列（I01 §3.7）", () => {
  it("到点且未发布 ⇒ 进提醒队列", () => {
    const reminders = planPublishReminders(
      [row({ publishAt: "2026-10-20T19:00:00+08:00" })],
      AT,
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.id).toBe("ch-001");
  });

  it("已发布的章不进提醒（发过了就没有待办）", () => {
    const reminders = planPublishReminders(
      [row({ status: "published", publishAt: "2026-10-20T19:00:00+08:00" })],
      AT,
    );
    expect(reminders).toEqual([]);
  });

  it("没设发布时刻 / 还没到点 ⇒ 不进队列", () => {
    expect(planPublishReminders([row()], AT)).toEqual([]);
    expect(planPublishReminders([row({ publishAt: "2026-10-20T21:00:00+08:00" })], AT)).toEqual([]);
  });

  it("队列按发布时刻升序，同刻按 id 码点序（红线 5：同输入必得同输出）", () => {
    const reminders = planPublishReminders(
      [
        row({ id: "ch-003", publishAt: "2026-10-20T19:00:00+08:00" }),
        row({ id: "ch-001", publishAt: "2026-10-20T19:00:00+08:00" }),
        row({ id: "ch-002", publishAt: "2026-10-20T12:00:00+08:00" }),
      ],
      AT,
    );
    expect(reminders.map((item) => item.id)).toEqual(["ch-002", "ch-001", "ch-003"]);
  });

  it("离线补发：过了发布时刻很久也要列出来，并带逾期时长（不因错过就不提醒）", () => {
    const reminders = planPublishReminders([row({ publishAt: "2026-10-01T12:00:00+08:00" })], AT);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.dueMs).toBeGreaterThan(0);
  });
});

describe("平台规则包 — 严格解析（I07 §3.1：带来源与生效日期，应用只读不硬编码）", () => {
  const valid = [
    "platform: fanqie",
    "version: 1.0.0",
    "effective_date: 2025-01-01",
    "source_urls:",
    "  - https://fanqienovel.com/writer/zone/help",
    "valid_word_rule: 后台打卡口径",
    "daily:",
    "  standard: 4000",
    "  advanced: 6000",
  ].join("\n");

  it("来源与生效日期齐全的包能解析", () => {
    const rules = parsePublishRules(valid);
    expect(rules.platform).toBe("fanqie");
    expect(rules.sourceUrls).toHaveLength(1);
    expect(rules.daily?.standard).toBe(4000);
  });

  it("缺来源 ⇒ 报错（宁缺毋造：没有出处的数字不许进包）", () => {
    expect(() => parsePublishRules(valid.replace(/source_urls:[\s\S]*?valid_word_rule/s, "valid_word_rule:"))).toThrow();
  });

  it("缺生效日期 ⇒ 报错", () => {
    expect(() => parsePublishRules(valid.replace("effective_date: 2025-01-01\n", ""))).toThrow();
  });

  it("未知键 ⇒ 报错（悄悄加一个代码不认识的字段比报错危险）", () => {
    expect(() => parsePublishRules(`${valid}\nunknown_key: 1`)).toThrow();
  });
});

describe("章节字数闸 — 参数只从规则包来（I01 §5 + I07）", () => {
  const rules = parsePublishRules(
    [
      "platform: fanqie",
      "version: 1.0.0",
      "effective_date: 2025-01-01",
      "source_urls:",
      "  - https://fanqienovel.com/writer/zone/help",
      "valid_word_rule: 后台打卡口径（自然月内每日有效过审字数）",
      "per_chapter:",
      "  min: 3000",
      "daily:",
      "  standard: 4000",
      "  advanced: 6000",
    ].join("\n"),
  );

  it("分布统计：条数 / 合计 / 最小 / 最大 / 中位数", () => {
    const result = checkWordGate(
      [row({ id: "ch-001", wordCount: 1000 }), row({ id: "ch-002", wordCount: 3000 }), row({ id: "ch-003", wordCount: 5000 })],
      rules,
      [],
      AT,
    );
    expect(result.count).toBe(3);
    expect(result.total).toBe(9000);
    expect(result.min).toBe(1000);
    expect(result.max).toBe(5000);
    expect(result.median).toBe(3000);
  });

  it("低于平台单章下限的章逐条点名", () => {
    const result = checkWordGate([row({ id: "ch-001", title: "短章", wordCount: 1200 })], rules, [], AT);
    expect(result.perChapterFloorDeclared).toBe(true);
    expect(result.belowFloor.map((item) => item.id)).toEqual(["ch-001"]);
  });

  it("包里没声明单章下限 ⇒ 不判（不拿别的平台的数字来凑）", () => {
    const noFloor = parsePublishRules(
      [
        "platform: fanqie",
        "version: 1.0.0",
        "effective_date: 2025-01-01",
        "source_urls:",
        "  - https://fanqienovel.com/writer/zone/help",
        "valid_word_rule: 后台打卡口径",
      ].join("\n"),
    );
    const result = checkWordGate([row({ wordCount: 10 })], noFloor, [], AT);
    expect(result.perChapterFloorDeclared).toBe(false);
    expect(result.belowFloor).toEqual([]);
  });

  it("平台「有效字数」口径名要被带出来（本地算不了后台口径，不能拿本地字数冒充）", () => {
    const result = checkWordGate([row()], rules, [], AT);
    expect(result.validWordRule).toContain("后台打卡口径");
  });

  it("当日口径：当天发布的章字数合计对上全勤档；回退的章不算数", () => {
    const events: PublishEvent[] = [
      { chapterId: "ch-001", from: "draft", to: "published", at: "2026-10-20T09:00:00+08:00", wordCount: 2500, rollback: false },
      { chapterId: "ch-002", from: "draft", to: "published", at: "2026-10-20T10:00:00+08:00", wordCount: 2000, rollback: false },
      { chapterId: "ch-003", from: "draft", to: "published", at: "2026-10-20T11:00:00+08:00", wordCount: 5000, rollback: false },
      { chapterId: "ch-003", from: "published", to: "draft", at: "2026-10-20T12:00:00+08:00", wordCount: 5000, rollback: true },
    ];
    const result = checkWordGate(
      [row({ id: "ch-001" }), row({ id: "ch-002" }), row({ id: "ch-003" })],
      rules,
      events,
      AT,
    );
    expect(result.daily?.publishedChars).toBe(4500);
    expect(result.daily?.reached).toEqual(["standard"]);
  });

  it("达档要说清是哪一档：两档都到时进阶档也要列出来", () => {
    const events: PublishEvent[] = [
      { chapterId: "ch-001", from: "draft", to: "published", at: "2026-10-20T09:00:00+08:00", wordCount: 7000, rollback: false },
    ];
    const result = checkWordGate([row()], rules, events, AT);
    expect(result.daily?.reached).toEqual(["standard", "advanced"]);
  });

  it("包没声明当日口径 ⇒ 不给当日结论（没配置就不判）", () => {
    const noDaily = parsePublishRules(
      [
        "platform: fanqie",
        "version: 1.0.0",
        "effective_date: 2025-01-01",
        "source_urls:",
        "  - https://fanqienovel.com/writer/zone/help",
        "valid_word_rule: 后台打卡口径",
      ].join("\n"),
    );
    const result = checkWordGate([row()], noDaily, [], AT);
    expect(result.daily).toBeUndefined();
  });
});

describe("发布台账 — 回退留痕（I01 §5「回退记录留痕」）", () => {
  const ledgerYaml = [
    "apiVersion: yushu.publish/v1",
    "events:",
    "  - chapter_id: ch-001",
    "    from: draft",
    "    to: published",
    "    at: 2026-10-20T20:00:00+08:00",
    "    word_count: 3120",
    "    rollback: false",
    "  - chapter_id: ch-001",
    "    from: published",
    "    to: draft",
    "    at: 2026-10-21T10:00:00+08:00",
    "    word_count: 3120",
    "    rollback: true",
    "    note: 平台审稿没过，退回改",
  ].join("\n");

  it("合法台账能解析，留痕按时间排着", () => {
    const ledger = parsePublishLedger(ledgerYaml);
    expect(ledger.apiVersion).toBe("yushu.publish/v1");
    expect(ledger.events).toHaveLength(2);
    expect(ledger.events[1]?.rollback).toBe(true);
    expect(ledger.events[1]?.note).toContain("审稿");
  });

  it("apiVersion 不对 ⇒ 报错（不静默按旧版本读）", () => {
    expect(() => parsePublishLedger(ledgerYaml.replace("yushu.publish/v1", "yushu.publish/v2"))).toThrow();
  });

  it("未知键 ⇒ 报错（悄悄忽略的字段比报错危险）", () => {
    expect(() => parsePublishLedger(`${ledgerYaml}
    unknown: 1`)).toThrow();
  });

  it("事件里的状态非法 ⇒ 报错", () => {
    expect(() => parsePublishLedger(ledgerYaml.replace("    to: published", "    to: archived"))).toThrow();
  });

  it("序列化后再解析逐字一致（往返不丢字段）", () => {
    const ledger = parsePublishLedger(ledgerYaml);
    const round = parsePublishLedger(serializePublishLedger(ledger));
    expect(round).toEqual(ledger);
  });

  it("序列化是确定的：同输入必得同字节（可 diff、可进快照）", () => {
    const ledger = parsePublishLedger(ledgerYaml);
    expect(serializePublishLedger(ledger)).toBe(serializePublishLedger(ledger));
  });
});
