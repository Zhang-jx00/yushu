#!/usr/bin/env node
/**
 * 杀进程不丢稿实测（M2 门禁 §5.5 A1；T2-8 切片 B）：
 * 用**真实强杀**（Windows: taskkill /F；其他平台 SIGKILL）验证「编辑日志是崩溃时唯一幸存者」——
 *
 *   ① 子进程 A（--kill-edit=<dir>）：建夹具 + 编辑器持续输入（自动保存防抖永不触发）
 *      → 经产品自身接口确认编辑日志落盘 → 打印 KILL_READY
 *   ② 强杀 A（无关闭协调器 / 无 flush / 无窗口事件的机会窗口）→ 磁盘取证：
 *      章节文件不含 marker（未保存）且 .yushu/recovery/ 的 journal 含 marker（幸存）
 *   ③ 子进程 B（--kill-recover=<dir>）：重启进入项目 → 恢复面板 → 「恢复」→ 自动保存
 *      → 落盘 + journal 清除（产物 KILL_RESULT JSON 由主进程打印）
 *
 * 输出：[kill-test] 证据 JSON + 通过 / 失败；退出码 = 是否全部通过。
 * 前置：`pnpm --filter @yushu/desktop build`（主进程 + 渲染层均已构建）。
 */
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron"); // Node 侧 require 返回 Electron 可执行文件路径
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 与 apps/desktop/src/main/main.ts 的 KILL_TEST_MARKER 保持一致 */
const MARKER = "杀进程实测：孤灯残卷。";

function startElectron(arg) {
  const child = spawn(electronPath, [appDir, arg], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const waitForText = async (needle, timeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      const index = output.indexOf(needle);
      if (index >= 0) return output.slice(index);
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`等待「${needle}」超时（${timeoutMs}ms）；输出尾段：\n${output.slice(-600)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  };
  return { child, exited, waitForText };
}

function hardKill(pid) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/F", "/PID", String(pid)], () => undefined);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

async function findChapter(dir) {
  const entries = await fs.readdir(join(dir, "chapters"), { recursive: true }).catch(() => []);
  const hit = entries.find((entry) => String(entry).endsWith(".md") && !String(entry).includes("conflict"));
  return hit ? `chapters/${String(hit).split(/[\\/]/).join("/")}` : null;
}

const dir = await fs.mkdtemp(join(tmpdir(), "yushu-kill-"));
let childA = null;
let evidence = null;
let failure = null;

try {
  // ① 子进程 A：夹具 + 持续输入 → 编辑日志确认
  childA = startElectron(`--kill-edit=${dir}`);
  await childA.waitForText("KILL_READY", 90_000);
  // ② 真实强杀（此刻：自动保存防抖因持续输入永不触发；journal 已落盘）
  hardKill(childA.child.pid);
  const killed = await childA.exited;

  // ③ 磁盘取证（harness 侧直接读文件，不经应用）
  const recoveryDir = join(dir, ".yushu", "recovery");
  const journalNames = (await fs.readdir(recoveryDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  let journalHasMarker = false;
  for (const name of journalNames) {
    const data = await fs
      .readFile(join(recoveryDir, name), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (data && String(data.body).includes(MARKER)) journalHasMarker = true;
  }
  const chapterRel = await findChapter(dir);
  const diskAfterKill = chapterRel ? await fs.readFile(join(dir, chapterRel), "utf8").catch(() => "") : "";
  const diskNotSaved = chapterRel !== null && !diskAfterKill.includes(MARKER);

  // ④ 子进程 B：重启恢复
  const childB = startElectron(`--kill-recover=${dir}`);
  const resultOutput = await childB.waitForText("KILL_RESULT ", 90_000);
  const firstLine = resultOutput.split("\n")[0];
  const result = JSON.parse(firstLine.slice(firstLine.indexOf("KILL_RESULT ") + "KILL_RESULT ".length));
  await childB.exited;

  evidence = {
    ok: journalHasMarker && diskNotSaved && result.ok === true,
    killedExit: killed.code ?? killed.signal ?? null,
    journalHasMarker,
    diskNotSaved,
    ...result,
  };
} catch (err) {
  failure = err;
}

// 清理：残留子进程 + 临时目录（先清理再输出，保证退出码执行）
if (childA && childA.child.exitCode === null && !childA.child.killed) hardKill(childA.child.pid);
await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }).catch(() => undefined);

if (failure) {
  console.error("[kill-test] 执行失败:", failure);
  process.exit(1);
}
console.log(`[kill-test] 证据：${JSON.stringify(evidence, null, 2)}`);
console.log(
  evidence.ok
    ? "[kill-test] 通过：强杀时磁盘未保存、编辑日志幸存 → 重启恢复面板 → 恢复 → 落盘 + journal 清除"
    : "[kill-test] 失败：断言未满足",
);
process.exit(evidence.ok ? 0 : 1);