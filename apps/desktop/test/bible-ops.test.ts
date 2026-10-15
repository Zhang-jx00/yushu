/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewBible, runBibleExport } from "../src/main/bible-ops.js";
import { createProject, writeCardDoc } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  WORLD_CONFIG_PATH,
  parseWorldConfig,
  serializeWorldConfig,
} from "@yushu/world-engine";

/**
 * 世界圣经（设定集）一键导出的桌面侧（M5 / T5-5，R98）。
 *
 * 编排本身是纯函数（`@yushu/export/bible.ts`），这里要验的是**它接上了真项目**：
 * 卡从 `world/cards/*.md` 读、正文进引擎、产物落 `exports/`，
 * 并且三条宿主级的规矩成立——
 * ① 坏卡**不静默丢掉**：它进 `unreadable` 点名（同 R94 的坏派系包），其余照常编；
 * ② 落笔前拒：没确认、或编不出任何条目（空设定集），项目里不许出现半成品；
 * ③ warn 不阻断：K11 把可见性外泄定级为 warn，所以照样导出，但回执与面板都要报数——
 *    "安静地导出了一份会剧透的设定集"是最坏的结果。
 */

let dir: string;
let gateway: ProjectGateway;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-bible-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function addCard(input: {
  id: string;
  type: string;
  name: string;
  layer: string;
  visibility: string;
  body: string;
  aliases?: string[];
}): Promise<string> {
  const result = await writeCardDoc(gateway, {
    card: {
      id: input.id,
      type: input.type,
      name: input.name,
      layer: input.layer,
      visibility: input.visibility,
      ...(input.aliases ? { aliases: input.aliases } : {}),
    },
    body: input.body,
  });
  return result.path;
}

/**
 * 关掉某一层：直接改 world.yaml（应用里目前没有层级开关通道，
 * 这正是作者手改文件 / 换流派预设的等价动作，主进程读到的就是这个形状）。
 */
async function closeLayer(target: ProjectGateway, key: string): Promise<void> {
  const snap = await target.readDoc(WORLD_CONFIG_PATH);
  const world = parseWorldConfig(snap.content);
  await target.writeDoc(
    WORLD_CONFIG_PATH,
    serializeWorldConfig({
      ...world,
      layers: { ...world.layers, [key]: false } as typeof world.layers,
    }),
    // 覆盖写必须带 baseHash：闸门对"盲写已存在文件"一律拒，这是它的正确行为，不是要绕的坑
    snap.hash,
  );
}

