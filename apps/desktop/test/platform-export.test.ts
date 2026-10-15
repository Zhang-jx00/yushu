/* SPDX-License-Identifier: Apache-2.0 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { previewExport, runExport } from "../src/main/export-ops.js";
import { scanPlatformPacks } from "../src/main/platform-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 平台导出包接进导出（M5 / T5-4 第四段·K11 第二段，R94）。
 *
 * R93 交的是**零消费者**的纯函数：参数能从包读、代码不硬编码，但导出预览与执行
 * 一条都没调它。本轮给它接上消费者，把 K11 落到能看见的地方——作者选一个平台，
 * 就能看到套上平台格式后每一章的章头长什么样、哪里不对，
 * 以及导出的 TXT / EPUB 里真的按那个格式写出去了。
 *
 * 顺带查出并结掉一个真缺陷：**跨卷导出时章号会在每一卷重新开始**
 * （大纲的 `idx` 是卷内序号，卷二第一章又被写成"第1章"）。
 */

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-platform-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 两卷各 2 章纲；只给**卷二第一章**建草稿并写正文（未建草稿的章也要占全书序号） */
async function secondVolumeDraftProject(): Promise<ProjectGateway> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 2,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[1]!;
  const target = volume.chapters[0]!;
  await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: target.id,
    baseHash: generated.hash,
  });
  await adoptDraft(gateway, {
    usageId: "test-usage",
    volumeId: volume.id,
    chapterId: target.id,
    text: "卷二开篇的一段正文。",
    mode: "replace",
  });
  return gateway;
}

/** 临时平台包根目录：坏包与自定义包只能这么喂给测试（生产默认读仓库 packs/platforms/） */
async function packRoot(yamlById: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yushu-platforms-"));
  for (const [id, yaml] of Object.entries(yamlById)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, "platform-export.yaml"), yaml, "utf8");
  }
  return root;
}

const MINIMAL_PACK = [
  "platform: testplat",
  "version: 1.0.0",
  "effective_date: 2026-01-01",
  "checked_at: 2026-09-29",
  "source_urls:",
  "  - https://example.com/rules",
  "chapter_title_format: 第{index}章 {title}",
].join("\n");

describe("平台包扫描（参数一律来自包）", () => {
  it("仓库里的番茄包能被列出，摘要字段逐个等于包里的值", async () => {
    const packs = await scanPlatformPacks();
    const fanqie = packs.find((item) => item.id === "fanqie");
    expect(fanqie).toBeDefined();
    // 断言"等于包里的值"而不是等于某个写死的字符串：代码里不许有平台参数
    const packText = await readFile(join(fanqie!.root, "platform-export.yaml"), "utf8");
    expect(packText).toContain(fanqie?.chapterTitleFormat ?? "@@never@@");
    expect(fanqie?.chapterTitleFormat).toContain("{index}");
    expect(fanqie?.version).toBe(/(^|\n)version:\s*(\S+)/.exec(packText)?.[2]);
  });

  it("清单里坏包不被静默丢掉：带 parseError 出现，好包照常可用", async () => {
    const root = await packRoot({
      good: MINIMAL_PACK,
      bad: "platform: bad\nchapter_title_format: 第{index}章 {title}\n",
    });
    const packs = await scanPlatformPacks(root);
    expect(packs.find((item) => item.id === "good")?.chapterTitleFormat).toContain("{index}");
    const bad = packs.find((item) => item.id === "bad");
    expect(bad?.parseError).toContain("source_urls");
    expect(bad?.pack).toBeNull();
  });

  it("包目录不存在时返回空清单，不抛错（导出页要照常能用）", async () => {
    const packs = await scanPlatformPacks(join(dir, "no-such-platforms"));
    expect(packs).toEqual([]);
  });
});

