/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  convertWithPandoc,
  onceTooling,
  probeExportTooling,
  validateEpub,
  type CommandResult,
  type ToolDeps,
} from "../src/main/export-tooling.js";

/**
 * 导出工具链探测与调用（M5 / T5-4 第一段，R87）。
 *
 * 探测与转换都收在这里，是为了让"这台机器上到底有什么"变成**可注入、可单测**的东西：
 * 真实 `spawn` 只在主进程用，测试喂假命令表。三条要紧的断言：
 * ① 探测**照实**：pandoc 不在就是不在，不许拿"应该装了"当事实；
 * ② `convertWithPandoc` 对**不可用的格式直接拒**，绝不"退而求其次产出 TXT"——
 *    用户要的是 EPUB，给一个 `.txt` 改名成 `.epub` 是这一路最坏的那种静默降级；
 * ③ EPUBCheck 不在 ⇒ `ran:false`，门禁不通过且理由是"未校验"（不是"通过"）。
 */

const fake = (table: Record<string, CommandResult>, missingNote = "not found") => ({
  run: async (cmd: string, args: string[]): Promise<CommandResult> => {
    const key = [cmd, ...args].join(" ");
    for (const [pattern, result] of Object.entries(table)) {
      if (key.startsWith(pattern)) return result;
    }
    return { code: 127, stdout: "", stderr: missingNote };
  },
});

/**
 * 记账用的假依赖：记录每条命令与"同时在飞的调用数峰值"。
 * 每个假调用内部先 `await Promise.resolve()`，这样"串行"与"并行"能被区分开——
 * 若代码是 `await` 一个一个等，峰值只会是 1；并发下发时峰值才会上去。
 */
function trackingDeps(table: Record<string, CommandResult>, found: (name: string) => boolean) {
  const commands: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const step = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
  };
  return {
    commands,
    peak: () => peak,
    deps: {
      run: async (cmd: string, args: string[]): Promise<CommandResult> => {
        const key = [cmd, ...args].join(" ");
        commands.push(key);
        await step();
        for (const [pattern, result] of Object.entries(table)) {
          if (key.startsWith(pattern)) return result;
        }
        return { code: 127, stdout: "", stderr: "not found" };
      },
      exists: async (name: string) => {
        commands.push(`exists:${name}`);
        await step();
        return found(name);
      },
    } satisfies ToolDeps,
  };
}

describe("导出工具链探测（T5-4）", () => {
  it("本机实况：pandoc 有 epub3/docx/pdf，但没有任何 PDF 引擎 ⇒ pdf 判不可用", async () => {
    const tooling = await probeExportTooling({
      ...fake({
        "pandoc --version": { code: 0, stdout: "pandoc.exe 2.10\nCompiled with texmath", stderr: "" },
        "pandoc --list-output-formats": {
          code: 0,
          stdout: "docx\nepub\nepub2\nepub3\nhtml5\npdf\n",
          stderr: "",
        },
      }),
      // 引擎一个都没有
      exists: async () => false,
    });
    expect(tooling.pandocVersion).toBe("2.10");
    expect(tooling.pandocOutputFormats).toContain("epub3");
    expect(tooling.pdfEngines).toEqual([]);
    expect(tooling.epubCheckAvailable).toBe(false);
  });

  it("装了 xelatex 与 epubcheck jar ⇒ 引擎与质检都记上（java 在但 jar 不在 ⇒ 仍不可用）", async () => {
    const tooling = await probeExportTooling({
      ...fake({
        "pandoc --version": { code: 0, stdout: "pandoc.exe 3.1.13", stderr: "" },
        "pandoc --list-output-formats": { code: 0, stdout: "epub3\ndocx\npdf\n", stderr: "" },
        "java -version": { code: 0, stdout: 'openjdk version "17.0.9"', stderr: "" },
      }),
      exists: async (name) => name === "xelatex" || name.endsWith("epubcheck.jar"),
    });
    expect(tooling.pdfEngines).toEqual(["xelatex"]);
    expect(tooling.epubCheckAvailable).toBe(true);
  });

  it("完全没有 pandoc ⇒ 版本 null、格式表空（txt 仍可用由 assessExportFormats 判）", async () => {
    const tooling = await probeExportTooling({
      run: async () => ({ code: 127, stdout: "", stderr: "not found" }),
      exists: async () => false,
    });
    expect(tooling.pandocVersion).toBeNull();
    expect(tooling.pandocOutputFormats).toEqual([]);
  });

  it("探测并发下发（串行排队会把打开导出页变成秒级等待）", async () => {
    const rec = trackingDeps(
      {
        "pandoc --version": { code: 0, stdout: "pandoc.exe 2.10", stderr: "" },
        "pandoc --list-output-formats": { code: 0, stdout: "epub3\ndocx\npdf\n", stderr: "" },
      },
      () => false,
    );
    await probeExportTooling(rec.deps);
    // 两条 pandoc + 七个引擎存在性 + jar 存在性 = 十条外部询问
    expect(rec.commands.length).toBeGreaterThanOrEqual(10);
    // 峰值 ≥ 9：十条全部并发时峰值是 10；哪怕只把两条 pandoc 串起来也会掉到 7。
    // 逐个 await 的写法峰值恒为 1（v188 前的实现就是 1，实测整轮 1853ms）。
    expect(rec.peak()).toBeGreaterThanOrEqual(9);
  });

  it("jar 不在 ⇒ 连 java 都不必探测（运行时在不在都变不出 jar）", async () => {
    const noJar = trackingDeps(
      {
        "pandoc --version": { code: 0, stdout: "pandoc.exe 2.10", stderr: "" },
        "pandoc --list-output-formats": { code: 0, stdout: "epub3\n", stderr: "" },
        "java -version": { code: 0, stdout: 'openjdk version "17.0.9"', stderr: "" },
      },
      () => false,
    );
    const tooling = await probeExportTooling(noJar.deps);
    expect(tooling.epubCheckAvailable).toBe(false);
    expect(noJar.commands.filter((c) => c.startsWith("java"))).toEqual([]);

    const withJar = trackingDeps(
      {
        "pandoc --version": { code: 0, stdout: "pandoc.exe 2.10", stderr: "" },
        "pandoc --list-output-formats": { code: 0, stdout: "epub3\n", stderr: "" },
        "java -version": { code: 0, stdout: 'openjdk version "17.0.9"', stderr: "" },
      },
      (name) => name.toLowerCase().endsWith(".jar"),
    );
    const second = await probeExportTooling(withJar.deps);
    expect(second.epubCheckAvailable).toBe(true);
    expect(withJar.commands.some((c) => c.startsWith("java"))).toBe(true);
  });
});

