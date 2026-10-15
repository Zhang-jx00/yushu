/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWords } from "@yushu/core";
import { readChapterFile } from "@yushu/world-engine";
import { adoptDraft } from "../src/main/ai-ops.js";
import { buildClipboardResult, loadWordlists, previewExport, runExport } from "../src/main/export-ops.js";
import {
  createOutlineChapter,
  createProject,
  generateOutline,
  writeCardDoc,
} from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-export-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  gateway: ProjectGateway;
  volumeId: string;
  chapterId: string;
  chapterPath: string;
}

/** 项目：1 卷 2 章纲；第一章已建草稿并写入正文（含内部注释与敏感词） */
async function setupProject(): Promise<Fixture> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { type: "character", name: "林渊", layer: "characters" },
    body: "边城少年。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: generated.hash,
  });
  return { gateway, volumeId: volume.id, chapterId: chapter.id, chapterPath: draft.chapterPath };
}

describe("字数对账与装配（T1-18）", () => {
  it("采纳后的章节字数与 frontmatter 一致；未创建草稿的章纲被计数提示", async () => {
    const fixture = await setupProject();
    const prose = "天启界的夜色压下来。\n<!-- 内部备注：伏笔X -->\n他低声说：加微信详谈。";
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: prose,
      mode: "replace",
    });

    const preview = await previewExport(fixture.gateway);
    expect(preview.bookTitle).toBe("天启界");
    expect(preview.volumes).toBe(1);
    expect(preview.chapters).toBe(1);
    expect(preview.missingDrafts).toBe(1); // 第二章未创建草稿章节
    expect(preview.reconcile[0]?.matched).toBe(true);
    // 字数口径以正文真源为准（内部注释计入；M2 码字统计将细化口径）
    expect(preview.totalWords).toBe(countWords(prose));
  });

  it("frontmatter 字数被外部改错时对账标出失配", async () => {
    const fixture = await setupProject();
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: "正文若干。",
      mode: "replace",
    });
    const snapshot = await fixture.gateway.readDoc(fixture.chapterPath);
    const { chapter, body } = readChapterFile(snapshot.content);
    const { serializeChapterFile } = await import("@yushu/world-engine");
    await fixture.gateway.writeDoc(
      fixture.chapterPath,
      serializeChapterFile({ ...chapter, word_count: 999 }, body),
      snapshot.hash,
    );

    const preview = await previewExport(fixture.gateway);
    const row = preview.reconcile[0]!;
    expect(row.matched).toBe(false);
    expect(row.stated).toBe(999);
    expect(row.actual).toBe(countWords(body));
  });
});

describe("敏感词自查与词库（T1-19）", () => {
  it("内置词库命中 error 级并给出替换建议；项目内词库覆盖同词条", async () => {
    const fixture = await setupProject();
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: "临走时他低声说：加微信详谈。",
      mode: "replace",
    });

    const base = await previewExport(fixture.gateway);
    expect(base.hitTotal).toBe(1);
    expect(base.bySeverity.error).toBe(1);
    expect(base.hits[0]?.word).toBe("加微信");
    expect(base.hits[0]?.suggestion).toContain("导流");
    expect(base.hits[0]?.context).toContain("加微信");
    expect(base.wordlists.some((item) => item.id === "sensitive-basic")).toBe(true);

    // 项目内词库：同词条降级为 warn（覆盖生效）
    await fixture.gateway.writeDoc(
      "wordlists/project-override.yaml",
      [
        "apiVersion: yushu.wordlist/v1",
        "id: project-override",
        "version: 1.0.0",
        "source: 项目自建",
        "entries:",
        "  - {word: 加微信, severity: warn, suggestion: 改为站内私信}",
      ].join("\n"),
    );
    const overridden = await previewExport(fixture.gateway);
    expect(overridden.bySeverity.error).toBe(0);
    expect(overridden.bySeverity.warn).toBe(1);
    expect(overridden.hits[0]?.suggestion).toBe("改为站内私信");
    expect(overridden.hits[0]?.wordlistId).toBe("project-override");
  });

  it("项目内损坏词库被跳过且不阻断内置词库", async () => {
    const fixture = await setupProject();
    await fixture.gateway.writeDoc("wordlists/broken.yaml", "apiVersion: yushu.wordlist/v9\nentries: []\n");
    const loaded = await loadWordlists(fixture.gateway);
    expect(loaded.skipped.map((item) => item.path)).toContain("wordlists/broken.yaml");
    expect(loaded.wordlists.some((item) => item.id === "sensitive-basic")).toBe(true);
  });
});

