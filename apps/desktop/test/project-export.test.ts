/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import { createProject } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { ExportTargetGate } from "../src/main/export-gate.js";
import { exportSkipReason, previewProjectExport, runProjectExport } from "../src/main/project-export.js";

/**
 * 项目迁移包导出（M3 / T3-14 后半的调用点，R101）。
 *
 * T3-14 任务文本要的是"导入或导出项目时自动剔除密钥"。检测与剥离两个函数早就在位
 * （`detectPlaintextSecrets` / `redactPlaintextSecrets`），缺的是**调用点**——台账里此前多处
 * 把它写作一个并不存在的 `stripSecrets`（R101 已回源纠正）。这一层补的就是那个调用点，
 * 并把"密钥不随包走"钉成三条可红的判据：
 * ① 派生目录 `.yushu/**`（密文库 `secrets.json` 所在）整棵不进包；
 * ② 真源 `config/llm.yaml` 与它的历史备份里若有疑似明文密钥，**写出前先就地剥离**；
 * ③ 写完再**复扫一遍**落盘字节：仍检得出明文 ⇒ 整包删掉并报错（不许"已尽力"式交付）。
 *
 * 目标目录只能凭**票据**解析（同 R77 的导入闸门：路径不出主进程）。否则任何注入进渲染层的
 * 代码都能拿这条通道把文件写到 `~` 或别的项目里——那等于把红线 5 从背面拆掉。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽点密集"],
  romance_mode_default: "无女主",
};

/** 已知会被 K12 认出来的明文密钥形状 */
const PLAINTEXT_KEY = "sk-proj-abcdefghijklmnop1234567890ABCDEF";

