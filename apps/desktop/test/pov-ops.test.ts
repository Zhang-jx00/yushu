/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError, countWords } from "@yushu/core";
import {
  OUTLINE_PATH,
  POV_CHECK_ORIGIN,
  POV_CONFIG_PATH,
  POV_RULE_IDS,
  parseOutline,
  readChapterFile,
  serializePovConfig,
} from "@yushu/world-engine";
import { povReportFindings, previewPov, setChapterPov, writePovConfig, POV_UNREADABLE_RULE } from "../src/main/pov-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 视角看板的主进程侧（M4 / T4-2 第三批，R102）。
 *
 * 判据在引擎（`pov-config.ts` / `pov-check.ts`，出处 F04 §3.1/§3.2/§3.6），这里只验**接上真项目**后
 * 那三件宿主级的事：
 * ① **写入点真的存在**：章 frontmatter 的 `pov` 能被改（正文与字数一字不动），改完之后结论随之消失——
 *    此前 `pov` 是模型里有、界面上无处可填的死字段（docs/09 第 140 行记的就是这笔账）；
 * ② **策略文件读不了 ≠ 没问题**：坏 YAML 时本轮一条结论都不发，且 `state` 如实写 unreadable；
 * ③ **一切写入带 baseHash**：外部改过就拒，且不落半成品。
 *
 * 与 R98/R101 同一口径：路径不出主进程、结论只讲事实不讲"已修复"。
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
  dir = await mkdtemp(join(tmpdir(), "yushu-pov-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => "NO_THROW",
    (err: unknown) => (err instanceof YushuError ? err.code : `NOT_YUSHU:${String(err)}`),
  );
}

async function addCharacter(id: string, name: string): Promise<string> {
  const written = await writeCardDoc(gateway, {
    card: { id, type: "character", name, layer: "characters" },
    body: `## ${name}\n`,
  });
  return written.path;
}

/** 大纲里前 count 个章纲条目（id 由模板生成，测试里不猜形状：从磁盘读回来） */
async function outlineTargets(count: number): Promise<Array<{ volumeId: string; chapterId: string }>> {
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const rows: Array<{ volumeId: string; chapterId: string }> = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) rows.push({ volumeId: volume.id, chapterId: chapter.id });
  }
  return rows.slice(0, count);
}

/**
 * 建 N 章草稿。逐章重取大纲 baseHash：`createOutlineChapter` 会回填 chapter_id 改写大纲，
 * 拿第一次的 hash 去建第二章必然冲突（这不是被测代码的问题，是夹具必须跟上自己的写入）。
 */
async function draft(count: number): Promise<string[]> {
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 3,
  });
  const targets = await outlineTargets(count);
  const paths: string[] = [];
  for (const target of targets) {
    const snap = await gateway.readDoc(OUTLINE_PATH);
    const created = await createOutlineChapter(gateway, {
      volumeId: target.volumeId,
      chapterId: target.chapterId,
      baseHash: snap.hash,
    });
    paths.push(created.chapterPath);
  }
  return paths;
}

const LIMITED = serializePovConfig({ mode: "third_limited", allowed_povs: ["char-linyuan"] });

/** 单章夹具：把 `paths[0]` 的可能 undefined 收在一处，测试体里就不用到处写非空断言 */
async function draftOne(): Promise<string> {
  const first = (await draft(1))[0];
  if (first === undefined) throw new Error("夹具没能建出章节草稿");
  return first;
}