describe("导出预览的平台面板", () => {
  it("不选平台时 platform 为 null，但仍列出可用平台包", async () => {
    const gateway = await secondVolumeDraftProject();
    const preview = await previewExport(gateway);
    expect(preview.platform).toBeNull();
    expect(preview.platforms.map((item) => item.id)).toContain("fanqie");
    expect(preview.platformNote).toBeNull();
  });

  it("选番茄包 ⇒ 给出套格式后的章头样例与核对行", async () => {
    const gateway = await secondVolumeDraftProject();
    const preview = await previewExport(gateway, { platform: "fanqie" });
    expect(preview.platform?.pack.id).toBe("fanqie");
    // 卷二那一章在全书是第 3 章（卷一的 2 个章纲即使没草稿也占号）
    expect(preview.platform?.titles[0]?.head).toBe("第3章 （待拟题）");
    expect(preview.platform?.titles[0]?.head).not.toContain("第3章 第");
    expect(preview.platform?.checkedChapters).toBe(1);
    // 标题自带前缀 ⇒ warn 必须点名
    expect(preview.platform?.rows.some((row) => row.rule === "export-platform-title-repeat")).toBe(true);
  });

  it("未知平台 id ⇒ 预览不炸，note 带真错误，其余统计照旧", async () => {
    const gateway = await secondVolumeDraftProject();
    const preview = await previewExport(gateway, { platform: "nosuchplatform" });
    expect(preview.platform).toBeNull();
    expect(preview.platformNote).toContain("nosuchplatform");
    expect(preview.chapters).toBe(1);
    expect(preview.totalWords).toBeGreaterThan(0);
  });

  it("包解析失败（缺来源）⇒ note 里是引擎原话，不把整页打死", async () => {
    const gateway = await secondVolumeDraftProject();
    const root = await packRoot({ broken: "platform: broken\nchapter_title_format: 第{index}章 {title}\n" });
    const preview = await previewExport(gateway, { platform: "broken", platformRoot: root });
    expect(preview.platform).toBeNull();
    expect(preview.platformNote).toContain("source_urls");
  });

  it("error 级核对行要能在预览里看见（编码不符不是警告，是根本对不上）", async () => {
    const gateway = await secondVolumeDraftProject();
    const root = await packRoot({
      gbkplat: [
        "platform: gbkplat",
        "version: 1.0.0",
        "effective_date: 2026-01-01",
        "checked_at: 2026-09-29",
        "source_urls:",
        "  - https://example.com/rules",
        "chapter_title_format: 第{index}章 {title}",
        "encoding: GBK",
      ].join("\n"),
    });
    const preview = await previewExport(gateway, { platform: "gbkplat", platformRoot: root });
    const encoding = preview.platform?.rows.find((row) => row.rule === "export-platform-encoding");
    expect(encoding?.severity).toBe("error");
  });

  it("包声明了投稿材料清单 ⇒ 只照抄清单，不替作者判「缺哪几项」", async () => {
    const gateway = await secondVolumeDraftProject();
    const root = await packRoot({
      jjwxc: [
        "platform: jjwxc",
        "version: 1.0.0",
        "effective_date: 2026-01-01",
        "checked_at: 2026-09-29",
        "source_urls:",
        "  - https://example.com/rules",
        "chapter_title_format: 第{index}章 {title}",
        "submission_materials:",
        "  - 简纲",
        "  - 人设",
      ].join("\n"),
    });
    const preview = await previewExport(gateway, { platform: "jjwxc", platformRoot: root });
    expect(preview.platform?.pack.submissionMaterials).toEqual(["简纲", "人设"]);
    // 御书没有"材料是否齐备"的项目内约定可核对，所以不许产出一条"还缺"的判断行
    expect(preview.platform?.rows.some((row) => row.rule === "export-platform-materials-missing")).toBe(false);
  });
});

