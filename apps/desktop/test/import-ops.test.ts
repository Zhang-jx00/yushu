import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWords } from "@yushu/core";
import { ImportGate } from "../src/main/import-gate.js";
import { DEFAULT_IMPORT_CLEAN_RULES, pickImportSource, previewImport } from "../src/main/import-ops.js";

/**
 * 存量导入的桌面侧第二段（M5 / T5-7，R77）：**挑一个文件 → 看一眼预演报告**，全程零写入。
 *
 * 这五条口径是这份测试真正在守的东西：
 * ① **路径不出主进程**：`pickImportSource` 的返回值里只有票据与文件名——渲染层拿到绝对路径
 *    就等于重新拿到了"传路径"的能力，前面那道闸门白立；
 * ② **探测不出就不猜**：GB18030 兜底时 `assumed` 与那句"这是猜的"必须原样透传到载荷里，
 *    面板才有话可说；空文件连猜都不猜；
 * ③ **清洗必须留报告**：删了几行、每类一个样例、密钥剔除单独计数，用了哪些规则也一并交回去
 *    （作者核对不了 = 只能整篇弃用）；
 * ④ **正文不过 IPC**：预演只给字数与摘录，32MB 的稿子不整篇塞进渲染层；
 * ⑤ **预演不落盘**：跑一次预览，源目录的条目数一个字节都不该变。
 */

/**
 * GBK 真字节夹具：`第一章 起` 与 `夜色压下来。`。
 * 不能写 `Buffer.from(s, "gb18030")` —— Node 的 Buffer **不支持** GB18030 编码方向
 * （`ERR_UNKNOWN_ENCODING`），只有 `TextDecoder` 能解，所以夹具只能内嵌字节。
 */
const GBK_HEAD = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc6, 0xf0]);
const GBK_BODY = Buffer.from([0xd2, 0xb9, 0xc9, 0xab, 0xd1, 0xb9, 0xcf, 0xc2, 0xc0, 0xb4, 0xa1, 0xa3]);
const GBK_BYTES = Buffer.concat([GBK_HEAD, Buffer.from("\n", "utf8"), GBK_BODY, Buffer.from("\n", "utf8")]);

let dir: string;
let gate: ImportGate;

const write = async (name: string, content: string | Uint8Array): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : Buffer.from(content));
  return path;
};

/** 模拟 Electron 的 showOpenDialog 结果（不 import electron，好让这里能单测） */
const dialogReturning = (paths: string[]) => async () => ({ canceled: false, filePaths: paths });
const dialogCanceled = async () => ({ canceled: true, filePaths: [] });

const listAll = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
    }
  };
  await walk(root, "");
  return out.sort();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-import-ops-"));
  gate = new ImportGate();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("挑选：票据是渲染层唯一能拿到的东西", () => {
  it("用户选中文件 ⇒ 只回报票据 / 文件名 / 字节数（绝对路径不出主进程）", async () => {
    const file = await write("旧稿.txt", "第一章 起\n夜色压下来。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    expect(Object.keys(picked ?? {}).sort()).toEqual(["bytes", "name", "ticket"]);
    expect(picked?.name).toBe("旧稿.txt");
    expect(picked?.bytes).toBeGreaterThan(0);
  });

  it("用户取消 ⇒ 返回 null 且一张票都不发（不留悬空票据）", async () => {
    expect(await pickImportSource(dialogCanceled, gate)).toBeNull();
    expect(gate.size()).toBe(0);
  });

  it("对话框被塞了个目录 ⇒ 闸门的拒绝原样冒出来，不静默变 null", async () => {
    const sub = join(dir, "某个目录");
    await mkdir(sub);
    await expect(pickImportSource(dialogReturning([sub]), gate)).rejects.toThrow(/不是文件/);
  });

  it("超过上限 ⇒ 挑的时候就拒，不等读完才说", async () => {
    const big = await write("超大.txt", Buffer.alloc(33 * 1024 * 1024, 0x41));
    await expect(pickImportSource(dialogReturning([big]), gate)).rejects.toThrow(/超过上限/);
  });
});

describe("编码探测结论透传", () => {
  it("合法 UTF-8 ⇒ assumed=false，note 说清是按严格解码通过的", async () => {
    const file = await write("a.txt", "第一章 起\n夜色压下来。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.encoding.encoding).toBe("utf-8");
    expect(view.encoding.assumed).toBe(false);
    expect(view.encoding.note).toContain("UTF-8");
  });

  it("GBK 稿件 ⇒ 兜底判定并如实带着「这是猜的」", async () => {
    const file = await write("g.txt", GBK_BYTES);
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.encoding.encoding).toBe("gb18030");
    expect(view.encoding.assumed).toBe(true);
    expect(view.encoding.note).toContain("猜");
    expect(view.chapters[0]?.title).toBe("第一章 起");
    expect(view.chapters[0]?.excerpt).toContain("夜色压下来。");
  });

  it("空文件 ⇒ 不猜（ok=false），并且没有可切的章", async () => {
    const file = await write("e.txt", "");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.encoding.ok).toBe(false);
    expect(view.encoding.encoding).toBe("unknown");
    expect(view.split.chapterCount).toBe(0);
  });

  it("未知票据 ⇒ 拒，不碰磁盘", async () => {
    await expect(previewImport("ffffffffffffffffffffffffffffffff", { gate })).rejects.toThrow(/票据无效/);
  });
});