describe("视角预览：没声明就不判，声明了才逐章核", () => {
  it("还没写 config/pov.yaml ⇒ state=undeclared，只有一条 info 总述，绝不逐章发警告", async () => {
    await addCharacter("char-linyuan", "林渊");
    await draft(2);
    const view = await previewPov(gateway);
    expect(view.configPath).toBe(POV_CONFIG_PATH);
    expect(view.state).toBe("undeclared");
    expect(view.configText).toBe("");
    expect(view.configHash).toBeNull();
    expect(view.findings.map((row) => [row.rule, row.severity])).toEqual([["pov-policy-undeclared", "info"]]);
  });

  it("策略落盘后：缺视角的章逐章被点名，结论主体就是章 id", async () => {
    await addCharacter("char-linyuan", "林渊");
    const paths = await draft(2);
    await writePovConfig(gateway, { content: LIMITED, baseHash: null });
    const view = await previewPov(gateway);
    expect(view.state).toBe("declared");
    expect(view.mode).toBe("third_limited");
    expect(view.allowedPovs).toEqual(["char-linyuan"]);

    const missing = view.findings.filter((row) => row.rule === "pov-missing");
    expect(missing).toHaveLength(2);
    const draftedIds = view.chapters.filter((row) => row.drafted).map((row) => row.chapterId);
    expect(new Set(draftedIds)).toEqual(new Set(missing.map((row) => row.subject)));
    // 章路径来自磁盘而非夹具：两边必须对得上
    expect(view.chapters.filter((row) => row.drafted).map((row) => row.path).sort()).toEqual([...paths].sort());
  });

  it("策略读不了 ⇒ 本轮一条结论都不发，state 如实写 unreadable（零结论不等于没问题）", async () => {
    await addCharacter("char-linyuan", "林渊");
    await draft(1);
    await gateway.writeDoc(POV_CONFIG_PATH, "mode: 全知\npolicy: loose\n");
    const view = await previewPov(gateway);
    expect(view.state).toBe("unreadable");
    expect(view.findings).toEqual([]);
    expect(view.configError).not.toBeNull();
    expect(view.configError).toContain("mode");
    expect(view.configHash).not.toBeNull();
  });

  it("未建草稿的大纲条目不参与视角核对，但计数里要点名（免得被读成「全书都没问题」）", async () => {
    await addCharacter("char-linyuan", "林渊");
    await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 1,
      chaptersPerVolume: 3,
    });
    await writePovConfig(gateway, { content: LIMITED, baseHash: null });
    const view = await previewPov(gateway);
    expect(view.counted.outlineChapters).toBe(3);
    expect(view.counted.drafted).toBe(0);
    expect(view.counted.notDrafted).toBe(3);
    expect(view.findings).toEqual([]);
  });

  it("角色清单只认角色卡（别的层不进下拉）", async () => {
    await addCharacter("char-linyuan", "林渊");
    await writeCardDoc(gateway, {
      card: { id: "loc-001", type: "location", name: "边城", layer: "geography" },
      body: "## 边城\n",
    });
    const view = await previewPov(gateway);
    expect(view.characters.map((row) => row.id)).toEqual(["char-linyuan"]);
  });
});

describe("视角写入点：frontmatter 能改，且只改 frontmatter", () => {
  it("给一章绑上视角 ⇒ 那条 pov-missing 消失（写入点不是摆设）", async () => {
    await addCharacter("char-linyuan", "林渊");
    const path = await draftOne();
    await writePovConfig(gateway, { content: LIMITED, baseHash: null });
    const before = await previewPov(gateway);
    expect(before.findings.map((row) => row.rule)).toContain("pov-missing");

    const snap = await gateway.readDoc(path);
    await setChapterPov(gateway, { path, pov: "char-linyuan", baseHash: snap.hash });
    const after = await previewPov(gateway);
    expect(after.findings).toEqual([]);
    expect(after.chapters[0]?.pov).toBe("char-linyuan");
  });

  it("绑定视角只动 frontmatter：正文一字不改、记录字数不变", async () => {
    await addCharacter("char-linyuan", "林渊");
    const path = await draftOne();
    const before = await gateway.readDoc(path);
    const parsed = readChapterFile(before.content);

    await setChapterPov(gateway, { path, pov: "char-linyuan", baseHash: before.hash });
    const after = readChapterFile((await gateway.readDoc(path)).content);
    expect(after.body).toBe(parsed.body);
    expect(after.chapter.word_count).toBe(parsed.chapter.word_count);
    expect(after.chapter.title).toBe(parsed.chapter.title);
    expect(after.chapter.pov).toBe("char-linyuan");
    expect(countWords(after.body)).toBe(countWords(parsed.body));
  });

  it("清空视角（pov 传空串）是合法动作：回到「本章未声明视角」而不是报错", async () => {
    await addCharacter("char-linyuan", "林渊");
    const path = await draftOne();
    await setChapterPov(gateway, {
      path,
      pov: "char-linyuan",
      baseHash: (await gateway.readDoc(path)).hash,
    });
    const written = await gateway.readDoc(path);
    await setChapterPov(gateway, { path, pov: "", baseHash: written.hash });
    expect(readChapterFile((await gateway.readDoc(path)).content).chapter.pov).toBe("");
  });

  it("baseHash 过期 ⇒ E_DOC_CONFLICT 且盘上一个字节没动", async () => {
    await addCharacter("char-linyuan", "林渊");
    const path = await draftOne();
    const original = await gateway.readDoc(path);
    const fresh = await gateway.writeDoc(path, `${original.content}\n外部追加\n`, original.hash);
    const bytes = (await gateway.readDoc(path)).content;
    expect(await codeOf(() => setChapterPov(gateway, { path, pov: "char-linyuan", baseHash: original.hash }))).toBe(
      "E_DOC_CONFLICT",
    );
    expect((await gateway.readDoc(path)).content).toBe(bytes);
    expect(fresh.hash).not.toBe(original.hash);
  });

  it("视角只能绑项目里存在的角色：写一个查无此人的 id ⇒ E_POV_CHARACTER，且不落盘", async () => {
    await addCharacter("char-linyuan", "林渊");
    const path = await draftOne();
    const snap = await gateway.readDoc(path);
    expect(await codeOf(() => setChapterPov(gateway, { path, pov: "char-ghost", baseHash: snap.hash }))).toBe(
      "E_POV_CHARACTER",
    );
    expect((await gateway.readDoc(path)).hash).toBe(snap.hash);
  });

  it("这条写入只服务章节文件：设定卡一律拒", async () => {
    const cardPath = await addCharacter("char-linyuan", "林渊");
    const snap = await gateway.readDoc(cardPath);
    expect(await codeOf(() => setChapterPov(gateway, { path: cardPath, pov: "char-linyuan", baseHash: snap.hash }))).toBe(
      "E_POV_TARGET",
    );
    expect((await gateway.readDoc(cardPath)).hash).toBe(snap.hash);
  });
});

