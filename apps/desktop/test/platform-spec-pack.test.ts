/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_SPEC_FIELDS } from "@yushu/export";
import {
  scanPlatformPacks,
  scanPlatformSpecs,
  loadPlatformSpec,
} from "../src/main/platform-ops.js";

/**
 * 仓库里那份**平台规则包**的判据（M5 / T5-8，R177）。
 *
 * 引擎侧的判据（`platform-spec.test.ts`）盯的是"一份 YAML 怎么算合规"；
 * 这一组盯的是**仓里真的那几个包**：
 * ① 七猫包在（平台规则包首轮填充的第一片）；
 * ② **包里的每一条规则都能指回来源**（source 里有可核 URL，且 URL 在本包登记过）；
 * ③ 每条规则的字段键 / 口径名 / 单位与口径登记表一致（不许私造口径）；
 * ④ 坏包（缺出处）**进不了包**——它进清单，但带 parseError，作者看得见。
 *
 * 判定刻意不认"文件里有这个词"：一律回到解析器给出的结构上核对，
 * 免得注释里写一句"来源：xxx"就把判据喂饱了。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PACKS = join(ROOT, "packs", "platforms");

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempPackRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yushu-spec-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const dir = join(root, ...rel.split("/").slice(0, -1));
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, ...rel.split("/")), content, "utf8");
  }
  return root;
}

describe("仓里的平台规则包（R177）", () => {
  it("七猫包在（第一片平台规则包）", async () => {
    const specs = await scanPlatformSpecs(PACKS);
    const qimao = specs.find((item) => item.packId === "qimao");
    expect(qimao, "packs/platforms/qimao/platform-spec.yaml 不在（第一片规则包没建）").toBeTruthy();
    expect(qimao!.error, `七猫规则包读不动：${qimao!.error}`).toBeNull();
    expect(qimao!.spec!.platform).toBe("qimao");
    expect(qimao!.spec!.rules.length, "七猫规则包一条规则都没有").toBeGreaterThan(0);
  });

  it("**包里的每一条规则都能指回来源**（source 含可核 URL，且 URL 在本包登记过）", async () => {
    const specs = await scanPlatformSpecs(PACKS);
    for (const item of specs) {
      if (item.spec === null) continue;
      for (const rule of item.spec.rules) {
        expect(rule.source, `${item.packId} 的规则「${rule.id}」没有出处`).toMatch(/https?:\/\//);
        const url = /https?:\/\/[^\s，。；、）】"'<>]+/.exec(rule.source)?.[0] ?? "";
        expect(
          item.spec.source_urls,
          `${item.packId} 的规则「${rule.id}」的出处链接没在本包登记过：${url}`,
        ).toContain(url);
      }
    }
  });

  it("每条规则的字段键 / 口径名 / 单位与口径登记表一致（不许私造口径）", async () => {
    const specs = await scanPlatformSpecs(PACKS);
    for (const item of specs) {
      if (item.spec === null) continue;
      for (const rule of item.spec.rules) {
        const shape = PLATFORM_SPEC_FIELDS[rule.field];
        expect(shape, `${item.packId} 的规则「${rule.id}」用了没登记的字段键`).toBeTruthy();
        const pair = shape!.meanings.find((candidate) => candidate.meaning === rule.meaning);
        expect(pair, `${item.packId} 的规则「${rule.id}」的口径名不在登记表里`).toBeTruthy();
        expect(rule.unit, `${item.packId} 的规则「${rule.id}」的单位与口径名对不上`).toBe(pair!.unit);
        expect(rule.kind, `${item.packId} 的规则「${rule.id}」的类与字段不符`).toBe(shape!.kind);
      }
    }
  });

  it("规则包的核对日期是合法日历日（不许写“大概哪天”）", async () => {
    const specs = await scanPlatformSpecs(PACKS);
    for (const item of specs) {
      if (item.spec === null) continue;
      expect(item.spec.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.spec.effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("缺出处的包**进不了包**（它进清单，但带 parseError，作者看得见）", async () => {
    const root = await tempPackRoot({
      "nosource/platform-spec.yaml": `platform: nosource
version: "1.0.0"
effective_date: 2025-02-01
checked_at: 2026-10-25
source_urls:
  - https://example.com/rule
rules:
  - id: nosource.daily-words.floor
    field: daily-words.floor
    title: 每日更新字数下限
    value: 4000
    unit: 字/日
    meaning: 每日更新字数下限（全勤奖口径）
    effective_from: 2025-02-01
`,
    });
    const specs = await scanPlatformSpecs(root);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.spec).toBeNull();
    expect(specs[0]!.error, "坏包没给出原因").toContain("缺出处字段 source");
    await expect(loadPlatformSpec("nosource", root)).rejects.toThrowError(/缺出处字段 source/);
  });

  it("平台导出包与规则包各在各位（三种文件各管各的）", async () => {
    const exports = await scanPlatformPacks(PACKS);
    const specs = await scanPlatformSpecs(PACKS);
    const exportIds = exports.map((item) => item.id);
    const specIds = specs.map((item) => item.packId);
    expect(exportIds, "七猫的导出格式包不在（导出页选不到它）").toContain("qimao");
    expect(specIds, "七猫的规则包不在").toContain("qimao");
    // 番茄那条线只有导出包与发布口径包，没有规则包（本轮不替它编）
    expect(exportIds).toContain("fanqie");
  });
});