describe("导出执行与防手滑（T1-18 / T1-20）", () => {
  it("未确认导出被拒绝；确认后写入 exports/ 并去除内部注释；同名追加序号", async () => {
    const fixture = await setupProject();
    const prose = "第一段。\n<!-- 内部备注 -->\n第二段。";
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: prose,
      mode: "replace",
    });

    await expect(runExport(fixture.gateway, { confirmed: false })).rejects.toMatchObject({
      code: "E_CONFIRM_REQUIRED",
    });

    const first = await runExport(fixture.gateway, { confirmed: true, includeToc: true, stripMarkers: true });
    expect(first.path.startsWith("exports/")).toBe(true);
    expect(first.path.endsWith(".txt")).toBe(true);
    expect(first.chapters).toBe(1);
    expect(first.words).toBe(countWords(prose));
    expect(first.clean).toBe(true);

    const text = await readFile(join(dir, first.path), "utf8");
    expect(text).toContain("《天启界》");
    expect(text).toContain("═ 目录 ═");
    expect(text).toContain("第一段。");
    expect(text).not.toContain("内部备注");
    expect(text).not.toContain("<!--");

    const second = await runExport(fixture.gateway, { confirmed: true });
    expect(second.path).not.toBe(first.path);
    expect(second.path).toContain("-2.txt");
  });

  it("无可导出章节时给出明确错误", async () => {
    await createProject({ dir, title: "空书", packIds: ["xuanhuan-xitong"], axes: AXES });
    const gateway = new ProjectGateway(dir);
    await expect(runExport(gateway, { confirmed: true })).rejects.toMatchObject({
      code: "E_EMPTY_EXPORT",
    });
  });
});

describe("干净剪贴板（T1-20）", () => {
  it("文本无 frontmatter/目录/注释；可选去 AI 标识", async () => {
    const fixture = await setupProject();
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: "正文一。\n<!-- 注释 -->\n（AI 生成）正文二。",
      mode: "replace",
    });

    const { result, text } = await buildClipboardResult(fixture.gateway, {
      stripComments: true,
      stripAiMarks: true,
    });
    expect(result.chapters).toBe(1);
    expect(text).not.toContain("---");
    expect(text).not.toContain("注释");
    expect(text).not.toContain("AI 生成");
    expect(text).toContain("正文一。");
    expect(text).toContain("正文二。");
    expect(result.preview.length).toBeLessThanOrEqual(161);
  });
});

/**
 * 导出能力矩阵进预览（M5 / T5-4 第一段，R87）。
 *
 * 断言刻意**不写死"本机有哪几个格式"**——那会让测试换台机器就红，或者更糟：
 * 换台机器后大家把测试改成"跟着机器走"，锁就废了。
 * 这里比的是**预览里的结论 == 现场探测 + 判定的结论**（同一套代码、同一次事实），
 * 外加三条与机器无关的口径：TXT 永远可用、每项都要有原因、顺序固定。
 */
