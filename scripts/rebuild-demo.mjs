/* SPDX-License-Identifier: Apache-2.0 */
/**
 * R192 数据主权演示（docs/04 §11.6 第三条门槛的后半：cli rebuild 删索引重建演示）。
 * 仓库维护脚本，不进产品运行时。用引擎自带序列化器造一个合法最小项目，
 * 跑真实 CLI：重建 → 检索 → 删 .yushu/index.db → 再重建 → 再检索，断言前后逐字一致。
 * 运行：node .tmp/r192-rebuild-demo.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createSettingCard,
  serializeCardFile,
  createChapterDraft,
  serializeChapterFile,
  cardPath,
  chapterPath,
} from "../packages/@yushu/world-engine/dist/index.js";

const ROOT = resolve(".");
const CLI = join(ROOT, "apps", "cli", "dist", "cli.js");
const PROJ = join(ROOT, ".tmp", "r192-rebuild-demo-project");

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }).trim();
}
function writeRel(rel, text) {
  const abs = join(PROJ, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

// 1) 造合法最小项目：3 张设定卡 + 1 章正文（索引收集器读 world/cards 与 chapters）
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(PROJ, { recursive: true });
const cards = [
  createSettingCard({ type: "character", name: "林渊", layer: "characters", aliases: ["小林"] }),
  createSettingCard({ type: "location", name: "落霞峰", layer: "geography" }),
  createSettingCard({ type: "item", name: "玄铁令", layer: "factions" }),
];
for (const c of cards) writeRel(cardPath(c.type, c.id), serializeCardFile(c, `${c.name}的设定正文。`));
const ch = createChapterDraft({ volume: "vol-1", idx: 1, title: "第一章 夜色", outlineRef: "outline-ch-1" });
writeRel(chapterPath("vol-1", ch.id), serializeChapterFile(ch, "夜色笼罩落霞峰，林渊握紧了玄铁令。"));

// 2) 第一次重建 + 检索
const rebuild1 = JSON.parse(cli("rebuild", PROJ));
const searchEntity1 = cli("search", PROJ, "林渊");
const searchFull1 = cli("search", PROJ, "夜色");
const status1 = JSON.parse(cli("status", PROJ));

// 3) 删索引库（数据主权：索引是派生物，删了不丢真源）
const dbPath = join(PROJ, ".yushu", "index.db");
rmSync(dbPath, { force: true });
const dbGone = !existsSync(dbPath);

// 4) 再重建 + 再检索
const rebuild2 = JSON.parse(cli("rebuild", PROJ));
const searchEntity2 = cli("search", PROJ, "林渊");
const searchFull2 = cli("search", PROJ, "夜色");

// 5) 对账：前后检索结果逐字一致 + 统计一致
const entitySame = searchEntity1 === searchEntity2;
const fullSame = searchFull1 === searchFull2;
const statsSame =
  rebuild1.stats.files === rebuild2.stats.files &&
  rebuild1.stats.chunks === rebuild2.stats.chunks &&
  rebuild1.stats.entities === rebuild2.stats.entities;
const ok = dbGone && entitySame && fullSame && statsSame && rebuild1.skipped.length === 0;

const receipt = {
  demo: "cli rebuild 删索引重建（数据主权零丢失）",
  project: PROJ,
  cards: cards.length,
  chapters: 1,
  rebuild1: { files: rebuild1.stats.files, chunks: rebuild1.stats.chunks, entities: rebuild1.stats.entities, skipped: rebuild1.skipped.length },
  indexDbDeleted: dbGone,
  rebuild2: { files: rebuild2.stats.files, chunks: rebuild2.stats.chunks, entities: rebuild2.stats.entities },
  entitySearchIdentical: entitySame,
  fullTextSearchIdentical: fullSame,
  statsIdentical: statsSame,
  entityHit: JSON.parse(searchEntity1).entities.length,
  fullTextHit: JSON.parse(searchFull1).chunks.length,
  ok,
};
const out = JSON.stringify(receipt, null, 2);
console.log(out);
writeFileSync(join(ROOT, ".tmp", "r192-rebuild-demo-receipt.json"), out + "\n", "utf8");
process.exit(ok ? 0 : 1);