describe("导出执行按平台格式落笔", () => {
  const listExports = async (gateway: ProjectGateway): Promise<string[]> =>
    (await gateway.listTree())
      .filter((entry) => entry.path.startsWith("exports/"))
      .map((entry) => entry.path)
      .sort();

  it("选平台 ⇒ TXT 章头按包的模板写（含全书连续章号）", async () => {
    const gateway = await secondVolumeDraftProject();
    const result = await runExport(gateway, { confirmed: true, platform: "fanqie" });
    const text = await readFile(join(dir, result.path), "utf8");
    expect(text).toContain("第3章 （待拟题）");
    expect(text).not.toContain("第1章 （待拟题）");
    expect(result.platform?.id).toBe("fanqie");
    expect(result.platform?.chapterTitleFormat).toContain("{index}");
  });

  it("不选平台时与旧行为逐字一致（作者的标题一个字都不动）", async () => {
    const gateway = await secondVolumeDraftProject();
    const plain = await runExport(gateway, { confirmed: true });
    const text = await readFile(join(dir, plain.path), "utf8");
    expect(text).toContain("第1章（待拟题）");
    expect(text).not.toContain("第3章 ");
    expect(plain.platform).toBeUndefined();
  });

  it("error 级核对行 ⇒ 落笔之前就拒，exports/ 一个文件都不许多", async () => {
    const gateway = await secondVolumeDraftProject();
    const root = await packRoot({
      gbkplat: [
        "platform: gbkplat",
        "version: 1.0.0",
        "effective_date: 2026-01-01",
        "checked_at: 2026-09-29",
        "source_urls:",
        "  - https://example.com/rules",
        "chapter_title_format: 第{index}章 {title}",
        "encoding: GBK",
      ].join("\n"),
    });
    const before = await listExports(gateway);
    const err = await runExport(gateway, { confirmed: true, platform: "gbkplat" }, { platformRoot: root }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err?.code).toBe("E_EXPORT_PLATFORM_GATE");
    expect(String(err?.message)).toContain("未落笔");
    expect(await listExports(gateway)).toEqual(before);
  });

  it("EPUB 走同一条格式：交给 pandoc 的 .md 源里 ## 行也按模板", async () => {
    const gateway = await secondVolumeDraftProject();
    const commands: string[][] = [];
    const tooling = {
      pandocVersion: "2.10",
      pandocOutputFormats: ["epub3", "docx", "pdf"],
      pdfEngines: [] as string[],
      epubCheckAvailable: false,
    };
    const result = await runExport(
      gateway,
      { confirmed: true, format: "epub", platform: "fanqie" },
      {
        tooling,
        run: async (command: string, args: string[]) => {
          commands.push([command, ...args]);
          const output = args[args.indexOf("--output") + 1];
          if (output) await writeFile(output, "fake-epub", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        },
        exists: async () => false,
      },
    );
    expect(commands.length).toBeGreaterThan(0);
    const sourcePath = result.sourcePath;
    expect(sourcePath).toBeDefined();
    const md = await readFile(join(dir, sourcePath!), "utf8");
    expect(md).toContain("## 第3章 （待拟题）");
    expect(md).not.toContain("## 第1章 （待拟题）");
  });
});

/**
 * 平台参数的两条锁（R94）。
 *
 * ① **接线锁**：单测能证明 `previewExport({platform})` 与 `runExport({...,platform})` 各自成立，
 *    但证不了中间那几棒有没有人接——渲染层忘了带字段、preload 忘了转发 payload，
 *    功能会安静地退回"永远不按平台格式"，而且没有任何测试会红（R92 那条五棒锁就是这么立起来的）。
 * ② **零硬编码锁**：K11 要的是"参数从包读"。扫导出格式这条路径上的文件，
 *    出现任何平台名 / 平台 id 就红。扫描器自己也带**正对照**（真包必须能被同一个正则命中），
 *    否则"路径写错 ⇒ 扫到 0 个文件 ⇒ 永远绿"这种假锁根本发现不了（R91 变异 D 的教训）。
 */
describe("平台参数的接线与零硬编码（锁）", () => {
  const read = async (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

  it("平台 id 五棒都在：按钮 → api → preload → 主进程 handler → previewExport/runExport", async () => {
    const shared = await read("../src/shared/ipc.ts");
    const mainIpc = await read("../src/main/ipc.ts");
    const preload = await read("../preload/preload.cjs");
    const api = await read("../renderer/src/api.ts");
    const view = await read("../renderer/src/views/ExportView.tsx");

    expect(shared).toMatch(/interface ExportPreviewRequest \{[\s\S]*?platform\?: string/);
    expect(shared).toMatch(/interface ExportRunPayload \{[\s\S]*?platform\?: string/);
    expect(mainIpc).toContain("platform: payload?.platform");
    // run 必须整个 payload 递下去：改成只挑几个字段就会静默丢掉 platform
    expect(mainIpc).toMatch(/runExport\(requireGateway\(\), payload\)/);
    expect(preload).toMatch(/run: \(payload\) => invoke\("export:run", payload\)/);
    expect(api).toContain("preview: (payload?: ExportPreviewRequest)");
    expect(api).toContain("run: (payload: ExportRunPayload)");
    // 预览与导出两处都要带上，漏一处就是"看得见但导不出"或反之
    expect(view.match(/platform: platform === "" \? undefined : platform/g)?.length).toBe(2);
    expect(view).toContain('aria-label="平台章节格式"');
    expect(view).toContain("setPlatform(item.id)");
    expect(view).toContain("export-platform-panel");
    expect(view).toContain("platformLine(result)");
  });

  it("导出格式路径里不许出现平台名或平台 id（K11：参数从包读）", async () => {
    const targets = [
      "../../../packages/@yushu/export/src/platform-format.ts",
      "../../../packages/@yushu/export/src/assemble.ts",
      "../../../packages/@yushu/export/src/markdown.ts",
      "../../../packages/@yushu/export/src/formats.ts",
      "../../../packages/@yushu/export/src/types.ts",
      "../src/main/export-ops.ts",
      "../src/main/platform-ops.ts",
      "../src/main/ipc.ts",
      "../renderer/src/views/ExportView.tsx",
    ];
    const names = /fanqie|qidian|jjwxc|faloo|qimao|番茄|晋江|飞卢|七猫/i;
    const texts = await Promise.all(targets.map(read));
    // 扫描范围下限：路径写错会扫到空文件而"永远绿"，所以逐文件断言非空
    expect(texts.length).toBe(targets.length);
    for (const [index, text] of texts.entries()) {
      expect(text.length, targets[index]).toBeGreaterThan(200);
      expect(text, targets[index]).not.toMatch(names);
    }
    // 正对照：同一个判据必须能在真包上命中，否则这条锁是死的
    const packText = await read("../../../packs/platforms/fanqie/platform-export.yaml");
    expect(packText).toMatch(names);
  });
});