describe("导出预览的能力矩阵（T5-4）", () => {
  it("预览带 capability 列表，且与现场探测 + 判定结果一致", async () => {
    const fixture = await setupProject();
    const { probeExportTooling, realToolDeps } = await import("../src/main/export-tooling.js");
    const { assessExportFormats } = await import("@yushu/export");
    const preview = await previewExport(fixture.gateway);
    const expected = assessExportFormats(await probeExportTooling(realToolDeps()));
    expect(preview.capabilities.map((item) => item.format)).toEqual(["txt", "epub", "docx", "pdf"]);
    expect(preview.capabilities).toEqual(expected);
    // 与机器无关的三条
    expect(preview.capabilities.find((item) => item.format === "txt")!.available).toBe(true);
    for (const item of preview.capabilities) {
      expect(item.reason, `${item.format} 必须给出原因（可用要说靠什么，不可用要说缺什么）`).not.toBe("");
    }
  });

  it("能力探测不污染真源，也不写盘（预览全程只读）", async () => {
    const fixture = await setupProject();
    const before = await fixture.gateway.readDoc(fixture.chapterPath);
    await previewExport(fixture.gateway);
    const after = await fixture.gateway.readDoc(fixture.chapterPath);
    expect(after.hash).toBe(before.hash);
  });

  it("探测本身抛错 ⇒ 预览照常出，能力矩阵留空并写明「探测失败」（不拿假结论顶替）", async () => {
    const fixture = await setupProject();
    const prose = "天启界的夜色压下来。";
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: prose,
      mode: "replace",
    });

    const preview = await previewExport(fixture.gateway, {
      probeTooling: async () => {
        throw new Error("spawn ENOENT 模拟");
      },
    });
    expect(preview.capabilities).toEqual([]);
    expect(preview.capabilitiesNote).toContain("探测失败");
    expect(preview.capabilitiesNote).toContain("spawn ENOENT 模拟");
    // 探测失败不许连带把导出预览本身打死：章数、字数、命中照常
    expect(preview.chapters).toBe(1);
    expect(preview.totalWords).toBe(countWords(prose));
  });
});
/**
 * 真实多格式导出（M5 / T5-4 第三段，R90）。
 *
 * 这一段的重点不是"能不能出 EPUB"，而是**出不了的时候怎么办**：
 * 产不出的格式必须在**落笔之前**被拒——先写一个 `.md` 再报错，等于把半成品留在作者的项目里。
 * 工具链与命令下发都从外面注入，所以这里比的是"御书做了什么决定"，不是"本机装了什么"。
 */