describe("探测缓存（T5-4）", () => {
  const tooling = {
    pandocVersion: "2.10",
    pandocOutputFormats: ["epub3"],
    pdfEngines: [],
    epubCheckAvailable: false,
  };

  it("成功只探一次：外部命令不随预览次数重复下发", async () => {
    let calls = 0;
    const next = onceTooling(async () => {
      calls += 1;
      return tooling;
    });
    await next();
    await next();
    await next();
    expect(calls).toBe(1);
  });

  it("失败的探测不进缓存：一次抖动不会让「探测失败」永久挂在面板上", async () => {
    let calls = 0;
    const next = onceTooling(async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn EACCES 模拟");
      return tooling;
    });
    await expect(next()).rejects.toThrow("spawn EACCES 模拟");
    // 第二次必须**重新下发**，而不是把上一轮的拒绝结果再端出来一遍
    const result = await next();
    expect(result.pandocVersion).toBe("2.10");
    expect(calls).toBe(2);
  });
});

describe("Pandoc 转换与 EPUB 门禁（T5-4）", () => {
  // 刻意照本机实况：pandoc 认 pdf，但没有任何 PDF 引擎 ⇒ 该格式判不可用
  const tooling = {
    pandocVersion: "2.10",
    pandocOutputFormats: ["epub3", "docx", "pdf"],
    pdfEngines: [],
    epubCheckAvailable: true,
  };

  it("请求一个本机产不出的格式 ⇒ 直接拒，且一次命令都不下发", async () => {
    let calls = 0;
    const result = await convertWithPandoc(
      { run: async () => { calls += 1; return { code: 0, stdout: "", stderr: "" }; }, exists: async () => false },
      { tooling, sourcePath: "exports/book.md", targetPath: "exports/book.pdf", format: "pdf", title: "天启界" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("引擎");
    expect(calls).toBe(0);
  });

  it("可用格式：按 epub3 下发命令并回报产物路径", async () => {
    const seen: string[][] = [];
    const result = await convertWithPandoc(
      {
        run: async (cmd, args) => {
          seen.push([cmd, ...args]);
          return { code: 0, stdout: "", stderr: "" };
        },
        exists: async () => false,
      },
      { tooling, sourcePath: "exports/book.md", targetPath: "exports/book.epub", format: "epub", title: "天启界" },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("book.epub");
    // 必须显式要 epub3：不带参数的话 pandoc 默认可能给 epub2，而目标格式写的是 3.3
    expect(seen[0]?.join(" ")).toContain("epub3");
  });

  it("pandoc 非零退出 ⇒ 失败并把 stderr 原文带回去（不吞错误）", async () => {
    const result = await convertWithPandoc(
      {
        run: async () => ({ code: 84, stdout: "", stderr: "could not fetch stylesheet" }),
        exists: async () => false,
      },
      { tooling, sourcePath: "a.md", targetPath: "a.docx", format: "docx", title: "天启界" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not fetch stylesheet");
  });

  it("EPUBCheck 未就位 ⇒ ran=false，门禁理由是「未校验」而不是通过", async () => {
    const report = await validateEpub(
      { run: async () => ({ code: 0, stdout: "", stderr: "" }), exists: async () => false },
      { tooling: { ...tooling, epubCheckAvailable: false }, epubPath: "exports/book.epub" },
    );
    expect(report.ran).toBe(false);
    expect(report.skippedReason).toContain("EPUBCheck");
  });

  it("EPUBCheck 报错 ⇒ 计数与原文消息都带回来（门禁指认得出具哪一条）", async () => {
    const report = await validateEpub(
      {
        run: async () => ({
          code: 1,
          stdout: 'ERROR: OPF0013: attribute "version" must be "3.3"\nCheck finished with errors : 1',
          stderr: "",
        }),
        exists: async () => false,
      },
      { tooling, epubPath: "exports/book.epub" },
    );
    expect(report).toMatchObject({ ran: true, parsed: true, errors: 1 });
    expect(report.messages[0]).toContain("OPF0013");
  });
});
