/* SPDX-License-Identifier: Apache-2.0 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { assessExportFormats, interpretEpubCheck, PDF_ENGINES, type EpubCheckReport, type ExportFormat, type ExportTooling } from "@yushu/export";

/**
 * 导出工具链的探测与调用（M5 / T5-4 第一段，R87）。
 *
 * 探测与转换都收进这一个模块、且**可注入**，是为了让"这台机器上到底有什么"变成能单测的事实：
 * 真实 `spawn` 只在主进程用，测试喂假命令表。三条要紧的口径：
 * ① 探测照实——pandoc 不在就是不在，不许拿"应该装了"当事实；
 * ② `convertWithPandoc` 对**本机产不出的格式直接拒**，绝不"退而求其次产出 TXT"：
 *    用户要 EPUB，给一个改了名的 `.txt` 是最坏的那种静默降级（比报错坏，因为它看起来成功了）；
 * ③ EPUBCheck 不在 ⇒ `ran:false`，门禁结论是"未校验"，不是"通过"。
 *
 * 本机第 87 轮实测：pandoc 2.10 认 `pdf` 输出格式，但 `pdflatex / xelatex / lualatex /
 * weasyprint / wkhtmltopdf / typst / tectonic` 一个都没装 ⇒ PDF 判不可用，
 * 而 EPUB 3.3 与 DOCX 可用（pandoc 原生写出，不需要外部引擎）。
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ToolDeps {
  /** 执行一条命令并取回结果（测试注入假表） */
  run: (cmd: string, args: string[]) => Promise<CommandResult>;
  /** 某个可执行文件 / 文件是否存在（引擎名或 jar 路径） */
  exists: (name: string) => Promise<boolean>;
}

/**
 * EPUBCheck jar 的位置：环境变量 `YUSHU_EPUBCHECK_JAR` 优先，
 * 没配就按字面量 `epubcheck.jar` 去查（本机没装 ⇒ 查不到 ⇒ 判"未就位"，不猜）。
 */
export const EPUBCHECK_JAR_ENV = "YUSHU_EPUBCHECK_JAR";
export function epubCheckJarPath(): string {
  return process.env[EPUBCHECK_JAR_ENV] ?? "epubcheck.jar";
}

/** pandoc 输出格式 → 我们请求的具体 writer（EPUB 必须显式 epub3，默认可能是 epub2） */
const WRITER_BY_FORMAT: Record<Exclude<ExportFormat, "txt">, string> = {
  epub: "epub3",
  docx: "docx",
  pdf: "pdf",
};

export async function probeExportTooling(deps: ToolDeps): Promise<ExportTooling> {
  // 一次探测要问外部十几件事（两条 pandoc + 七个引擎存在性 + jar 存在性）。
  // 串行排队实测 ~1.9s，会把"打开导出页"变成一件慢事，所以全部并发下发；
  // java 是唯一留到后面的：jar 不在就没必要问运行时（见下）。
  const [version, formats, engineFlags, jarOk] = await Promise.all([
    deps.run("pandoc", ["--version"]),
    deps.run("pandoc", ["--list-output-formats"]),
    Promise.all(PDF_ENGINES.map((engine) => deps.exists(engine))),
    deps.exists(epubCheckJarPath()),
  ]);

  const match = /pandoc(?:\.exe)?\s+(\d[^\s]*)/i.exec(version.stdout);
  const pandocVersion = version.code === 0 && match ? match[1]! : null;

  const pandocOutputFormats: string[] =
    formats.code === 0
      ? formats.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "")
      : [];

  const pdfEngines = PDF_ENGINES.filter((_, index) => engineFlags[index] === true);

  // EPUBCheck = jar + Java 运行时两件事，缺一个就是"没就位"（不猜"应该有"）
  const javaOk = jarOk ? (await deps.run("java", ["-version"])).code === 0 : false;
  return { pandocVersion, pandocOutputFormats, pdfEngines, epubCheckAvailable: jarOk && javaOk };
}

/**
 * 进程内"只探一次"的包装（R87）。
 *
 * 探测要 spawn 十条外部命令，每次打开导出页都重跑一遍不值当；但**失败的探测不能留在缓存里**——
 * 一次 `EACCES` 抖动就把"探测失败"永久挂在面板上，比慢更难查。
 * 缓存的是**探测**（外部事实），判定 `assessExportFormats` 每次都重算：
 * 把判定也缓存进去，将来判定逻辑改了会拿旧结论冒充新逻辑。
 */
/** 可重探的探测入口：`next()` 拿缓存结果，`next.reset()` 让下一次重新下发 */
export interface ToolingProbe {
  (): Promise<ExportTooling>;
  reset: () => void;
}