describe("设定集预览：从真项目的设定卡读出来", () => {
  it("两张卡 ⇒ 按层级编排、书名进标题、隐藏设定报一条 warn", async () => {
    await addCard({
      id: "law-tianqi",
      type: "law",
      name: "灵脉法则",
      layer: "laws",
      visibility: "revealed",
      body: "灵气依脉而行，夺脉者承其代价。",
    });
    await addCard({
      id: "char-secret",
      type: "character",
      name: "林渊身世",
      layer: "characters",
      visibility: "hidden",
      body: "他是天柱折断时最后一缕灵光。",
      aliases: ["小渊"],
    });
    const preview = await previewBible(gateway, {});
    expect(preview.error).toBeNull();
    expect(preview.cardTotal).toBe(2);
    expect(preview.unreadable).toEqual([]);
    expect(preview.title).toBe("天启界 设定集");
    expect(preview.sections.map((section) => section.layer)).toEqual(["laws", "characters"]);
    expect(preview.sections[1]?.entries[0]?.name).toBe("林渊身世");
    // 面板里的标题就是产物第一行（两处各写一份，作者就会照一句假话核对）
    expect(preview.markdown.split("\n")[0]).toBe("# 天启界 设定集");
    expect(preview.findings.map((row) => [row.rule, row.severity])).toEqual([
      ["export-bible-visibility-leak", "warn"],
    ]);
    expect(preview.findings[0]?.related).toContain("char-secret");
  });

  it("层级清单给出每层卡数与世界配置里的开关（关掉且没卡的层不占位）", async () => {
    await addCard({
      id: "char-a",
      type: "character",
      name: "林渊",
      layer: "characters",
      visibility: "revealed",
      body: "外门弟子。",
    });
    const preview = await previewBible(gateway, {});
    const characters = preview.layers.find((row) => row.key === "characters");
    expect(characters).toMatchObject({ title: "人物", cards: 1, enabled: true });
    expect(preview.layers.find((row) => row.key === "ecology")).toMatchObject({ cards: 0 });
    expect(preview.layers.map((row) => row.title).every((title) => title !== "")).toBe(true);
  });

  it("勾选脱敏 ⇒ 未揭示条目整条不进产物，剔除清单回给面板", async () => {
    await addCard({
      id: "char-secret",
      type: "character",
      name: "林渊身世",
      layer: "characters",
      visibility: "hidden",
      body: "天柱最后一缕灵光。",
    });
    await addCard({
      id: "char-open",
      type: "character",
      name: "青云宗",
      layer: "factions",
      visibility: "revealed",
      body: "东荒大宗。",
    });
    const masked = await previewBible(gateway, { maskUnrevealed: true });
    expect(masked.included).toBe(1);
    expect(masked.masked.map((entry) => entry.id)).toEqual(["char-secret"]);
    expect(masked.markdown).not.toContain("林渊身世");
    expect(masked.findings).toEqual([]);
    const unmasked = await previewBible(gateway, {});
    expect(unmasked.included).toBe(2);
    expect(unmasked.masked).toEqual([]);
  });

  it("只选取部分层级 ⇒ 其余层计入 excludedByLayer，不当成「卡不见了」", async () => {
    await addCard({
      id: "law-a",
      type: "law",
      name: "灵脉法则",
      layer: "laws",
      visibility: "revealed",
      body: "法则一。",
    });
    await addCard({
      id: "char-a",
      type: "character",
      name: "林渊",
      layer: "characters",
      visibility: "revealed",
      body: "外门弟子。",
    });
    const preview = await previewBible(gateway, { layers: ["characters"] });
    expect(preview.included).toBe(1);
    expect(preview.excludedByLayer).toBe(1);
    expect(preview.sections.map((section) => section.layer)).toEqual(["characters"]);
  });

  it("坏卡不静默丢掉：进 unreadable 点名，其余照常编（同 R94 坏派系包口径）", async () => {
    await addCard({
      id: "char-a",
      type: "character",
      name: "林渊",
      layer: "characters",
      visibility: "revealed",
      body: "外门弟子。",
    });
    // 直接写一张不合法的卡文件（绕过 writeCardDoc 的校验，模拟手改 / 外部导入）
    await gateway.writeDoc("world/cards/broken.md", "---\nid: 12\n---\n\n正文。\n");
    const preview = await previewBible(gateway, {});
    expect(preview.cardTotal).toBe(2);
    expect(preview.unreadable).toHaveLength(1);
    expect(preview.unreadable[0]?.path).toBe("world/cards/broken.md");
    expect(preview.included).toBe(1);
    expect(preview.sections.map((section) => section.entries.length)).toEqual([1]);
    // 落盘那条路也必须把"少了一张"带进回执，不然作者拿到的是半本却以为拿到了整本
    const result = await runBibleExport(gateway, { confirmed: true });
    expect(result.unreadableCount).toBe(1);
    expect(result.included).toBe(1);
  });

  it("世界关掉某一层 ⇒ 该层的卡默认不进设定集，但清单里看得见并计数", async () => {
    await addCard({
      id: "spe-linghe",
      type: "species",
      name: "灵鹤",
      layer: "ecology",
      visibility: "revealed",
      body: "栖于灵脉之上。",
    });
    await closeLayer(gateway, "ecology");
    const preview = await previewBible(gateway, {});
    expect(preview.layers.find((row) => row.key === "ecology")).toMatchObject({ cards: 1, enabled: false });
    expect(preview.included).toBe(0);
    expect(preview.excludedByLayer).toBe(1);
    // 显式选中它就该进——关掉层级是"默认不编"，不是"不许编"
    const forced = await previewBible(gateway, { layers: ["ecology"] });
    expect(forced.included).toBe(1);
  });
});

