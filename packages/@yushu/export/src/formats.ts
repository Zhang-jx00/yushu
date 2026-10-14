/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 导出格式能力判定与 EPUB 质量门禁（M5 / T5-4 第一段；纯函数，不碰 fs / 不起进程）。
 *
 * 这个模块存在的理由只有一条：**"这台机器能不能产出这个格式"必须是问出来的事实**。
 * 第 87 轮在本机实测到的是一个很容易被骗的组合：
 * `pandoc 2.10 --list-output-formats` 里 `pdf` 明明白白在列，
 * 但 `pdflatex / xelatex / lualatex / weasyprint / wkhtmltopdf / typst / tectonic` **一个都没装**
 * ——pandoc 的"支持 pdf"只是"知道怎么调外部引擎"，没有引擎就产不出 PDF。
 * 照它的格式表报能力，PDF 会被标成可用，用户点下去得到的是一次失败或一个空文件。
 *
 * 三条口径：
 * ① 不可用必须点名**缺什么**（缺 pandoc / 缺该输出格式 / 缺 PDF 引擎，引擎列名）；
 * ② EPUB"能不能产出"与"有没有质检"是两件事：EPUBCheck 不在时导出仍可发生，
 *    但门禁结论必须是**未校验**——"没跑检查"永远不等于"检查通过"；
 * ③ 读不懂 EPUBCheck 的输出 ⇒ `parsed:false`，门禁同样不通过（解析失败不等于没问题）。
 */