let projectDir: string;
let outsideDir: string;
let gateway: ProjectGateway;
let gate: ExportTargetGate;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "yushu-pexp-proj-"));
  outsideDir = await mkdtemp(join(tmpdir(), "yushu-pexp-out-"));
  await createProject({ dir: projectDir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(projectDir);
  gate = new ExportTargetGate();
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

/** 往项目里写一个文件（走 gateway，保证与真源同一套路径规则） */
async function put(path: string, content: string): Promise<void> {
  await gateway.writeDoc(path, content);
}

/**
 * 引擎目录（`.yushu/`）**不能走 gateway 写**——它按红线拒写引擎/依赖目录（这是对的，
 * 所以迁移包"不装派生物"这条判据的夹具只能按真实成因来：那些文件本来就是引擎自己写的）。
 */
async function putRaw(path: string, content: string): Promise<void> {
  const abs = join(projectDir, ...path.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/**
 * 断言错误**码**而不是消息文本：`YushuError` 的 code 是独立字段，
 * 拿 `toThrow(/E_X/)` 去匹配 message 会永远配不上（R90 已经记过一次"只断消息等于没断是谁报的"）。
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "（没有抛错）").catch((err: unknown) => {
    if (err instanceof YushuError) return err.code;
    return `非 YushuError: ${String(err)}`;
  });
}

async function listRecursive(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("导出清单：收什么、跳什么、要剥什么", () => {
  it("真源进包，派生物与旁路文件整批跳过并点名理由", async () => {
    await put("chapters/vol-1/ch-001.md", "---\nid: ch-001\n---\n\n第一章正文。\n");
    await put("memory/facts/fact-a.md", "---\nid: fact-a\n---\n\n事实。\n");
    await putRaw(".yushu/index.db", "派生物不该进包");
    await putRaw(".yushu/secrets.json", '{"ciphertext":"AAAA"}');
    await put("exports/旧导出.md", "# 旧导出\n");
    await put("chapters/vol-1/ch-001.conflict-2.md", "冲突旁路文件\n");

    const preview = await previewProjectExport(gateway);
    const paths = preview.files.map((row) => row.path);
    expect(paths).toContain("world/world.yaml");
    expect(paths).toContain("chapters/vol-1/ch-001.md");
    expect(paths).toContain("memory/facts/fact-a.md");
    const skipped = preview.excluded.map((row) => row.path);
    expect(skipped).toContain("exports/旧导出.md");
    expect(skipped).toContain("chapters/vol-1/ch-001.conflict-2.md");
    // `.yushu/**` 根本**进不了树**：`listTree` 已经把引擎目录滤掉（既有行为），本层的 skipReason 只是第二道闸。
    // 所以这里能断的是"包里绝不会有派生文件"；第二道闸单独由下面那条用例钉住。
    expect(paths.some((path) => path.startsWith(".yushu/"))).toBe(false);
    expect(skipped.some((path) => path.startsWith(".yushu/"))).toBe(false);
    // 每条跳过都必须给理由，不许静默少文件
    expect(preview.excluded.every((row) => row.reason.length > 4)).toBe(true);
    expect(preview.totalBytes).toBeGreaterThan(0);
    expect(preview.bookTitle).toBe("天启界");
  });

  it("config/llm.yaml 含明文密钥 ⇒ 预览就报出「要剥几条」，而不是写完才发现", async () => {
    await put("config/llm.yaml", `format_version: 2\nproviders:\n  - id: mock\n    base_url: http://127.0.0.1:1/v1\n    api_key: ${PLAINTEXT_KEY}\n`);
    const preview = await previewProjectExport(gateway);
    expect(preview.redactions).toEqual([{ path: "config/llm.yaml", count: 1 }]);
  });

  it("干净配置 ⇒ 一条都不报（判据要能绿）", async () => {
    await put("config/llm.yaml", "format_version: 2\nproviders:\n  - id: mock\n    api_key_env: YUSHU_LLM_KEY\n    key_ref: primary\n");
    const preview = await previewProjectExport(gateway);
    expect(preview.redactions).toEqual([]);
  });
});

describe("导出落盘：票据、确认、空目录、复扫", () => {
  it("没票据 ⇒ 拒；票据无效 ⇒ 拒；渲染层永远拿不到路径参数", async () => {
    expect(await codeOf(runProjectExport(gateway, { ticket: "", confirmed: true }, { gate }))).toBe("E_EXPORT_TICKET");
    expect(await codeOf(runProjectExport(gateway, { ticket: "deadbeef", confirmed: true }, { gate }))).toBe("E_EXPORT_TICKET");
  });

  it("没确认 ⇒ 拒，且一个字节都不写", async () => {
    const target = await mkdtemp(join(outsideDir, "t-"));
    const picked = await gate.register(target);
    await put("chapters/vol-1/ch-001.md", "---\nid: ch-001\n---\n\n正文。\n");
    expect(await codeOf(runProjectExport(gateway, { ticket: picked.ticket }, { gate }))).toBe("E_CONFIRM_REQUIRED");
    expect(await listRecursive(target)).toEqual([]);
  });

  it("真导出：文件与清单一致、密文库不在包里、明文被剥掉、复扫零命中", async () => {
    const target = await mkdtemp(join(outsideDir, "out-"));
    const picked = await gate.register(target);
    await put("chapters/vol-1/ch-001.md", "---\nid: ch-001\n---\n\n第一章。\n");
    await put("world/cards/char-a.md", "---\nid: char-a\n---\n\n林渊。\n");
    await put("config/llm.yaml", `format_version: 2\nproviders:\n  - id: mock\n    api_key: ${PLAINTEXT_KEY}\n`);
    await putRaw(".yushu/secrets.json", '{"ciphertext":"AAAA"}');

    const result = await runProjectExport(
      gateway,
      { ticket: picked.ticket, confirmed: true },
      { gate, now: () => new Date("2026-10-15T12:00:00Z") },
    );
    const written = await listRecursive(join(target, result.subdir));
    expect(written).toContain("chapters/vol-1/ch-001.md");
    expect(written).toContain("world/cards/char-a.md");
    expect(written).toContain("MANIFEST.yaml");
    expect(written.filter((p) => p.startsWith(".yushu/"))).toEqual([]);
    expect(written.filter((p) => p.includes("secrets.json"))).toEqual([]);

    const exportedConfig = await readFile(join(target, result.subdir, "config/llm.yaml"), "utf8");
    expect(exportedConfig).not.toContain(PLAINTEXT_KEY);
    expect(exportedConfig).toContain("[yushu 迁移脱敏]");
    // 复扫这条是纵深防御：落盘字节里再检一次，必须 0 命中
    expect(result.plaintextRemaining).toBe(0);
    expect(result.redacted).toBe(1);
    expect(result.files).toBe(written.length);

    const manifest = await readFile(join(target, result.subdir, "MANIFEST.yaml"), "utf8");
    expect(manifest).toContain("天启界");
    // 清单数的是真源文件，回执数的是"写出的文件（含清单本身）"：两个口径必须能互相算平
    const manifestFiles = /^files: (\d+)$/m.exec(manifest);
    expect(manifestFiles, "MANIFEST 里没有 files: 行").not.toBeNull();
    expect(Number(manifestFiles![1]) + 1).toBe(result.files);
    // 包里不写绝对路径（迁移包会被发给别人，本机路径是隐私）
    expect(manifest).not.toContain(target);
    expect(manifest).not.toContain(projectDir);
  });

  it("目标子目录已存在 ⇒ 拒（不许覆盖别人的东西），且不删任何东西", async () => {
    const target = await mkdtemp(join(outsideDir, "busy-"));
    const picked = await gate.register(target);
    await put("chapters/vol-1/ch-001.md", "---\nid: ch-001\n---\n\n正文。\n");
    const first = await runProjectExport(gateway, { ticket: picked.ticket, confirmed: true }, { gate, now: () => new Date("2026-10-15T12:00:00Z") });
    // 同一时间戳 ⇒ 同一个子目录名；第二次必须拒，而不是把第一次的包覆盖掉
    await mkdir(join(target, first.subdir), { recursive: true });
    expect(
      await codeOf(
        runProjectExport(gateway, { ticket: picked.ticket, confirmed: true }, { gate, now: () => new Date("2026-10-15T12:00:00Z") }),
      ),
    ).toBe("E_EXPORT_TARGET_EXISTS");
    const kept = await listRecursive(join(target, first.subdir));
    expect(kept.length).toBe(first.files);
  });

  it("剥不干净就不交付：写出后复扫仍命中 ⇒ 整包删除并报错", async () => {
    const target = await mkdtemp(join(outsideDir, "leak-"));
    const picked = await gate.register(target);
    await put("chapters/vol-1/ch-001.md", "---\nid: ch-001\n---\n\n正文。\n");
    // 把"剥离"这一步换成"原样写"（注入假 redact）：复扫必须抓住它，并清掉已写的目录
    await put("config/llm.yaml", `format_version: 2
providers:
  - id: mock
    api_key: ${PLAINTEXT_KEY}
`);
    // 把"剥离"换成原样写（注入假 redact）：复扫必须抓住它，并清掉已写的目录
    expect(
      await codeOf(
        runProjectExport(gateway, { ticket: picked.ticket, confirmed: true }, {
          gate,
          now: () => new Date("2026-10-15T12:00:00Z"),
          redact: (text: string) => ({ text, redacted: 0 }),
        }),
      ),
    ).toBe("E_EXPORT_SECRET_RESIDUE");
    expect(await listRecursive(target)).toEqual([]);
  });

  it("错误一律是 YushuError 带 E_ 前缀（面板要能归类，不是裸字符串）", async () => {
    const picked = await gate.register(await mkdtemp(join(outsideDir, "err-")));
    const err = await runProjectExport(gateway, { ticket: picked.ticket }, { gate }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YushuError);
    expect((err as YushuError).code).toBe("E_CONFIRM_REQUIRED");
  });
});

describe("第二道闸：密文库与派生目录即使混进清单也不许进包", () => {
  it("`.yushu/**` 一律拒收并说明理由；exports 由开关决定；真源放行", () => {
    // 上游 listTree 已经滤掉 .yushu，这里测的是"我们自己又拦了一遍"这件事确实存在
    expect(exportSkipReason(".yushu/secrets.json", true)?.length).toBeGreaterThan(10);
    expect(exportSkipReason(".yushu/index.db", true)).toContain("派生");
    expect(exportSkipReason("exports/a.txt", false)).not.toBeNull();
    expect(exportSkipReason("exports/a.txt", true)).toBeNull();
    expect(exportSkipReason("chapters/vol-1/ch-001.md", false)).toBeNull();
    expect(exportSkipReason("world/world.yaml", false)).toBeNull();
  });
});

describe("导出闸门：只认主进程登记的目录", () => {
  it("普通文件不是目录 ⇒ 拒；不存在的目录 ⇒ 拒（错误里只给文件名不给路径）", async () => {
    const filePath = join(outsideDir, "a-file.txt");
    await writeFile(filePath, "x");
    await expect(gate.register(filePath)).rejects.toThrow(/不是目录/);
    await expect(gate.register(join(outsideDir, "nope-不存在"))).rejects.toThrow(/读不到/);
  });

  it("票据过期 ⇒ 拒并作废；撤销后同样取不到路径", async () => {
    const target = await mkdtemp(join(outsideDir, "ttl-"));
    const picked = await gate.register(target);
    expect(() => gate.resolve(picked.ticket)).not.toThrow();
    expect(() => gate.resolve(picked.ticket, Date.now() + 60 * 60 * 1000)).toThrow(/过期/);
    expect(gate.size()).toBe(0);
    const second = await gate.register(target);
    gate.revoke(second.ticket);
    expect(() => gate.resolve(second.ticket)).toThrow(/无效|已撤销/);
  });
});