describe("设定集落盘：先拒后写，warn 不阻断", () => {
  beforeEach(async () => {
    await addCard({
      id: "char-open",
      type: "character",
      name: "林渊",
      layer: "characters",
      visibility: "revealed",
      body: "青云宗外门弟子。",
    });
    await addCard({
      id: "char-secret",
      type: "character",
      name: "林渊身世",
      layer: "characters",
      visibility: "hidden",
      body: "天柱最后一缕灵光。",
    });
  });

  it("没确认 ⇒ 拒；不落笔", async () => {
    await expect(runBibleExport(gateway, {})).rejects.toThrow(/E_CONFIRM_REQUIRED|显式确认/);
    const tree = await gateway.listTree();
    expect(tree.filter((entry) => entry.path.startsWith("exports/"))).toEqual([]);
  });

  it("未勾选脱敏 ⇒ 照样产出（K11 定级 warn），但回执报出剧透条数", async () => {
    const result = await runBibleExport(gateway, { confirmed: true });
    expect(result.included).toBe(2);
    expect(result.leakCount).toBe(1);
    expect(result.maskedCount).toBe(0);
    expect(result.path.startsWith("exports/")).toBe(true);
    expect(result.path.endsWith(".md")).toBe(true);
    const snap = await gateway.readDoc(result.path);
    expect(snap.content).toContain("林渊身世");
    expect(snap.content).toContain("青云宗外门弟子");
  });

  it("勾选脱敏 ⇒ 产物里没有隐藏设定，回执点名略过 1 条", async () => {
    const result = await runBibleExport(gateway, { confirmed: true, maskUnrevealed: true });
    expect(result.maskedCount).toBe(1);
    expect(result.included).toBe(1);
    const snap = await gateway.readDoc(result.path);
    expect(snap.content).not.toContain("林渊身世");
    expect(snap.content).toContain("青云宗外门弟子");
  });

  it("重名不覆盖：第二次导出换名落盘（freeExportBase 的口径）", async () => {
    const first = await runBibleExport(gateway, { confirmed: true });
    const second = await runBibleExport(gateway, { confirmed: true });
    expect(second.path).not.toBe(first.path);
  });

  it("一张卡都没有 ⇒ 落笔前拒，项目里不留空设定集", async () => {
    const empty = new ProjectGateway(dir);
    const cardFiles = (await empty.listTree()).filter(
      (item) => item.type === "file" && item.path.startsWith("world/cards/") && item.path.endsWith(".md"),
    );
    expect(cardFiles.length).toBeGreaterThan(0);
    for (const entry of cardFiles) {
      await rm(join(dir, entry.path), { force: true });
    }
    await expect(runBibleExport(empty, { confirmed: true })).rejects.toThrow(/E_BIBLE_EMPTY|没有可编入设定集/);
    const tree = await empty.listTree();
    expect(tree.filter((entry) => entry.path.startsWith("exports/"))).toEqual([]);
  });

  it("面板与产物同源：预览的条目名逐条出现在落盘文件里", async () => {
    const preview = await previewBible(gateway, {});
    const result = await runBibleExport(gateway, { confirmed: true });
    const snap = await gateway.readDoc(result.path);
    for (const section of preview.sections) {
      for (const entry of section.entries) {
        expect(snap.content).toContain(entry.name);
      }
    }
    expect(result.wordCount).toBe(preview.wordCount);
  });
});