export const EXPORT_FORMATS = ["txt", "epub", "docx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** pandoc 产出 PDF 时要调的外部引擎；本机一个都没有（第 87 轮实测） */
export const PDF_ENGINES: readonly string[] = [
  "pdflatex",
  "xelatex",
  "lualatex",
  "weasyprint",
  "wkhtmltopdf",
  "typst",
  "tectonic",
];

/** 宿主探测到的工具链现状（探测由主进程做，这里只做判定） */
export interface ExportTooling {
  /** `pandoc --version` 的首行版本号；没装为 null */
  pandocVersion: string | null;
  /** `pandoc --list-output-formats` 的输出 */
  pandocOutputFormats: readonly string[];
  /** 实际探测到的 PDF 引擎（列名即存在） */
  pdfEngines: readonly string[];
  /** EPUBCheck 是否就位（jar + java） */
  epubCheckAvailable: boolean;
}

export interface FormatAssessment {
  format: ExportFormat;
  available: boolean;
  /** 可用：靠什么产出；不可用：缺什么（点名到具体） */
  reason: string;
}

function needs(format: string, tooling: ExportTooling): boolean {
  return tooling.pandocVersion !== null && tooling.pandocOutputFormats.includes(format);
}

/** 逐格式判定；顺序与 `EXPORT_FORMATS` 一致（面板按这个顺序渲染，不许漂） */
export function assessExportFormats(tooling: ExportTooling): FormatAssessment[] {
  const hasPandoc = tooling.pandocVersion !== null;
  const engines = PDF_ENGINES.join(" / ");

  const txt: FormatAssessment = {
    format: "txt",
    available: true,
    reason: "TXT 由御书自己装配（章序 + 字数对账），不经 Pandoc，因此与 Pandoc 在不在无关",
  };

  const epub: FormatAssessment = hasPandoc
    ? needs("epub3", tooling)
      ? {
          format: "epub",
          available: true,
          reason: `Pandoc ${tooling.pandocVersion} 支持 epub3 ⇒ 按 EPUB 3.3 产出（epub2 不用：目标格式写的是 3.3，拿 2 冒充是把降级说成达成）`,
        }
      : {
          format: "epub",
          available: false,
          reason: `Pandoc 的输出格式表里没有 epub3（只有 ${tooling.pandocOutputFormats.join(", ") || "空"}）`,
        }
    : { format: "epub", available: false, reason: "未检测到 pandoc，EPUB 无法产出" };

  const docx: FormatAssessment = hasPandoc
    ? needs("docx", tooling)
      ? { format: "docx", available: true, reason: `Pandoc ${tooling.pandocVersion} 支持 docx（原生写出，不需要外部引擎）` }
      : { format: "docx", available: false, reason: "Pandoc 的输出格式表里没有 docx" }
    : { format: "docx", available: false, reason: "未检测到 pandoc，DOCX 无法产出" };

  let pdf: FormatAssessment;
  if (!hasPandoc) {
    pdf = { format: "pdf", available: false, reason: "未检测到 pandoc，PDF 无法产出" };
  } else if (!needs("pdf", tooling)) {
    pdf = { format: "pdf", available: false, reason: "Pandoc 的输出格式表里没有 pdf" };
  } else if (tooling.pdfEngines.length === 0) {
    // 这就是本机实况：pandoc 认得 pdf，但它只是知道怎么调引擎
    pdf = {
      format: "pdf",
      available: false,
      reason: `pandoc 认 pdf，但产出要调外部引擎，本机一个都没装（找过：${engines}）；装上任一引擎后即可用`,
    };
  } else {
    pdf = {
      format: "pdf",
      available: true,
      reason: `Pandoc + 引擎 ${[...tooling.pdfEngines].sort().join(" / ")}（中文正文建议 xelatex + CJK 字体，否则可能掉字）`,
    };
  }

  const byFormat = new Map<ExportFormat, FormatAssessment>([
    ["txt", txt],
    ["epub", epub],
    ["docx", docx],
    ["pdf", pdf],
  ]);
  return EXPORT_FORMATS.map((format) => byFormat.get(format)!);
}

export interface EpubCheckReport {
  /** 真的跑过检查吗（EPUBCheck 不在 ⇒ false，此时任何"通过"都不成立） */
  ran: boolean;
  /** 输出读得懂吗（既没有汇总行也没有错误行 ⇒ false） */
  parsed: boolean;
  fatalErrors: number;
  errors: number;
  warnings: number;
  /** 原文错误/致命行（门禁要能指认是哪一条） */
  messages: string[];
  /** 没跑成的原因（ran=false 时必填） */
  skippedReason: string | null;
}

/**
 * 解读 EPUBCheck 的输出。
 *
 * 计数只认**行首标记**与官方汇总行 `Check finished with errors : N`；
 * 两者都读不到 ⇒ `parsed:false`。为什么宁可判"读不懂"也不判"0 error"：
 * 把"没解析出来"当成"没问题"，是这一路与"静默截断的 SSE"完全同源的错误。
 */
export function interpretEpubCheck(
  output: string,
  options: { available: boolean },
): EpubCheckReport {
  if (!options.available) {
    return {
      ran: false,
      parsed: false,
      fatalErrors: 0,
      errors: 0,
      warnings: 0,
      messages: [],
      skippedReason: "EPUBCheck 未就位（需要 epubcheck jar + Java）⇒ 本次未校验",
    };
  }
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const messages: string[] = [];
  let fatalErrors = 0;
  let errors = 0;
  let warnings = 0;
  let sawSummary = false;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("fatal")) {
      fatalErrors += 1;
      messages.push(line);
      continue;
    }
    if (lower.startsWith("error:")) {
      errors += 1;
      messages.push(line);
      continue;
    }
    if (lower.startsWith("warning:")) {
      warnings += 1;
      continue;
    }
    const summary = /check finished with errors\s*:\s*(\d+)/i.exec(line);
    if (summary) {
      sawSummary = true;
      const reported = Number(summary[1]);
      // 汇总行是权威值：行首计数可能因为换行/前缀差异而漏，取两者较大值不至于少报
      if (Number.isFinite(reported) && reported > errors + fatalErrors) {
        errors = reported;
      }
    }
  }
  return {
    ran: true,
    parsed: sawSummary || messages.length > 0,
    fatalErrors,
    errors,
    warnings,
    messages,
    skippedReason: null,
  };
}

export interface EpubGateResult {
  passed: boolean;
  reason: string;
}

/** EPUB 质量门禁：只有"真跑过、读得懂、0 fatal 0 error"才算通过 */
export function epubGatePassed(report: EpubCheckReport): EpubGateResult {
  if (!report.ran) {
    return { passed: false, reason: `未校验：${report.skippedReason ?? "EPUBCheck 没跑"}` };
  }
  if (!report.parsed) {
    return { passed: false, reason: "EPUBCheck 输出读不懂（既无汇总行也无错误行）⇒ 不判通过" };
  }
  if (report.fatalErrors > 0 || report.errors > 0) {
    return {
      passed: false,
      reason: `EPUBCheck 拦下：${report.fatalErrors} fatal / ${report.errors} error（首条：${report.messages[0] ?? "—"}）`,
    };
  }
  return { passed: true, reason: `EPUBCheck 通过（0 fatal / 0 error${report.warnings > 0 ? `，${report.warnings} warning 仅提示` : ""}）` };
}