describe("并进「全书体检」的那一份投影（R102）", () => {
  it("没声明 ⇒ 体检表不加这行 info（那是看板的活），但看板必须把它说出来", async () => {
    await addCharacter("char-linyuan", "林渊");
    await draft(2);
    // 体检表的既有口径：info 行 = "有数据且数据里有缺口"，不是"某功能未配置"。
    // 给每个没配视角的项目常驻一行未配置，教会作者的还是忽略红色。
    expect(await povReportFindings(gateway)).toEqual([]);
    const board = await previewPov(gateway);
    expect(board.findings.map((row) => [row.rule, row.severity])).toEqual([["pov-policy-undeclared", "info"]]);
    expect(board.findings[0]?.origin).toBe(POV_CHECK_ORIGIN);
  });

  it("策略读不了 ⇒ 进表的是那条 unreadable 警告（静默零结论等于用假绿灯骗作者）", async () => {
    await draft(1);
    await gateway.writeDoc(POV_CONFIG_PATH, "mode: 全知\n");
    const rows = await povReportFindings(gateway);
    expect(rows.map((row) => row.rule)).toEqual([POV_UNREADABLE_RULE]);
    expect(rows[0]?.severity).toBe("warn");
    expect(rows[0]?.subject).toBe(POV_CONFIG_PATH);
    expect(rows[0]?.evidence).toContain("mode");
    // 这条 id 是桌面侧的（引擎只吃解析好的对象），所以它**不该**在引擎那五条里
    expect(POV_RULE_IDS).not.toContain(POV_UNREADABLE_RULE);
  });

  it("策略合法 ⇒ 逐章结论进表，每条都带证据与修法（体检表按这两列渲染）", async () => {
    await addCharacter("char-linyuan", "林渊");
    await draft(2);
    await writePovConfig(gateway, { content: LIMITED, baseHash: null });
    const rows = await povReportFindings(gateway);
    expect(rows.map((row) => row.rule)).toEqual(["pov-missing", "pov-missing"]);
    for (const row of rows) {
      expect(row.evidence.length).toBeGreaterThan(8);
      // 并进体检表时 fix 必须真的带上（ReportFinding 里它是可选字段，面板按这一列给修法）
      expect((row.fix ?? "").length).toBeGreaterThan(8);
      expect(row.origin).toBe(POV_CHECK_ORIGIN);
    }
  });
});

describe("策略文件的写入：先解析后落盘", () => {
  it("解析不过就不许落盘：坏 YAML 拒写，原内容原样保留", async () => {
    await writePovConfig(gateway, { content: LIMITED, baseHash: null });
    const snap = await gateway.readDoc(POV_CONFIG_PATH);
    expect(await codeOf(() => writePovConfig(gateway, { content: "mode: 全知\n", baseHash: snap.hash }))).toBe(
      "E_POV_CONFIG",
    );
    expect((await gateway.readDoc(POV_CONFIG_PATH)).content).toBe(snap.content);
  });

  it("文件已被外部改过 ⇒ 带旧 baseHash 的保存被拒（不许盲写）", async () => {
    await writePovConfig(gateway, { content: serializePovConfig({ mode: "third_limited" }), baseHash: null });
    const stale = (await gateway.readDoc(POV_CONFIG_PATH)).hash;
    await gateway.writeDoc(POV_CONFIG_PATH, "mode: first\n", stale);
    expect(await codeOf(() => writePovConfig(gateway, { content: "mode: second\n", baseHash: stale }))).toBe(
      "E_DOC_CONFLICT",
    );
  });

  it("清空策略文件 = 撤销声明（回到 undeclared，不是「空配置」）", async () => {
    await writePovConfig(gateway, { content: serializePovConfig({ mode: "third_limited" }), baseHash: null });
    const snap = await gateway.readDoc(POV_CONFIG_PATH);
    await writePovConfig(gateway, { content: "", baseHash: snap.hash });
    const view = await previewPov(gateway);
    expect(view.state).toBe("undeclared");
    expect(view.mode).toBe("");
  });
});