describe("多格式导出（T5-4 第三段）", () => {
  const tooling = {
    pandocVersion: "2.10",
    pandocOutputFormats: ["epub3", "docx", "pdf"],
    pdfEngines: [] as string[],
    epubCheckAvailable: false,
  };

  /**
   * 记账的假命令层：记录每条下发的命令，并**真的把 --output 指到的文件写出来**——
   * 否则"产物落在哪"这件事根本没法断言（回执说 exports/x.epub，磁盘上却什么都没有）。
   */
  const fakePandoc = (fail = false) => {
    const commands: string[][] = [];
    return {
      commands,
      toolDeps: {
        run: async (cmd: string, args: string[]) => {
          commands.push([cmd, ...args]);
          if (fail) return { code: 83, stdout: "", stderr: "no writer could be found for epub" };
          const at = args.indexOf("--output");
          if (at >= 0 && args[at + 1] !== undefined) {
            // resolve 而不是 join：给绝对路径时它原样返回，给相对路径时按项目根拼
            await writeFile(resolve(dir, args[at + 1]!), `fake-${cmd}\n`);
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        exists: async () => false,
      },
    };
  };

  const withDraft = async () => {
    const fixture = await setupProject();
    await adoptDraft(fixture.gateway, {
      usageId: "test-usage",
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
      text: "天启界的夜色压下来。\n<!-- 内部备注：伏笔X -->",
      mode: "replace",
    });
    return fixture;
  };

  const listExports = async (gateway: ProjectGateway) =>
    (await gateway.listTree())
      .filter((entry) => entry.type === "file" && entry.path.startsWith("exports/"))
      .map((entry) => entry.path)
      .sort();

  it("EPUB：先落 .md 源，再按 epub3 下发 pandoc，回执点名两个文件", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc();
    const out = await runExport(
      fixture.gateway,
      { confirmed: true, format: "epub", includeToc: true },
      { tooling, ...fake.toolDeps },
    );
    expect(out.format).toBe("epub");
    expect(out.path.endsWith(".epub")).toBe(true);
    expect(out.sourcePath?.endsWith(".md")).toBe(true);
    const files = await listExports(fixture.gateway);
    expect(files.length).toBe(2);
    expect(files.some((name) => name.endsWith(".md"))).toBe(true);
    expect(files.some((name) => name.endsWith(".epub"))).toBe(true);
    // 只下发那一条转换命令（探测被注入，不再 spawn 真命令）
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]!.join(" ")).toContain("--to epub3");
    expect(fake.commands[0]!.join(" ")).toContain("--toc");
    // 外部命令拿到的是**绝对路径**：spawn 的 cwd 是主进程目录，不是项目目录，
    // 传相对路径 pandoc 会报"文件不存在"（v192 的 step58 就是这么红的）
    const args = fake.commands[0]!.slice(1);
    const outArg = args[args.indexOf("--output") + 1]!;
    const srcArg = args.find((arg) => arg.endsWith(".md") && !arg.startsWith("--"))!;
    expect(isAbsolute(outArg), `--output 必须是绝对路径，收到 ${outArg}`).toBe(true);
    expect(isAbsolute(srcArg), `.md 源必须是绝对路径，收到 ${srcArg}`).toBe(true);
    // 回执里给 UI 的仍是项目内相对路径
    expect(out.path.startsWith("exports/")).toBe(true);
    expect(out.sourcePath!.startsWith("exports/")).toBe(true);
    // 源文件确实是 R89 那份装配（元数据块在最前面）
    const snap = await fixture.gateway.readDoc(out.sourcePath!);
    expect(snap.content.startsWith("---\ntitle: ")).toBe(true);
    expect(snap.content).toContain("## 第1章");
  });

  it("目录开关真的传到 pandoc：includeToc=false 时不许带 --toc", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc();
    await runExport(
      fixture.gateway,
      { confirmed: true, format: "docx", includeToc: false },
      { tooling, ...fake.toolDeps },
    );
    const joined = fake.commands[0]!.join(" ");
    expect(joined).not.toContain("--toc");
    expect(joined).toContain("--to docx");
  });

  it("本机产不出的格式：落笔之前就拒，exports/ 里一个文件都不许多出来", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc();
    const before = await listExports(fixture.gateway);
    const err = await runExport(
      fixture.gateway,
      { confirmed: true, format: "pdf" },
      { tooling, ...fake.toolDeps },
    ).catch((e: unknown) => e as { code?: string; message?: string });
    // 错误码必须点名"是没查能力被拒"，不是"pandoc 跑挂了"——
    // 只断言消息含「引擎」的话，两层守卫（这里 + convertWithPandoc 内部）随便哪一层红都算过，
    // 把这一层整个删掉测试照样绿（R90 变异 M1 就是这么暴露的）
    expect((err as { code?: string }).code).toBe("E_EXPORT_FORMAT_UNAVAILABLE");
    expect(String((err as { message?: string }).message)).toContain("未落笔");
    expect(fake.commands).toHaveLength(0);
    expect(await listExports(fixture.gateway)).toEqual(before);
  });

  it("pandoc 失败：错误原文带回去，且把中途写下的 .md 清掉", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc(true);
    await expect(
      runExport(fixture.gateway, { confirmed: true, format: "epub" }, { tooling, ...fake.toolDeps }),
    ).rejects.toThrow(/no writer could be found/);
    expect(await listExports(fixture.gateway)).toEqual([]);
  });

  it("EPUBCheck 未就位：回执里门禁是「未校验」，不是通过", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc();
    const out = await runExport(
      fixture.gateway,
      { confirmed: true, format: "epub" },
      { tooling, ...fake.toolDeps },
    );
    expect(out.gate).toBeDefined();
    expect(out.gate!.ran).toBe(false);
    expect(out.gate!.passed).toBe(false);
    expect(out.gate!.reason).toContain("未校验");
    // 没质检不等于不许导出：EPUB 仍然产出了
    expect(out.path.endsWith(".epub")).toBe(true);
  });

  it("TXT 仍是老路径：不写 .md、不下发任何外部命令", async () => {
    const fixture = await withDraft();
    const fake = fakePandoc();
    const out = await runExport(fixture.gateway, { confirmed: true }, { tooling, ...fake.toolDeps });
    expect(out.format).toBe("txt");
    expect(out.path.endsWith(".txt")).toBe(true);
    expect(out.sourcePath).toBeUndefined();
    expect(fake.commands).toHaveLength(0);
    expect((await listExports(fixture.gateway)).filter((name) => name.endsWith(".md"))).toEqual([]);
  });
});