/**
 * 进程内"只探一次"的包装（R87，reset 由 R92 补）。
 *
 * 探测要 spawn 十条外部命令，每次打开导出页都重跑一遍不值当；但**失败的探测不能留在缓存里**——
 * 一次 `EACCES` 抖动就把"探测失败"永久挂在面板上，比慢更难查。
 * `reset()` 解决另一半：作者**装了 PDF 引擎之后不必重启应用**，点一次「重新核对」就能刷新结论。
 * 缓存的是**探测**（外部事实），判定 `assessExportFormats` 每次都重算——
 * 把判定也缓存进去，将来判定逻辑改了会拿旧结论冒充新逻辑。
 */
export function onceTooling(fetch: () => Promise<ExportTooling>): ToolingProbe {
  let cache: Promise<ExportTooling> | null = null;
  const next = (() => {
    if (cache === null) {
      cache = fetch().catch((err: unknown) => {
        cache = null;
        throw err;
      });
    }
    return cache;
  }) as ToolingProbe;
  next.reset = () => {
    cache = null;
  };
  return next;
}

/** 真实命令表：主进程用；Windows 上 `where` 查可执行文件，jar 走文件存在性 */
export function realToolDeps(): ToolDeps {
  return {
    run: (cmd, args) =>
      new Promise<CommandResult>((resolve) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (err: NodeJS.ErrnoException) =>
          resolve({ code: err.code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(err.message ?? err) }),
        );
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      }),
    // 必须是非阻塞 spawn：spawnSync 会把主进程事件循环按住，七次串行就是几百毫秒的"整个应用卡住"，
    // 并发也只有 spawn 才并发得起来。
    exists: (name) =>
      new Promise<boolean>((resolve) => {
        if (name.toLowerCase().endsWith(".jar")) {
          resolve(existsSync(name));
          return;
        }
        const probe = spawn(process.platform === "win32" ? "where" : "which", [name], { windowsHide: true });
        probe.stdout.on("data", () => undefined);
        probe.on("error", () => resolve(false));
        probe.on("close", (code) => resolve(code === 0));
      }),
  };
}

export interface ConvertRequest {
  tooling: ExportTooling;
  /** 源文件（本项目导出的 Markdown） */
  sourcePath: string;
  targetPath: string;
  format: ExportFormat;
  title: string;
  /**
   * 要不要目录。卷是 `#`、章是 `##`（见 R89 的 `buildMarkdown`），
   * 所以 `--toc-depth` 必须到 2，否则 EPUB / DOCX 的目录只剩卷一级。
   */
  toc?: boolean;
}

export interface ConvertResult {
  ok: boolean;
  message: string;
}

/** 用 pandoc 转换；**本机产不出的格式直接拒，一次命令都不下发** */
export async function convertWithPandoc(
  deps: ToolDeps,
  request: ConvertRequest,
): Promise<ConvertResult> {
  if (request.format === "txt") {
    return { ok: true, message: "TXT 由御书自己装配，不需要 pandoc" };
  }
  const assessment = assessExportFormats(request.tooling).find((item) => item.format === request.format);
  if (!assessment || !assessment.available) {
    return {
      ok: false,
      message: `不产出 ${request.format.toUpperCase()}：${assessment?.reason ?? "未知原因"}（不会退而求其次给别的格式）`,
    };
  }
  const result = await deps.run("pandoc", [
    "--standalone",
    "--metadata",
    `title=${request.title}`,
    "--from",
    "markdown",
    "--to",
    WRITER_BY_FORMAT[request.format],
    // 目录由 pandoc 生成（R89 的源装配刻意不手搓目录，两边合起来才只有一份目录）
    ...(request.toc ? ["--toc", "--toc-depth=2"] : []),
    request.sourcePath,
    "--output",
    request.targetPath,
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `pandoc 退出码 ${result.code}：${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    };
  }
  return { ok: true, message: `已产出 ${request.targetPath}（pandoc ${request.tooling.pandocVersion} → ${WRITER_BY_FORMAT[request.format]}）` };
}

/** 跑 EPUBCheck；未就位时如实返回 `ran:false`，不假装通过 */
export async function validateEpub(
  deps: ToolDeps,
  options: { tooling: ExportTooling; epubPath: string },
): Promise<EpubCheckReport> {
  if (!options.tooling.epubCheckAvailable) {
    return interpretEpubCheck("", { available: false });
  }
  const jar = epubCheckJarPath();
  const result = await deps.run("java", ["-jar", jar, options.epubPath]);
  return interpretEpubCheck(`${result.stdout}\n${result.stderr}`, { available: true });
}