describe("清洗报告：删了什么要说出来", () => {
  it("CRLF / 多余空行 / 纯网址行 / 疑似密钥 ⇒ 各自计数，密钥单独报", async () => {
    const file = await write(
      "c.txt",
      [
        "第一章 起",
        "夜色压下来。",
        "",
        "",
        "",
        "",
        "https://www.example-site.com/read/12345",
        "调用 openai 用 sk-abcdefghijklmnopqrstuvwx",
        "第二章 承",
        "林渊拔剑而起。",
      ].join("\r\n"),
    );
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.clean.lineEndingNormalized).toBeGreaterThan(0);
    expect(view.clean.blankLinesCollapsed).toBeGreaterThan(0);
    expect(view.clean.removed.map((r) => r.rule)).toContain("pure-url");
    expect(view.clean.removed.find((r) => r.rule === "pure-url")?.count).toBe(1);
    expect(view.clean.removed.find((r) => r.rule === "pure-url")?.sample).toContain("example-site");
    expect(view.clean.redacted.map((r) => r.kind)).toContain("openai 风格 sk-");
    expect(view.clean.redacted.find((r) => r.kind === "openai 风格 sk-")?.count).toBe(1);
  });

  it("密钥被就地替换，摘录里读不到原文", async () => {
    const file = await write("k.txt", "第一章 起\n密钥是 sk-abcdefghijklmnopqrstuvwx\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(view.chapters[0]?.excerpt).toContain("[已剔除疑似密钥]");
  });

  it("默认规则一并交回载荷（作者要看得见用了哪些规则）", async () => {
    expect(DEFAULT_IMPORT_CLEAN_RULES.length).toBeGreaterThan(0);
    const file = await write("d.txt", "第一章 起\n夜色压下来。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.rules.length).toBe(DEFAULT_IMPORT_CLEAN_RULES.length);
    expect(view.rules.every((r) => r.source === "builtin")).toBe(true);
    expect(view.rules.map((r) => r.id)).toEqual(DEFAULT_IMPORT_CLEAN_RULES.map((r) => r.id));
  });

  it("自定义正则追加在默认规则之后，并标出来源", async () => {
    const file = await write("u.txt", "第一章 起\n这段还是草稿\n夜色压下来。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, {
      gate,
      rules: [{ id: "drop-draft", pattern: "还是草稿" }],
    });
    expect(view.rules.at(-1)).toEqual({ id: "drop-draft", pattern: "还是草稿", source: "custom" });
    expect(view.clean.removed.map((r) => r.rule)).toContain("drop-draft");
  });

  it("自定义正则读不懂 ⇒ 抛错，不静默当成没清洗", async () => {
    const file = await write("b.txt", "第一章 起\n夜色压下来。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    await expect(
      previewImport(picked!.ticket, { gate, rules: [{ id: "bad", pattern: "([正则没写完" }] }),
    ).rejects.toThrow(/正则读不了/);
  });
});

describe("分章预览：切不开就要说切不开", () => {
  it("两章一序 ⇒ 章数、标题、字数、preamble 各归各位", async () => {
    const file = await write(
      "s.txt",
      ["作品简介：这是一本测试稿。", "第一卷 风起", "第一章 起", "夜色压下来。", "第二章 承", "林渊拔剑而起。"].join("\n"),
    );
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.split.chapterCount).toBe(2);
    expect(view.split.hardSplit).toBe(true);
    expect(view.split.note).toBeNull();
    expect(view.split.volumeHints).toEqual(["第一卷 风起"]);
    expect(view.split.hasPreamble).toBe(true);
    expect(view.chapters.map((c) => c.title)).toEqual(["第一章 起", "第二章 承"]);
    expect(view.chapters[0]?.chars).toBe(countWords("夜色压下来。"));
  });

  it("认不出标题 ⇒ 整篇一章、hardSplit=false 且给出说明", async () => {
    const file = await write("n.txt", "没有标题的一段正文。\n还是没标题。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.split.hardSplit).toBe(false);
    expect(view.split.chapterCount).toBe(1);
    expect(view.split.note).toContain("没找到章节标题");
  });

  it("字数口径与编辑器一致：totalChars = 各章 + 序", async () => {
    const file = await write(
      "t.txt",
      ["楔子内容。", "第一章 起", "夜色压下来。", "第二章 承", "林渊拔剑而起。"].join("\n"),
    );
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    const sum = view.chapters.reduce((acc, c) => acc + c.chars, 0) + view.split.preambleChars;
    expect(view.totalChars).toBe(sum);
    expect(view.totalChars).toBeGreaterThan(0);
  });
});

describe("载荷体量与零写入", () => {
  it("超长章节只带字数与摘录，正文不过 IPC", async () => {
    const long = "夜".repeat(3000);
    const file = await write("L.txt", `第一章 起\n${long}\n`);
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const view = await previewImport(picked!.ticket, { gate });
    expect(view.chapters[0]?.chars).toBe(3000);
    expect((view.chapters[0]?.excerpt ?? "").length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(view).length).toBeLessThan(1500);
  });

  it("预览一遍不新增任何文件（零写入）", async () => {
    const file = await write("w.txt", "第一章 起\n夜色压下来。\n");
    await mkdir(join(dir, "子目录"));
    const before = await listAll(dir);
    const picked = await pickImportSource(dialogReturning([file]), gate);
    await previewImport(picked!.ticket, { gate });
    expect(await listAll(dir)).toEqual(before);
  });

  it("同一张票两次预览结果逐字段相同（预演可重复，不是每次换个说法）", async () => {
    const file = await write("r.txt", "第一章 起\n夜色压下来。\n第二章 承\n林渊拔剑而起。\n");
    const picked = await pickImportSource(dialogReturning([file]), gate);
    const a = await previewImport(picked!.ticket, { gate });
    const b = await previewImport(picked!.ticket, { gate });
    expect(b).toEqual(a);
  });
});
