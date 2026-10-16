/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { YushuError } from "@yushu/core";
import { detectPlaintextSecrets, redactPlaintextSecrets } from "@yushu/llm";
import type {
  ProjectExportExcludedPayload,
  ProjectExportPreviewPayload,
  ProjectExportRedactionPayload,
  ProjectExportRunPayload,
  ProjectExportRunResult,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { exportTargets, ExportTargetGate } from "./export-gate.js";
import { sanitizeFileName } from "./export-ops.js";
import { getWorldSummary } from "./project-ops.js";

/**
 * 项目迁移包导出（M3 / T3-14 后半的调用点，R101）。
 *
 * T3-14 的任务文本要的是"导入或导出项目时自动剔除密钥"。检测与剥离两个函数早就在位
 * （`@yushu/llm` 的 `detectPlaintextSecrets` / `redactPlaintextSecrets`，后者是 R59 ② 为
 * v1→v2 迁移备份加的），**缺的一直是调用点**——台账里此前多处把这个函数误写成不存在的
 * `stripSecrets`（R101 已回源纠正）。这一层就是那个调用点。
 *
 * 三条安全判据，每条都有会红的用例：
 * ① 派生物 `.yushu/**`（索引库 + **密文库 `secrets.json`**）整棵不进包，`exports/**` 与冲突旁路文件同理，
 *    且每条跳过都要给理由——静默少文件与静默多文件一样坏；
 * ② 文本真源里若有疑似明文密钥，**写出前**就地剥离（`redactPlaintextSecrets` 把值换成注释，
 *    保住结构可回滚，不复制第二份明文）；
 * ③ 全部落盘后**再复扫一遍**：仍检得出明文 ⇒ 整包删除并抛 `E_EXPORT_SECRET_RESIDUE`。
 *    第三条是纵深防御——它防的是"①②里某条以后被改坏"，所以它的红恰恰证明锁有效。
 *
 * 目标目录只能凭票据解析（见 `export-gate.ts`）：**路径不出主进程**，否则任何注入进渲染层的
 * 代码都能拿这条通道往 `~` 或别的项目里写文件。包里也不写绝对路径（迁移包会被发给别人）。
 */

/** 会被读成文本并按密钥规则处理的后缀 */
const TEXT_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".json", ".toml", ".txt", ".csv", ".css", ".html"];

/** 冲突旁路文件（`index-input.ts` 的 CONFLICT_SIDECAR_RE 语义；这里按文件名规则跳，不进包） */
const SIDECAR_RE = /\.conflict-[^/]*\.md$/;

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_SUFFIXES.includes(path.slice(dot).toLowerCase());
}

/**
 * 这一个路径为什么不进包；返回 null 表示要进。
 *
 * 导出给测试钉第二道闸：`listTree` 本来就把 `.yushu/` 滤掉了，但"密文库不进迁移包"这条
 * 安全性质不该只靠上游的一处过滤成立——这里显式再拦一次，上游哪天改了也会红在测试上。
 */
