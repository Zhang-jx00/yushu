/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  assessExportFormats,
  interpretEpubCheck,
  epubGatePassed,
  type ExportTooling,
} from "../src/formats.js";

/**
 * 导出格式的能力判定与 EPUB 质量门禁（M5 / T5-4 第一段，纯函数）。
 *
 * 这一节存在的唯一理由：**"这台机器能不能产出这个格式"必须是问出来的事实，不是查表猜的**。
 * 本机实测（第 87 轮）：`pandoc 2.10` 的 `--list-output-formats` 里 epub3 / docx / pdf 都在，
 * 但 `pdflatex / xelatex / lualatex / weasyprint / wkhtmltopdf / typst / tectonic` **一个都没装**
 * ⇒ pandoc "支持 pdf" 只是"知道怎么调引擎"，没有引擎就产不出 PDF。
 * 如果按 pandoc 的格式表来报能力，PDF 会被标成可用，用户点下去得到的是一次失败或一个空文件。
 *
 * 三条口径：
 * ① 不可用必须说清**缺什么**（缺 pandoc / 缺该输出格式 / 缺 PDF 引擎，引擎列名）；
 * ② EPUB 的"能不能产出"与"有没有质检"是两件事——`epubCheckAvailable=false` 时
 *    导出仍然可以发生，但门禁结论必须是**未校验**，不能因为"没跑检查"就报"通过"；
 * ③ 读不懂 EPUBCheck 的输出 ⇒ `parsed:false`，门禁同样不通过（解析失败不等于没问题）。
 */

const full: ExportTooling = {
  pandocVersion: "2.10",
  pandocOutputFormats: ["epub", "epub2", "epub3", "docx", "pdf", "html5"],
  pdfEngines: ["xelatex"],
  epubCheckAvailable: true,
};

describe("导出能力判定（T5-4）", () => {
  it("工具齐全：四种格式都可用，txt 不走 pandoc 也要说明", () => {
    const map = new Map(assessExportFormats(full).map((item) => [item.format, item]));
    expect(map.get("txt")).toMatchObject({ available: true });
    expect(map.get("txt")!.reason).toContain("不经 Pandoc");
    expect(map.get("epub")).toMatchObject({ available: true });
    expect(map.get("epub")!.reason).toContain("epub3");
    expect(map.get("docx")!.available).toBe(true);
    expect(map.get("pdf")!.available).toBe(true);
  });

  it("本机实况：pandoc 支持 pdf 但没有引擎 ⇒ PDF 不可用，且原因点名找过哪些引擎", () => {
    const likeThisMachine: ExportTooling = { ...full, pdfEngines: [] };
    const pdf = assessExportFormats(likeThisMachine).find((item) => item.format === "pdf")!;
    expect(pdf.available).toBe(false);
    expect(pdf.reason).toContain("引擎");
    expect(pdf.reason).toContain("xelatex");
    // 其余三种不受影响：不能因为 PDF 缺引擎就把整条管线说成不可用
    const others = assessExportFormats(likeThisMachine).filter((item) => item.format !== "pdf");
    expect(others.every((item) => item.available)).toBe(true);
  });

  it("没有 pandoc：epub / docx / pdf 一律不可用并写明缺什么，txt 仍可用", () => {
    const none: ExportTooling = {
      pandocVersion: null,
      pandocOutputFormats: [],
      pdfEngines: [],
      epubCheckAvailable: false,
    };
    const list = assessExportFormats(none);
    expect(list.find((item) => item.format === "txt")!.available).toBe(true);
    for (const format of ["epub", "docx", "pdf"]) {
      const item = list.find((row) => row.format === format)!;
      expect(item.available, format).toBe(false);
      expect(item.reason, format).toContain("pandoc");
    }
  });

  it("pandoc 在但不认 epub3 ⇒ EPUB 不可用（不能拿 epub2 冒充 3.3）", () => {
    const old: ExportTooling = { ...full, pandocOutputFormats: ["epub", "docx", "pdf"] };
    const epub = assessExportFormats(old).find((item) => item.format === "epub")!;
    expect(epub.available).toBe(false);
    expect(epub.reason).toContain("epub3");
  });

  it("EPUB 可产出质检不可用 ⇒ 能力仍可用，但校验状态是「未校验」", () => {
    const noCheck: ExportTooling = { ...full, epubCheckAvailable: false };
    const epub = assessExportFormats(noCheck).find((item) => item.format === "epub")!
      .available;
    expect(epub).toBe(true);
    const report = interpretEpubCheck("", { available: false });
    expect(report).toMatchObject({ ran: false, parsed: false, skippedReason: expect.stringContaining("EPUBCheck") });
  });
});

describe("EPUBCheck 输出解读与门禁（T5-4）", () => {
  it("干净通过：0 error 0 fatal ⇒ 门禁通过", () => {
    const out = [
      "Checking EPUB file ...",
      "No checking done for file: mimetype",
      "Check finished with errors : 0",
    ].join("\n");
    const report = interpretEpubCheck(out, { available: true });
    expect(report).toMatchObject({ ran: true, parsed: true, fatalErrors: 0, errors: 0 });
    expect(epubGatePassed(report)).toEqual({ passed: true, reason: "EPUBCheck 通过（0 fatal / 0 error）" });
  });

  it("有 error ⇒ 门禁不通过，并把消息原文带回去（门禁要能指认是哪一条）", () => {
    const out = [
      'ERROR: OPF0013: attribute "version" in package element must be "3.1"',
      "Check finished with errors : 1",
    ].join("\n");
    const report = interpretEpubCheck(out, { available: true });
    expect(report.errors).toBe(1);
    expect(report.messages).toEqual([
      'ERROR: OPF0013: attribute "version" in package element must be "3.1"',
    ]);
    expect(epubGatePassed(report).passed).toBe(false);
  });

  it("有 fatal ⇒ 单独计数并判不通过（fatal 比 error 更该先修）", () => {
    const out = ["Fatal error: unable to open EPUB file", "Check finished with errors : 1"].join("\n");
    const report = interpretEpubCheck(out, { available: true });
    expect(report.fatalErrors).toBe(1);
    expect(epubGatePassed(report)).toMatchObject({ passed: false });
  });

  it("读不懂输出（没有汇总行也没有错误行）⇒ parsed=false 且门禁不通过", () => {
    const report = interpretEpubCheck("some unrelated java noise", { available: true });
    expect(report.parsed).toBe(false);
    expect(epubGatePassed(report)).toMatchObject({ passed: false, reason: expect.stringContaining("读不懂") });
  });

  it("未就位 ⇒ ran=false、门禁不通过且理由是「未校验」（没判的不能说成过了）", () => {
    const report = interpretEpubCheck("", { available: false });
    const gate = epubGatePassed(report);
    expect(gate.passed).toBe(false);
    expect(gate.reason).toContain("未校验");
  });

  it("只有 warning ⇒ 通过，但 warning 计数与消息保留（警告不拦导出，只是要看得见）", () => {
    const out = ["Warning: no metadata for author", "Check finished with errors : 0"].join("\n");
    const report = interpretEpubCheck(out, { available: true });
    expect(report).toMatchObject({ ran: true, parsed: true, warnings: 1, errors: 0 });
    expect(epubGatePassed(report).passed).toBe(true);
  });
});
