/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  canTransitionImportJob,
  IMPORT_JOB_API_VERSION,
  IMPORT_JOB_CORRECTION_KINDS,
  IMPORT_JOB_STATUSES,
  IMPORT_JOB_TRANSITIONS,
  isResumableImportJob,
  parseImportJob,
  serializeImportJob,
  type ImportJob,
} from "../src/import-job.js";

/**
 * 导入任务的 schema 与状态机（M5 / T5-7 第三段，R108；判据回源 I09 §2.7 / §3.1 / §5）。
 *
 * 这一层是纯函数，锁的是三件事：
 * ① **状态机是闭合的**：I09 §3.1 写死了 `pending → running → needs_review → done/failed`，
 *    非法迁移要**给出理由**（界面按引擎给的矩阵渲染按钮，不自己抄一份表）；
 * ② **断点语义**：记的是"最后成功落盘的章号"，能不能续跑由**状态与断点一起**决定；
 * ③ **记录读不懂就报错**：未知键 / 未知状态 / 未知校正动作一律拒——
 *    静默当成"没有任务"会让作者以为能重跑，其实续跑不了。
 */

const JOB: ImportJob = {
  apiVersion: IMPORT_JOB_API_VERSION,
  format_version: 1,
  id: "imp-0007",
  source: { name: "旧稿.txt", size_bytes: 5123456, sha256: "abc123", detected_encoding: "utf-8" },
  status: "pending",
  checkpoint: { last_chapter: 0, resumable: true },
  volume_id: "vol-abc",
  plan: {
    keeps: [0, 2],
    corrections: [
      { kind: "merge", at: 0 },
      { kind: "split", at: 1, line: 3, title: "第三章 承" },
      { kind: "move", from: 2, to: 0 },
    ],
  },
  chapters: [
    { outline_id: "co-1", chapter_id: "ch-1", path: "chapters/vol-abc/ch-1.md", title: "第一章 起", expected_chars: 1200 },
    { outline_id: "co-2", chapter_id: "ch-2", path: "chapters/vol-abc/ch-2.md", title: "第二章 承", expected_chars: 900 },
  ],
};

describe("导入任务记录：序列化与解析（I09 §5 的 schema 形状）", () => {
  it("往返不丢东西（续跑要靠这份记录重放同一份切分）", () => {
    expect(parseImportJob(serializeImportJob(JOB))).toEqual(JOB);
  });

  it("序列化是确定性的（同一份记录两次写出逐字相同，便于比对与去重）", () => {
    expect(serializeImportJob(JOB)).toBe(serializeImportJob(JOB));
  });

  it("源文件只留指纹，不留绝对路径（路径永远只从原生对话框来）", () => {
    const text = serializeImportJob(JOB);
    expect(text).not.toContain("D:");
    expect(text).not.toContain("D:/");
    expect(text).toContain("旧稿.txt");
  });

  it("未知键一律拒（读不懂的键名说明这份记录不是我们写的）", () => {
    const text = serializeImportJob(JOB).replace("id: imp-0007", "id: imp-0007\nmystery: 1");
    expect(() => parseImportJob(text)).toThrow(/未知键/);
  });

  it("未知状态拒（不静默当成 pending）", () => {
    const text = serializeImportJob(JOB).replace("status: pending", "status: whatever");
    expect(() => parseImportJob(text)).toThrow(/status 不认/);
  });

  it("未知的校正动作拒（续跑宁可报错也不要静默丢掉那一步）", () => {
    const text = serializeImportJob(JOB).replace("kind: merge", "kind: rename");
    expect(() => parseImportJob(text)).toThrow(/未知动作/);
  });

  it("坏 YAML 拒，不当没任务", () => {
    expect(() => parseImportJob(":\n  - [")).toThrow(/读不了/);
  });
});

describe("状态机：pending → running → needs_review → done/failed（I09 §3.1）", () => {
  it("五个状态都在，迁移表对每个状态都给了去处", () => {
    expect([...IMPORT_JOB_STATUSES].sort()).toEqual(["done", "failed", "needs_review", "pending", "running"]);
    for (const status of IMPORT_JOB_STATUSES) {
      expect(Array.isArray(IMPORT_JOB_TRANSITIONS[status])).toBe(true);
    }
  });

  it("主链走得通：pending → running → needs_review → running → done", () => {
    expect(canTransitionImportJob("pending", "running").ok).toBe(true);
    expect(canTransitionImportJob("running", "needs_review").ok).toBe(true);
    expect(canTransitionImportJob("needs_review", "running").ok).toBe(true);
    expect(canTransitionImportJob("running", "done").ok).toBe(true);
  });

  it("终态不能复活：done 走不到任何地方", () => {
    const result = canTransitionImportJob("done", "running");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("终态");
  });

  it("非法迁移给理由（界面要看得见，不能只说「不行」）", () => {
    const result = canTransitionImportJob("pending", "done");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pending");
    expect(result.reason).toContain("done");
  });

  it("走到自己不算迁移（别把「已经是这个状态」当成合法）", () => {
    expect(canTransitionImportJob("running", "running").ok).toBe(false);
  });
});

describe("断点：能不能续跑由状态与断点一起决定", () => {
  it("running + 可续 ⇒ 能续跑（进程在写盘途中没了，记录就停在 running）", () => {
    const job: ImportJob = { ...JOB, status: "running", checkpoint: { last_chapter: 12, resumable: true } };
    expect(isResumableImportJob(job)).toBe(true);
  });

  it("needs_review + 可续 ⇒ 能续跑（作者主动停下的）", () => {
    const job: ImportJob = { ...JOB, status: "needs_review", checkpoint: { last_chapter: 12, resumable: true } };
    expect(isResumableImportJob(job)).toBe(true);
  });

  it("断点自己说不可续 ⇒ 不能续（哪怕状态允许）", () => {
    const job: ImportJob = { ...JOB, status: "needs_review", checkpoint: { last_chapter: 12, resumable: false } };
    expect(isResumableImportJob(job)).toBe(false);
  });

  it("done / failed 之后不能从断点续（done 是终态，failed 要显式重开）", () => {
    expect(isResumableImportJob({ ...JOB, status: "done" })).toBe(false);
    expect(isResumableImportJob({ ...JOB, status: "failed" })).toBe(false);
  });

  it("断点记的是最后成功落盘的章号（半章不算——草稿要么完整要么不存在）", () => {
    const job: ImportJob = { ...JOB, status: "running", checkpoint: { last_chapter: 12, resumable: true } };
    expect(job.checkpoint.last_chapter).toBe(12);
    expect(parseImportJob(serializeImportJob(job)).checkpoint.last_chapter).toBe(12);
  });
});

describe("校正动作的种类表（两边各有一份，由桌面侧的锁盯着一致）", () => {
  it("本包这一份是三种（与 @yushu/text 的那份逐字一致才算数）", () => {
    expect([...IMPORT_JOB_CORRECTION_KINDS]).toEqual(["merge", "split", "move"]);
  });
});