export function exportSkipReason(path: string, includeExports: boolean): string | null {
  if (path === ".yushu" || path.startsWith(".yushu/")) {
    return "派生数据（索引库 / 密文库 / 快照）不随包走：接收方按自己的机器重建，密钥请各自重新录入";
  }
  if (path.startsWith("exports/")) {
    return includeExports ? null : "导出物是派生物（包外另给），默认不重复装进迁移包";
  }
  if (SIDECAR_RE.test(path)) return "外部改动冲突的旁路文件（`.conflict-*.md`），保留在项目里供人工比对，不进迁移包";
  if (path === ".gitignore" || path === ".gitattributes") return null;
  return null;
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

interface Collected {
  files: Array<{ path: string; bytes: number; text: boolean }>;
  excluded: ProjectExportExcludedPayload[];
  redactions: ProjectExportRedactionPayload[];
  unreadable: ProjectExportExcludedPayload[];
}

/** 遍历项目、分类、并按 K12 预算出"要剥几条"（预览与落笔共用同一次遍历口径） */
async function collect(gateway: ProjectGateway, includeExports: boolean): Promise<Collected> {
  const tree = await gateway.listTree();
  const files: Collected["files"] = [];
  const excluded: ProjectExportExcludedPayload[] = [];
  const unreadable: ProjectExportExcludedPayload[] = [];
  const redactions: ProjectExportRedactionPayload[] = [];

  for (const entry of tree.filter((item) => item.type === "file")) {
    const reason = exportSkipReason(entry.path, includeExports);
    if (reason !== null) {
      excluded.push({ path: entry.path, reason });
      continue;
    }
    let content: string;
    try {
      content = (await gateway.readDoc(entry.path)).content;
    } catch (err) {
      // 读不出来的文件不假装带上了：点名跳过并给原因（二进制 / 超大）
      unreadable.push({
        path: entry.path,
        reason: `读不出文本内容（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）：请手动复制这类资源文件`,
      });
      continue;
    }
    const text = isTextPath(entry.path);
    files.push({ path: entry.path, bytes: Buffer.byteLength(content, "utf8"), text });
    if (text) {
      const hits = detectPlaintextSecrets(content);
      if (hits.length > 0) redactions.push({ path: entry.path, count: hits.length });
    }
  }
  return { files, excluded, redactions, unreadable };
}

/** 迁移包预览（只读，一个字节都不写） */
export async function previewProjectExport(
  gateway: ProjectGateway,
  options: { includeExports?: boolean } = {},
): Promise<ProjectExportPreviewPayload> {
  const world = await getWorldSummary(gateway);
  const collected = await collect(gateway, options.includeExports === true);
  const totalBytes = collected.files.reduce((sum, row) => sum + row.bytes, 0);
  const redactedTotal = collected.redactions.reduce((sum, row) => sum + row.count, 0);
  return {
    bookTitle: world?.title ?? "",
    files: collected.files.map(({ path, bytes }) => ({ path, bytes })),
    totalBytes,
    excluded: collected.excluded,
    unreadable: collected.unreadable,
    redactions: collected.redactions,
    note:
      "密钥不随包走：`.yushu/`（含密文库 `secrets.json`）整棵排除；配置里若有疑似明文密钥，写出前就地剥离 " +
      (redactedTotal > 0 ? `（本次将剥离 ${String(redactedTotal)} 处）` : "（本次没有要剥的）") +
      "。接收方需在自己机器上重新录入 API Key——包里没有可导出的主密钥。",
  };
}

/** 可注入面：票据闸门、时钟、剥离实现（测试用它演"剥不干净就不交付"那条） */
export interface ProjectExportDeps {
  gate?: ExportTargetGate;
  now?: () => Date;
  redact?: (text: string) => { text: string; redacted: number };
}

function buildManifest(input: {
  bookTitle: string;
  createdAt: string;
  files: number;
  bytes: number;
  redacted: number;
  skipped: number;
  unreadable: number;
}): string {
  const lines: string[] = [
    "# 御书项目迁移包清单（MANIFEST）",
    `book_title: "${input.bookTitle.replace(/"/g, '\\"')}"`,
    `created_at: "${input.createdAt}"`,
    `files: ${String(input.files)}`,
    `bytes: ${String(input.bytes)}`,
    `secret_redactions: ${String(input.redacted)}`,
    `skipped_derived: ${String(input.skipped)}`,
    `unreadable_skipped: ${String(input.unreadable)}`,
    "format: yushu-project-bundle/1",
    "notes:",
    "  - 真源是 Markdown 与 YAML，可用任何编辑器直接打开；御书也能直接读这个目录。",
    "  - 包里没有 `.yushu/`（索引库、快照、密文库都是派生物），接收方打开后重建索引即可。",
    "  - 包里没有 API Key：`config/llm.yaml` 只带 `api_key_env` / `key_ref`；如有历史明文值已在写出前剥离。",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * 导出迁移包（写盘）。三道闸：没确认 ⇒ 拒；票据无效 / 过期 ⇒ 拒；
 * 目标子目录已存在 ⇒ 拒（不覆盖）；写完复扫仍检出明文 ⇒ **整包删除**并报错。
 */
export async function runProjectExport(
  gateway: ProjectGateway,
  payload: ProjectExportRunPayload,
  deps: ProjectExportDeps = {},
): Promise<ProjectExportRunResult> {
  if (payload.confirmed !== true) {
    throw new YushuError(
      "E_CONFIRM_REQUIRED",
      "导出迁移包前需显式确认：请先核对文件数、被剥离的密钥处数与被跳过的派生文件，再点击「导出迁移包」",
    );
  }
  const gate = deps.gate ?? exportTargets;
  const now = deps.now ?? (() => new Date());
  const redact = deps.redact ?? redactPlaintextSecrets;
  const target = gate.resolve(payload.ticket);

  const preview = await previewProjectExport(gateway, { includeExports: payload.includeExports === true });
  const createdAt = now();
  const subdir = `${sanitizeFileName(preview.bookTitle === "" ? "yushu-project" : preview.bookTitle)}-迁移包-${stamp(createdAt)}`;
  const root = join(target, subdir);
  if (existsSync(root)) {
    throw new YushuError(
      "E_EXPORT_TARGET_EXISTS",
      `目标目录里已经有「${subdir}」：不覆盖既有导出（换个目录，或等下一分钟再导一次）`,
    );
  }

  const collected = await collect(gateway, payload.includeExports === true);
  let written = 0;
  let bytes = 0;
  let redacted = 0;
  let plaintextRemaining = 0;

  try {
    await mkdir(root, { recursive: true });
    for (const file of collected.files) {
      const content = (await gateway.readDoc(file.path)).content;
      const handled = file.text ? redact(content) : { text: content, redacted: 0 };
      redacted += handled.redacted;
      const abs = join(root, ...file.path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, handled.text, "utf8");
      written += 1;
      bytes += Buffer.byteLength(handled.text, "utf8");
    }

    const manifest = buildManifest({
      bookTitle: preview.bookTitle,
      createdAt: createdAt.toISOString(),
      // `files` 数的是**真源文件**（此刻还没算 MANIFEST 自己）；回执的 `files` 是"总共写出的文件数（含清单）"。
      // 两个口径都写在纸上，step62 与桌面测试各核一次：对不上就是有一处数错文件。
      files: written,
        bytes,
        redacted,
        skipped: preview.excluded.length,
        unreadable: preview.unreadable.length,
    });
    await writeFile(join(root, "MANIFEST.yaml"), manifest, "utf8");
    written += 1;
    bytes += Buffer.byteLength(manifest, "utf8");

    // ③ 复扫：落盘字节里再检一次（防的是"①②以后被谁改坏了"，不是现在的自己）
    for (const file of collected.files) {
      if (!file.text) continue;
      const back = await readFileSafe(join(root, ...file.path.split("/")));
      plaintextRemaining += detectPlaintextSecrets(back).length;
    }
    if (plaintextRemaining > 0) {
      throw new YushuError(
        "E_EXPORT_SECRET_RESIDUE",
        `复扫仍检出 ${String(plaintextRemaining)} 处疑似明文密钥：整包已删除，不交付（请把该文件里的密钥改成 api_key_env / key_ref 后再导）`,
      );
    }
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    subdir,
    bookTitle: preview.bookTitle,
    createdAt: createdAt.toISOString(),
    files: written,
    bytes,
    redacted,
    plaintextRemaining,
    skippedDerived: preview.excluded.length,
    unreadableSkipped: preview.unreadable.length,
  };
}

/** 复扫用的直读（不 import gateway 的读侧：这里要看的正是"盘上到底写了什么字节"） */
async function readFileSafe(abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}
