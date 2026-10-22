/* SPDX-License-Identifier: Apache-2.0 */
import { BrowserWindow, app, dialog } from "electron";
import { existsSync, promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLM_API_VERSION, LLM_FORMAT_VERSION, parseRoutingConfig, serializeLlmConfig, serializeRoutingConfig } from "@yushu/llm";
import { LLM_CONFIG_PATH, ROUTING_CONFIG_PATH } from "@yushu/world-engine";
import type { AxisValues } from "../shared/ipc.js";
import { attachProject } from "./ipc.js";
import { repoRoot } from "./paths.js";
import { createProject } from "./project-ops.js";
import { MAX_STEP_ATTEMPTS, stepBodySyntaxError, summarizeAttempts, type StepAttempt } from "./walkthrough-attempts.js";

/**
 * M1 验收场景（docs/06 §二）的 UI 自动化预演（`--ui-walkthrough[=<目录>]`）。
 *
 * 目的：用应用自身的 Electron 能力（executeJavaScript 驱动 DOM + capturePage 截图）走完场景，
 * 为真人 30 分钟试跑打磨流程并产出截图证据（docs/assets/m1-preview/）；
 * 步骤 10-31 为 M2 扩展与 M3 首批（双形态 / 实体提及（含富文本 @ 候选菜单）/ 自动保存与三方自动合并 / 写作视图 / 索引增量与保存即增量 / 本地快照 / 码字统计（含写作会话与真实速度）/ 会话与快照恢复 / 稿件总览全库视图 / Git 版本管理 / Provider v2 能力矩阵 / 任务路由与可靠性 / 本地模型接入与能力标注 / 五层记忆（摘要候选与 rev 保护 / 事实出处链）/ 注入控制与注入预演 / 上下文组装）。
 *
 * 明确的两处绕过（其余步骤全部经真实 UI 操作）：
 * 1. 第 1 步「新建项目」的存放目录在 UI 中是 readOnly 输入 + 系统对话框（无法自动化）——
 *    改由主进程等价执行 createProject（与 project:create 同一函数），预演从「项目已创建」开始；
 * 2. 第 8 步需要正文中出现敏感词，而该步骤排在编辑器页步骤之前——经 window.yushu.ai.adopt 追加一次正文。
 */

export interface MockOpenAI {
  server: Server;
  baseUrl: string;
  /** 请求计数与失败计数（T3-2 重试探针：e2e 断言发生过 429 且最终成功） */
  stats: { hits: number; failures: number };
}

export interface MockOpenAIOptions {
  /** 前 N 次请求返回错误（模拟 429，验证重试链路） */
  failFirst?: number;
  failStatus?: number;
}

export interface WalkthroughContext {
  dir: string;
  mock: MockOpenAI;
}

interface StepResult {
  step: number;
  title: string;
  ok: boolean;
  detail: string;
  screenshot: string;
  ms: number;
  /** 本步骤实际执行次数（1 = 一次过；2 = 第一次未过、重试后才过或仍未过） */
  attempts: number;
  /** 第一次未过、重试后通过 —— 如实标注，不洗成"一次通过" */
  flaky: boolean;
}

interface StepDef {
  step: number;
  title: string;
  file: string;
  body: string;
  /**
   * 需要"操作系统那一层"夹具的步骤在这里声明（目前只有导入用的原生选文件对话框）。
   * 桩只包住原生对话框，产品链路（IPC → 闸门 → 引擎 → 面板）全程真实执行，
   * 且**每次 attempt 重新起一份**——重试不会接着上一次的调用次数往下走。
   */
  fixture?: "import-dialog" | "export-dir" | "map-base-dialog";
  /**
   * 需要把渲染进程当成「系统要求减少动效」来跑的这一步（R111）。
   *
   * 为什么必须由主进程做：页面里的 CSS 媒体查询读的是**系统设置**，
   * 渲染进程里的 JS 改不了它——只有浏览器进程能改，所以只能由主进程下发 CDP 命令。
   * 契约 §5 第 3 条要求 reduced-motion 下 transition 与 animation 都被关掉，
   * 这条口径只有真的把系统设置模拟出来才验得到。
   */
  emulateReducedMotion?: boolean;
  /**
   * 这一步之前先把**渲染进程整个重新载入**（R111）。
   *
   * 为什么需要：step73（开屏）走的是「新建项目 → 取消」，把界面留在**欢迎屏**——
   * 而欢迎屏没有「返回项目」的入口（「打开已有项目」要走系统对话框，无法自动化）。
   * 重新载入后 App 在挂载时读 project.current() ⇒ 自动回到项目页。
   *
   * 注意：重新载入会清掉 window.__yushuDebug，所以主进程要补设一次；
   * 而且**下一步不许依赖只在旧页面里挂过的调试句柄**（ChapterEditorView 的
   * __yushuEditorDebug 要等编辑器页真的挂载才会暴露）。
   */
  reloadBefore?: boolean;
}

const SCREENSHOT_REL_DIR = "docs/assets/m1-preview";

/** T3-10 设定抽取 mock：抽取请求（系统提示含任务契约 id）返回固定候选——示例覆盖新增 / 补充 / 冲突三类 */const EXTRACT_MOCK_CANDIDATES = {
  candidates: [
    {
      type: "character",
      name: "林渊",
      aliases: ["小渊"],
      summary: "开篇登场的主角（示例候选）。",
      quote: "天启界的夜色",
      confidence: 0.9,
    },
    {
      type: "item",
      name: "玄铁令",
      aliases: [],
      summary: "第一章末获得的关键道具（示例候选）。",
      quote: "玄铁令",
      confidence: 0.82,
    },
    {
      type: "location",
      name: "天启界",
      aliases: [],
      summary: "故事开篇所在的世界（示例候选）。",
      quote: "天启界的夜色",
      confidence: 0.75,
    },
    {
      type: "location",
      name: "林渊",
      aliases: [],
      summary: "同名异类型（冲突分类探针：既有卡为人物）。",
      quote: "临走时他低声说",
      confidence: 0.4,
    },
    {
      type: "character",
      name: "测试设定1",
      aliases: [],
      summary: "与既有卡同名（补充 / 冲突分类探针——视既有卡类型而定）。",
      quote: "走进了夜色里",
      confidence: 0.3,
    },
  ],
};

/** 本地 mock OpenAI（Chat Completions + SSE）：预演不依赖外网与真实 key（与 e2e 同款） */
/** T4-4 AI 采样 mock：采样请求返回固定结论（只指认给定的序号，越界与编造一律不给） */
const AUDIT_MOCK_ISSUES = {
  issues: [{ index: 0, kind: "hallucination", why: "该断言在设定库与出处记忆中均无支撑" }],
};

/**
 * R107 导入·AI 二次筛选切分的 mock：从提示词里把候选序号抠出来，**只保留前两条**。
 *
 * 为什么要专门做这个：若 mock 一律回固定文本，这条链在预演里永远走"契约不过 ⇒ 回退正则"，
 * **AI 真正筛过的那条路一次都跑不到**。这里让 mock 照着提示词里的候选作答，
 * 预演才能验到"筛完章数变了"这件事。
 */
function splitFilterMock(raw: string): { keeps: { index: number; reason: string }[] } {
  const indexes = [...raw.matchAll(/#(\d+)\s/g)].map((match) => Number(match[1])).filter((value) => Number.isInteger(value));
  const kept = indexes.slice(0, 2);
  return { keeps: kept.map((index) => ({ index, reason: "mock：保留前两条候选" })) };
}

export async function startMockOpenAI(
  delayMs = 2,
  options: MockOpenAIOptions = {},
): Promise<MockOpenAI> {
  const stats = { hits: 0, failures: 0 };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      stats.hits += 1;
      if ((options.failFirst ?? 0) >= stats.hits) {
        stats.failures += 1;
        res.writeHead(options.failStatus ?? 429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limited (mock)" } }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        body = {};
      }
      // T3-3：非流式（一次性返回）分支——模型声明 stream:false 时的降级路径会走到这里
      if (body["stream"] !== true) {
        // T3-10：设定抽取请求（系统提示含任务契约 id）返回候选 JSON；其余返回固定文本（降级探针口径）
        const content = raw.includes("yushu.extract/entity_extraction")
          ? JSON.stringify(EXTRACT_MOCK_CANDIDATES)
          : raw.includes("yushu.audit/consistency-sampling")
            ? JSON.stringify(AUDIT_MOCK_ISSUES)
            : raw.includes("yushu.import/split_filter/v1")
              ? JSON.stringify(splitFilterMock(raw))
              : "非流式一次性回复";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: typeof body["model"] === "string" ? body["model"] : "mock-model",
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // T3-11：多候选生成（指令含「多候选生成 #i/N」标记）返回差异化文本；其余保持既有口径
      const multiMatch = /多候选生成 #(\d+)\//.exec(raw);
      const chunks = multiMatch
        ? ["夜色压下来。", `林渊拔剑而起（候选${multiMatch[1]}）。`]
        : ["天启", "界的", "夜色"];
      let sent = 0;
      const writeNext = () => {
        if (sent >= chunks.length) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[sent] } }] })}\n\n`);
        sent += 1;
        setTimeout(writeNext, delayMs);
      };
      writeNext();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, stats };
}

/** 解析 `--ui-walkthrough[=<目录>]`；缺省值时为临时目录 */
export function parseWalkthroughDir(arg: string): string {
  const eq = arg.indexOf("=");
  const value = eq >= 0 ? arg.slice(eq + 1).trim() : "";
  return value === "" ? "" : value;
}

export interface PrepareProjectOptions {
  /** 项目目录（已存在项目则跳过创建） */
  dir: string;
  title: string;
  packIds: string[];
  axes: AxisValues;
  /** 共享的本地 mock（provider 指向它的 base_url） */
  mock: MockOpenAI;
  logPrefix?: string;
  /**
   * 预演用（T2-8 切片 B）：挂载前写入一份「上次会话 active + 旧 pid」的模拟崩溃标记，
   * 让本窗口打开项目时走真实的异常退出检出路径（UI 预演展示会话恢复提示；trial 不启用）。
   */
  simulateCrash?: boolean;
}

/**
 * 公共前置（walkthrough / trial 复用）：
 * 按需由主进程等价执行 createProject（UI 的存放目录为 readOnly + 系统对话框，无法自动化）→
 * 写 config/llm.yaml 指向本地 mock（provider 就绪，无需会话 Key）→ 挂载 gateway。
 */
export async function prepareProjectForDir(options: PrepareProjectOptions): Promise<void> {
  const { dir, title, packIds, axes, mock, logPrefix = "[project]" } = options;
  // 防状态污染（复核教训 2026-09-29）：复用已建项目的目录会让后续步骤因"卡/大纲/草稿已存在"而失败，
  // 极易被误判为产品回归——这里直接拒绝，要求使用空目录。
  if (existsSync(join(dir, "world", "world.yaml"))) {
    throw new Error(
      `${logPrefix} 目标目录已有御书项目：${dir}\n请使用空目录或先删除该目录（复用旧目录会因既有卡/大纲导致步骤失败，易误判为回归）`,
    );
  }
  await createProject({ dir, title, packIds, axes });
  console.log(`${logPrefix} 已由主进程等价执行 createProject（绕过第 1 步的系统对话框）：${dir}`);

  const llmYaml = serializeLlmConfig({
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "mock",
        kind: "local", // 127.0.0.1 mock：本地端点（能力矩阵与隐私提示按本地处理，T3-1）
        protocol: "openai_chat",
        base_url: mock.baseUrl,
        models: [{ name: "mock-model", tier: "flagship", limits: { context: 32768, max_output: 2048 } }],
      },
    ],
  });
  await fs.mkdir(join(dir, "config"), { recursive: true });
  await fs.writeFile(join(dir, LLM_CONFIG_PATH), llmYaml, "utf8");

  // T3-2：写入 config/routing.yaml（fallback 链指向 mock；其余字段取内置默认），供 step27 展示与断言
  const routingYaml = serializeRoutingConfig(
    parseRoutingConfig(
      ["apiVersion: yushu.llm/v1", "format_version: 1", "fallback:", "  drafting: [mock]", ""].join("\n"),
    ),
  );
  await fs.writeFile(join(dir, ROUTING_CONFIG_PATH), routingYaml, "utf8");

  // R123：预演项目里放一张底图（1×1 的 PNG）⇒ 地图面板能把底图铺在坐标空间上。
  // 底图是**作者自己放进项目**的（地图登记不设表单），所以这一步是替作者做的那一次。
  await fs.mkdir(join(dir, "world", "assets", "map"), { recursive: true });
  await fs.writeFile(join(dir, "world", "assets", "map", "base.png"), Buffer.from(BASE_PNG_BASE64, "base64"));

  // T2-8 切片 B 预演：写入模拟崩溃标记（旧 pid → 挂载时按真实检出路走出「异常退出」结果）
  if (options.simulateCrash) {
    await fs.mkdir(join(dir, ".yushu"), { recursive: true });
    await fs.writeFile(
      join(dir, ".yushu", "session.json"),
      JSON.stringify(
        {
          schema_version: 1,
          state: "active",
          pid: 999999,
          startedAt: "2026-10-05T09:00:00.000Z",
          lastSeenAt: "2026-10-05T09:30:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`${logPrefix} 已写入模拟崩溃会话标记（展示异常退出检出；pid=999999）`);
  }

  await attachProject(dir);
}

/**
 * 预演前置：起 mock、按需创建项目、写 config/llm.yaml（provider 就绪，无需会话 Key）、挂载 gateway。
 * 必须在窗口加载前完成——renderer 挂载时会调 project:current 并自动进入项目页。
 */
export async function prepareWalkthrough(dirArg: string): Promise<WalkthroughContext> {
  // 开跑前先解析一遍每段步骤脚本（R58）：本轮 step44 连烧三个纯解析期 bug（少括号、脏正则后缀），
  // 每个都要跑满一整轮 70 秒才暴露。语法错挡在 0 秒，语义 bug 仍靠 note 里的原始值留证。
  const syntaxErrors = STEPS.map((def) => stepBodySyntaxError(def.step, def.body)).filter((m) => m !== null);
  if (syntaxErrors.length > 0) {
    throw new Error(`[walkthrough] 步骤脚本编译不过，已中止（不创建项目、不起 mock）：\n  ${syntaxErrors.join("\n  ")}`);
  }

  const dir = dirArg === "" ? await fs.mkdtemp(join(tmpdir(), "yushu-walkthrough-")) : dirArg;
  const mock = await startMockOpenAI();

  await prepareProjectForDir({
    dir,
    title: "天启界",
    packIds: ["xuanhuan-xitong"],
    axes: {
      channel: ["男频"],
      world: ["玄幻"],
      technique: ["系统流"],
      tone: ["爽文"],
      romance_mode_default: "无女主",
    },
    mock,
    logPrefix: "[walkthrough]",
    simulateCrash: true, // T2-8 切片 B：展示会话异常退出检出（见 step19）
  });

  await fs.mkdir(join(repoRoot, SCREENSHOT_REL_DIR), { recursive: true });
  return { dir, mock };
}

/**
 * 把渲染进程切成「系统要求减少动效」（R111）：用 CDP 的 `Emulation.setEmulatedMedia`
 * 模拟系统的 `prefers-reduced-motion = reduce`。
 *
 * 为什么必须走主进程：页面里的 CSS 媒体查询读的是**系统设置**，
 * 渲染进程里的 JS 改不了它——只有浏览器进程能改，所以只能由主进程下发 CDP 命令。
 * 契约 §5 第 3 条要求 reduced-motion 下 transition 与 animation 都被关掉，
 * 这条口径只有真的把系统设置模拟出来才验得到（否则只能验 CSS 里写了什么）。
 *
 * 失败**不静默**：ok=false 会让这一步如实报红，而不是"模拟没生效但看起来过了"。
 */
async function applyReducedMotion(
  win: BrowserWindow,
  reduce: boolean,
): Promise<{ ok: boolean; restore: () => Promise<void> }> {
  const dbg = win.webContents.debugger;
  const restore = async () => {
    await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
    await win.webContents.executeJavaScript("window.__yushuReducedMotion = false;").catch(() => undefined);
  };
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Emulation.setEmulatedMedia", {
      features: reduce ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
    });
    await win.webContents
      .executeJavaScript(`window.__yushuReducedMotion = ${reduce ? "true" : "false"};`)
      .catch(() => undefined);
    return { ok: true, restore };
  } catch (err) {
    console.error("[walkthrough] reduced-motion 模拟失败：", err);
    await win.webContents.executeJavaScript("window.__yushuReducedMotion = false;").catch(() => undefined);
    return { ok: false, restore };
  }
}

/** 脚本公共能力：原生 setter 驱动受控输入、等待器、标签页切换、confirm 短路 */
export function buildScript(body: string): string {
  return String.raw`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const setV = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      d.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const waitFor = async (fn, timeout = 12000, interval = 100) => {
      const t0 = Date.now();
      for (;;) {
        let r = null;
        try { r = await fn(); } catch (e) { r = null; } // await：允许异步谓词（如反复读盘核对）
        if (r) return r;
        if (Date.now() - t0 > timeout) return null;
        await sleep(interval);
      }
    };
    const tab = async (label) => {
      const b = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes(label));
      if (!b) throw new Error('找不到标签页：' + label);
      b.click();
      await sleep(250);
    };
    const lines = (el) => (el ? el.innerText.split(String.fromCharCode(10)).join(' | ') : '');
    const pageText = () => document.body.innerText.slice(0, 500);
    window.confirm = () => true;
    try {
      ${body}
    } catch (e) {
      return { ok: false, note: '脚本异常：' + (e && e.message ? e.message : String(e)) + ' ｜ 页面：' + pageText() };
    }
  })()`;
}

/**
 * 步骤 55 的夹具：只把**原生选文件对话框**换成返回固定夹具路径的桩。
 *
 * 为什么桩放在预演驱动里、而不是在产品代码里开一条"测试可传路径"的分支：
 * `import:pick` 存在的全部理由就是"路径只能来自用户亲手点出来的对话框"，
 * 产品代码里只要留一条能被程序喂路径的暗门，R77 那道闸门就白立了。
 * 桩只在这一步的每次 attempt 期间存在，退出即还原、夹具文件当场删除。
 *
 * 给哪一份由渲染层的 `window.__yushuPick` 决定（utf8 / gbk / cancel），**不靠调用次数**：
 * 失败重试时步骤会从中间重来，按次序发路径会让第二次 attempt 拿到上一次的进度，
 * 于是"抖动"和"真回归"分不清（本轮就是这么撞上的）。
 */
/** 没有章节标题的一份稿子：走"没切开 ⇒ 必须显式确认才允许整篇入库"那条分支 */
const IMPORT_UI_FLAT = ["这是一段没有标题的正文。", "还是没标题，一直到最后。", "第三行也没有。"].join("\r\n");

/**
 * R107 用的"切错了"的稿子：故意留两处误切信号。
 *
 * ① **章号不连续**（第一章 → 第三章）：源稿自己跳了一章 ⇒ 误切检测的"章号连续性"该报；
 * ② **章节字数离群**（第四章只有两个字）：中位数 20 多字，它只有 2 字 ⇒ "疑似切错"该报。
 *
 * 选它是为了让预演能真的验到误切清单——夹具若无其事，预演就只会验一张空表。
 */
const IMPORT_UI_MISCUT = [
  "第一章 起",
  "夜色压下来，林渊拔剑而起，天启界的夜色里有什么在等着他。",
  "第三章 承",
  "林渊走过长街，风从窗缝里灌进来，脚下的石板还是凉的。",
  "第四章 转",
  "停。",
].join("\r\n");

/**
 * R108 用的长稿子：40 章。
 *
 * 为什么要这么长：**入库途中点「停下」要能点得到**。三章的稿子入库只花几毫秒，
 * 渲染层那一次点击根本赶不上（点晚了入库已经结束 ⇒ 这一步就变成"看运气"的抖动证据）。
 * 40 章 ⇒ 入库要写 40 份草稿 + 40 次断点落盘 ⇒ 窗口足够宽，**停下来停在哪一章都行**
 * （断言只要求"停在章的边界上、断点落盘、剩下的可续"）。
 */
const IMPORT_UI_LONG = Array.from(
  { length: 40 },
  (_unused, index) =>
    `第${String(index + 1)}章 测试章${String(index + 1)}\r\n这是第 ${String(index + 1)} 章的正文，用来把入库的窗口拉宽一些。`,
).join("\r\n");

async function openImportDialogFixture(win: BrowserWindow): Promise<{ dir: string; restore(): Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "yushu-import-ui-"));
  const utf8Path = join(dir, "旧稿-预演.txt");
  const gbkPath = join(dir, "旧稿-GBK.txt");
  const flatPath = join(dir, "旧稿-没标题.txt");
  const miscutPath = join(dir, "旧稿-切错了.txt");
  const longPath = join(dir, "旧稿-长稿.txt");
  await fs.writeFile(utf8Path, IMPORT_UI_TEXT, "utf8");
  await fs.writeFile(gbkPath, Buffer.from(IMPORT_UI_GBK));
  await fs.writeFile(flatPath, IMPORT_UI_FLAT, "utf8");
  await fs.writeFile(miscutPath, IMPORT_UI_MISCUT, "utf8");
  await fs.writeFile(longPath, IMPORT_UI_LONG, "utf8");
  const original = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => {
    const which = String(
      await win.webContents.executeJavaScript("window.__yushuPick || ''").catch(() => ""),
    );
    const picked =
      which === "gbk"
        ? gbkPath
        : which === "utf8"
          ? utf8Path
          : which === "flat"
            ? flatPath
            : which === "miscut"
              ? miscutPath
              : which === "long"
                ? longPath
                : undefined;
    return picked === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picked] };
  }) as typeof dialog.showOpenDialog;
  return {
    dir,
    restore: async () => {
      dialog.showOpenDialog = original;
      await win.webContents.executeJavaScript("delete window.__yushuPick;").catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * 迁移包导出的目标目录夹具（R101 / step62）：把"操作系统那一层"换成一个临时目录，
 * 其余全走真通道（对话框 → 票据 → 预览 → 落盘 → 复扫）。跑完由 `check()` 去**盘上**核对，
 * 不信任界面上的数字：清单与回执必须互相对得上，且包里不许出现 `.yushu`。
 */
async function openExportDirFixture(): Promise<{
  dir: string;
  restore(): Promise<void>;
  check(): Promise<{ ok: boolean; detail: string }>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), "yushu-export-target-"));
  const original = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  return {
    dir,
    check: async () => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const bundles = entries.filter((entry) => entry.isDirectory() && entry.name.includes("迁移包")).map((entry) => entry.name);
      if (bundles.length !== 1) {
        return { ok: false, detail: `目标目录里的迁移包子目录数=${String(bundles.length)}（应为 1）` };
      }
      const root = join(dir, bundles[0]!);
      const walk = async (rel: string): Promise<string[]> => {
        const out: string[] = [];
        for (const entry of await fs.readdir(join(root, rel), { withFileTypes: true })) {
          const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) out.push(...(await walk(child)));
          else out.push(child);
        }
        return out;
      };
      const files = await walk("");
      const manifest = files.find((name) => name === "MANIFEST.yaml");
      const leaked = files.filter((name) => name.startsWith(".yushu/") || name.includes("secrets.json"));
      const manifestText = manifest === undefined ? "" : await fs.readFile(join(root, "MANIFEST.yaml"), "utf8");
      const declared = /^files: (\d+)$/m.exec(manifestText);
      const ok = manifest !== undefined && leaked.length === 0 && declared !== null && Number(declared[1]) + 1 === files.length;
      return {
        ok,
        detail:
          `盘上=${String(files.length)} 个文件（清单声明 ${declared === null ? "?" : declared[1]} 个真源 + 清单自身）；` +
          `MANIFEST=${manifest === undefined ? "缺" : "有"}；密文库/派生出现在包里=${String(leaked.length)} 条`,
      };
    },
    restore: async () => {
      dialog.showOpenDialog = original;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 步骤 55 的两份夹具稿件：UTF-8 一份（含网址行 / 密钥行 / 多余空行 / 卷标题 / 楔子 / 三章）、GBK 一份（触发"这是猜的"分支） */
const IMPORT_UI_TEXT = [
  "作品简介：这是一部用来预演的测试稿。",
  "",
  "第一卷 风起",
  "",
  "",
  "",
  "第一章 起",
  "夜色压下来。",
  "",
  "",
  "",
  "",
  "https://www.example-site.com/read/12345",
  "调用 openai 用 sk-abcdefghijklmnopqrstuvwx",
  "",
  "第二章 承",
  "林渊拔剑而起。",
  "",
  "第三章 转",
  "剑光落下，风声停了。",
].join("\r\n");

/**
 * 底图登记的**原生对话框桩**（R135）：预演替作者挑那张 1×1 的 PNG。
 *
 * 桩只是工装（原生对话框在无人值守的预演里没法真点）⇒ **断言断的是盘上的字节**。
 */
async function openMapBaseDialogFixture(
  win: BrowserWindow,
  dir: string,
): Promise<{ dir: string; restore(): Promise<void> }> {
  const png = join(dir, "world", "assets", "map", "base.png");
  const original = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => {
    const exists = await fs
      .stat(png)
      .then(() => true)
      .catch(() => false);
    return exists ? { canceled: false, filePaths: [png] } : { canceled: true, filePaths: [] };
  }) as typeof dialog.showOpenDialog;
  return {
    dir,
    restore: async () => {
      dialog.showOpenDialog = original;
    },
  };
}

/** 1×1 的 PNG（R123 的预演底图：够小，只为验证"底图被铺在坐标空间上"这件事） */
const BASE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 真 GBK 字节（`第一章 起 / 夜色压下来。/ 第二章 承 / 林渊拔剑而起。`，CRLF 行尾） */
const IMPORT_UI_GBK = new Uint8Array([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc6, 0xf0, 0x0d, 0x0a, 0xd2,
  0xb9, 0xc9, 0xab, 0xd1, 0xb9, 0xcf, 0xc2, 0xc0, 0xb4, 0xa1, 0xa3, 0x0d,
  0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 0x20, 0xb3, 0xd0, 0x0d, 0x0a,
  0xc1, 0xd6, 0xd4, 0xa8, 0xb0, 0xce, 0xbd, 0xa3, 0xb6, 0xf8, 0xc6, 0xf0,
  0xa1, 0xa3, 0x0d, 0x0a,
]);


const STEPS: StepDef[] = [
  {
    step: 1,
    title: "进入项目页（App 自动加载已挂载项目）",
    file: "step1-project.png",
    body: String.raw`
      const el = await waitFor(() => document.querySelector('.tabs'), 20000);
      if (!el) return { ok: false, note: '未自动进入项目页：' + pageText() };
      // 预演必须跑在**已知状态**里：主题偏好是用户级的（存在 localStorage，会跨轮留下），
      // 不归零的话这一轮可能整轮都是暗色的 ⇒ 截图不可复现、下一轮的『改前底色』也说不清。
      const themeSel = document.querySelector('.theme-picker select');
      if (themeSel !== null) {
        const themeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        themeSetter.call(themeSel, 'light');
        themeSel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(350);
      }
      const path = document.querySelector('.topbar .path');
      return { ok: true, note: '项目页已就绪，标签 ' + document.querySelectorAll('.tab').length + ' 个；root=' + (path ? path.textContent : '(未显示)') + '；主题归零为 ' + String(document.documentElement.dataset.theme || '') };
    `,
  },
  {
    step: 2,
    title: "起源工作台逐步建档 5 张设定卡",
    file: "step2-genesis.png",
    body: String.raw`
      // 幂等 + 等按钮（v224 实撞，两条独立原因）：
      // ① 保存瞬间按钮文案会变成「保存中…」（GenesisView: busy ? '保存中…' : '保存并继续 →'），
      //    一次性查按钮就会在那个窗口里扑空 ⇒ 改成**等**文案变回来的那一刻。
      // ② 失败重试时工作台已经停在第 3 步，从 i=1 重来会把第 3 步的卡写成「测试设定1」，
      //    越错越远 ⇒ 从**已完成的那一步**接着做（每次保存推进一格，done 数 +1 = 当前步）。
      const doneCount = () => document.querySelectorAll('.step-item.done').length;
      for (let i = doneCount() + 1; i <= 5; i += 1) {
        const form = await waitFor(() => document.querySelector('.step-form'), 10000);
        if (!form) return { ok: false, note: '第 ' + i + ' 张卡：找不到 .step-form ｜ ' + pageText() };
        const field = form.querySelector('input, textarea');
        if (!field) return { ok: false, note: '第 ' + i + ' 张卡：表单无输入框' };
        setV(field, '测试设定' + i);
        const btn = await waitFor(() => {
          const b = [...document.querySelectorAll('.step-form button')].find((x) => String(x.textContent).indexOf('保存并继续') >= 0);
          return b || null;
        }, 10000);
        if (!btn) return { ok: false, note: '第 ' + i + ' 张卡：找不到「保存并继续」按钮' };
        btn.click();
        const done = await waitFor(() => (doneCount() >= i ? doneCount() : null), 12000);
        if (done === null) {
          const foot = document.querySelector('.wizard-foot');
          return { ok: false, note: '第 ' + i + ' 张卡保存未生效（已完成 ' + doneCount() + '）：' + lines(foot) };
        }
        await sleep(120);
      }
      const counter = document.querySelector('.genesis aside .panel-title');
      return {
        ok: doneCount() >= 5,
        note: '已完成步骤 ' + doneCount() + ' / 5；计数文本：' + lines(counter),
      };
    `,
  },
  {
    step: 3,
    title: "三级大纲一键生成骨架",
    file: "step3-outline.png",
    body: String.raw`
      await tab('三级大纲');
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('.outline button')].find((x) => x.textContent.includes('一键生成骨架'));
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!btn) return { ok: false, note: '「一键生成骨架」不可用（模板可能未加载）：' + pageText() };
      btn.click();
      const count = await waitFor(
        () => (document.querySelectorAll('.volume-list li').length > 0 ? document.querySelectorAll('.volume-list li').length : null),
        15000,
      );
      if (count === null) return { ok: false, note: '未出现卷纲列表：' + pageText() };
      return { ok: count > 0, note: '卷纲 ' + count + ' 条；当前卷章纲 ' + document.querySelectorAll('.chapter-list li').length + ' 条' };
    `,
  },
  {
    step: 4,
    title: "章纲一键创建草稿章节（回填 chapter_id）",
    file: "step4-chapter-draft.png",
    body: String.raw`
      await tab('三级大纲');
      const first = await waitFor(() => document.querySelector('.volume-list li'), 12000);
      if (!first) return { ok: false, note: '找不到卷纲条目：' + pageText() };
      first.click();
      await sleep(300);
      const saveBtn = [...document.querySelectorAll('.outline-foot button')].find((b) => b.textContent.includes('保存大纲'));
      if (saveBtn && !saveBtn.disabled) { saveBtn.click(); await sleep(700); }
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('.chapter-list li:first-child button')].find((x) => x.textContent.includes('创建草稿章节'));
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!btn) {
        const li = document.querySelector('.chapter-list li:first-child');
        const dirty = document.querySelector('.outline-foot .dirty');
        return { ok: false, note: '「创建草稿章节」不可用' + (dirty ? '（仍有未保存修改）' : '') + '：' + (lines(li) || pageText()) };
      }
      btn.click();
      const badge = await waitFor(() => (document.body.innerText.includes('草稿章节已建') ? true : null), 15000);
      if (!badge) return { ok: false, note: '未出现「草稿章节已建」徽标：' + pageText() };
      return { ok: true, note: '草稿章节已创建，章纲显示「草稿章节已建」（chapter_id 已回填）' };
    `,
  },
  {
    step: 5,
    title: "AI 副驾开启开关并流式生成候选",
    file: "step5-ai-stream.png",
    body: String.raw`
      await tab('AI 副驾');
      const label = await waitFor(() => [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('启用 AI 调用')), 12000);
      if (!label) return { ok: false, note: '找不到「启用 AI 调用」复选框：' + pageText() };
      const cb = label.querySelector('input');
      if (cb && !cb.checked) { cb.click(); await sleep(200); }
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始生成');
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!btn) return { ok: false, note: '「开始生成」不可用（provider 未就绪 / 无目标）：' + pageText() };
      btn.click();
      const done = await waitFor(() => {
        const c = document.querySelector('.candidate');
        return c && c.textContent.trim() !== '' && document.body.innerText.includes('生成完成') ? true : null;
      }, 20000);
      const cand = document.querySelector('.candidate');
      const text = cand ? cand.textContent : '';
      return { ok: done === true, note: '候选文本=' + JSON.stringify(text.slice(0, 60)) + '（长度 ' + text.length + '，含「生成完成」=' + (done === true) + '）' };
    `,
  },
  {
    step: 6,
    title: "整段采纳（替换正文）并留痕",
    file: "step6-adopt.png",
    body: String.raw`
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('整段采纳（替换正文）'));
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!btn) return { ok: false, note: '「整段采纳（替换正文）」不可用：' + pageText() };
      btn.click();
      const notice = await waitFor(() => (document.body.innerText.includes('替换采纳') ? true : null), 15000);
      // 使用记录在采纳回执之后异步刷新（refreshDrafts → refreshUsage 两次 IPC）：
      // 等待「采纳」行进入列表再断言，避免读到刷新前的旧列表（第 16 轮：采纳前快照使 IPC 变慢后暴露出的竞态）
      const usageSeen = await waitFor(() => {
        const usage = document.querySelector('.usage-list');
        const text = usage ? lines(usage) : '';
        return text.includes('采纳') ? text : null;
      }, 8000);
      const usageText = usageSeen || lines(document.querySelector('.usage-list'));
      return {
        ok: notice === true && usageText.includes('生成') && usageText.includes('采纳'),
        note: '采纳回执含「替换采纳」=' + (notice === true) + '；使用记录：' + usageText.slice(0, 160),
      };
    `,
  },
  {
    step: 7,
    title: "导出与自查：确认导出 TXT + 字数对账（摘要未回前不许勾确认）",
    file: "step7-export.png",
    body: String.raw`
      await tab('导出与自查');
      // 防手滑这条承诺要在 UI 上立得住：**没看见数字之前勾不了**。
      // 所以顺序是"先等摘要（预览已回）→ 再要求确认框可用"；反过来写就会撞上
      // "勾了之后预览才回来、把勾选冲掉"的竞态（v188 的 step7 就是这么抖了一次）。
      const summary = await waitFor(() => document.querySelector('.export-summary'), 25000);
      if (!summary) return { ok: false, note: '导出摘要没出来（预览未返回）：' + pageText() };
      const chk = await waitFor(() => {
        const c = document.querySelector('.confirm-check input[type=checkbox]');
        return c && !c.disabled ? c : null;
      }, 15000);
      if (!chk) return { ok: false, note: '摘要已出但确认框仍不可用：' + pageText() };
      if (!chk.checked) { chk.click(); await sleep(200); }
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('确认导出 TXT'));
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!btn) return { ok: false, note: '「确认导出 TXT」不可用：' + pageText() };
      btn.click();
      const done = await waitFor(() => (document.body.innerText.includes('已导出') ? true : null), 20000);
      const text = document.body.innerText;
      const matched = text.includes('✓ 一致');
      const mismatch = text.includes('✗ 失配');
      return { ok: done === true && matched && !mismatch, note: '导出回执=' + (done === true) + '；对账全部一致=' + matched + '；存在失配=' + mismatch };
    `,
  },
  {
    step: 8,
    title: "敏感词自查（追加含敏感词正文 → 重新核对 → 命中定位）",
    file: "step8-sensitive.png",
    body: String.raw`
      await tab('导出与自查');
      const st = await window.yushu.outline.read();
      const vol = st.doc.volumes[0];
      const chap = vol.chapters.find((c) => c.chapter_id) || vol.chapters[0];
      await window.yushu.ai.adopt({
        usageId: 'walkthrough',
        volumeId: vol.id,
        chapterId: chap.id,
        text: '临走时他低声说：加微信详谈。',
        mode: 'append',
      });
      const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重新核对'));
      if (!btn) return { ok: false, note: '找不到「重新核对」按钮：' + pageText() };
      btn.click();
      const hit = await waitFor(() => (document.body.innerText.includes('加微信') ? true : null), 20000);
      const text = document.body.innerText;
      const idx = text.indexOf('加微信');
      return {
        ok: hit === true,
        note: '命中表可见「加微信」=' + (hit === true) + '；片段=' + JSON.stringify(text.slice(Math.max(0, idx - 40), idx + 40)),
      };
    `,
  },
  {
    step: 9,
    title: "项目文件：重建索引 + 中文检索",
    file: "step9-index.png",
    body: String.raw`
      await tab('项目文件');
      const rebuild = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重建索引'));
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!rebuild) return { ok: false, note: '找不到「重建索引」按钮：' + pageText() };
      rebuild.click();
      const built = await waitFor(() => (document.body.innerText.includes('已构建') ? true : null), 25000);
      // 分片写入回执（T2-5 切片 B：全量重建以分片写入 + 进度流执行；T2-11：解析在 utilityProcess）
      const sharded = await waitFor(
        () => {
          const text = document.body.innerText;
          return text.includes('索引已重建（全量 · 分片') && text.includes('解析 utility 进程') ? true : null;
        },
        8000,
      );
      const input = await waitFor(() => document.querySelector('.dir-row input'), 10000);
      if (!input) return { ok: false, note: '找不到检索输入框' };
      const searchBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '检索');
      if (!searchBtn) return { ok: false, note: '找不到「检索」按钮' };
      setV(input, '林渊');
      await sleep(250);
      searchBtn.click();
      const panel = await waitFor(() => document.querySelector('.search-results'), 15000);
      const first = panel ? lines(panel).slice(0, 90) : '无结果面板';
      // 本次预演的项目使用占位卡名（测试设定N），无「林渊」实体：追加一次有命中的关键词以证明检索链路可用
      setV(input, '测试设定');
      await sleep(250);
      searchBtn.click();
      const hits = await waitFor(
        () => (document.querySelectorAll('.search-results li').length > 0 ? document.querySelectorAll('.search-results li').length : null),
        12000,
      );
      return {
        ok: built === true && sharded === true && panel !== null && hits !== null,
        note: '索引状态含「已构建」=' + (built === true) + '；分片写入回执=' + (sharded === true) +
          '；「林渊」结果：' + first + '；「测试设定」命中行数=' + (hits === null ? 0 : hits),
      };
    `,
  },
  {
    step: 10,
    title: "编辑器页：源码形态挂载 + 富文本形态切换（T2-1 切片 A/B）",
    file: "step10-editor.png",
    body: String.raw`
      await tab('编辑器');
      const cm = await waitFor(() => document.querySelector('.cm-host .cm-editor'), 12000);
      if (!cm) return { ok: false, note: '编辑器未挂载（.cm-editor 缺失）：' + pageText() };
      const doc = await waitFor(() => {
        const el = document.querySelector('.cm-content');
        return el && el.textContent && el.textContent.length > 0 ? el.textContent : null;
      }, 10000);
      const statusOk = document.body.innerText.includes('实时');
      const richBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('富文本'));
      if (!richBtn) return { ok: false, note: '找不到富文本切换按钮：' + pageText() };
      richBtn.click();
      const tiptap = await waitFor(() => document.querySelector('.tiptap-host .tiptap'), 8000);
      const tiptapText = tiptap ? String(tiptap.textContent || '') : '';
      const srcBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('源码'));
      if (srcBtn) {
        srcBtn.click();
        await sleep(300);
      }
      const backOk = await waitFor(() => document.querySelector('.cm-host .cm-editor'), 8000);
      return {
        ok: cm !== null && doc !== null && statusOk && tiptap !== null && tiptapText.length > 0 && backOk !== null,
        note:
          'CodeMirror 已挂载；正文前 40 字=' + String(doc).slice(0, 40) +
          '；富文本已挂载=' + (tiptap !== null) + '（富文本正文前 30 字=' + tiptapText.slice(0, 30) + '）' +
          '；已切回源码=' + (backOk !== null) + '；含实时字数=' + statusOk,
      };
    `,
  },
  {
    step: 11,
    title: "编辑器：实体 @ 提及装饰 + 提及面板 + 跳转档案（T2-2）",
    file: "step11-mentions.png",
    body: String.raw`
      await tab('编辑器');
      const outline = await window.yushu.outline.read();
      const vol = outline.doc.volumes[0];
      const chap = vol.chapters[0];
      await window.yushu.ai.adopt({ usageId: 'walkthrough-mention', volumeId: vol.id, chapterId: chap.id, text: '\n\n@测试设定1 走进了夜色里。', mode: 'append' });
      const item = await waitFor(() => document.querySelector('.draft-list li'), 8000);
      if (!item) return { ok: false, note: '找不到草稿章节列表项：' + pageText() };
      // 选章是真按钮（键盘可达），所以这里点它里面的 button；没有就说明可达性回归了
      const itemBtn = item.querySelector('button');
      if (itemBtn === null) return { ok: false, note: '草稿章节列表项里没有 button（键盘可达性回归）' };
      itemBtn.click();
      const decorated = await waitFor(() => document.querySelector('.cm-content .entity-mention'), 12000);
      const panel = await waitFor(() => document.querySelector('.mention-panel'), 8000);
      const panelText = panel ? String(panel.textContent || '') : '';
      const chip = panel ? [...panel.querySelectorAll('button')].find((b) => b.textContent.includes('测试设定')) : null;
      let jumped = false;
      if (chip) {
        chip.click();
        await sleep(500);
        jumped = document.body.innerText.includes('世界观档案') && document.querySelector('.archive') !== null;
      }
      return {
        ok: decorated !== null && panelText.includes('测试设定1') && chip !== null && jumped,
        note:
          '实体提及装饰=' + (decorated !== null) +
          '；提及面板=' + panelText.slice(0, 50) +
          '；点击跳转档案并选中=' + jumped,
      };
    `,
  },
  {
    step: 12,
    title: "编辑器：自动保存落盘 + frontmatter 字数同步（T2-6 切片）",
    file: "step12-autosave.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!ie) return { ok: false, note: '编辑器调试句柄 __yushuEditorDebug 未暴露（__yushuDebug 未开启？）' };
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!view) return { ok: false, note: '调试句柄 window.__yushuCmView 未暴露' };
      const drafts = await window.yushu.ai.drafts();
      const target = drafts[0];
      if (!target) return { ok: false, note: '无草稿章节：' + pageText() };
      const disk = await window.yushu.chapter.read(target.chapterPath);
      // 经调试句柄执行「等价于点击已选中章节」的强制重载并 await 完成：step11 经 ai.adopt 写过盘，
      // 编辑器必须先对齐磁盘（否则自动保存会因 baseHash 冲突冻结）；await 消除异步重载覆盖后续输入的竞态
      await ie.reload();
      if (view.state.doc.toString() !== disk.body) {
        return { ok: false, note: '重载后编辑器仍未对齐磁盘版本：编辑器末尾=' + JSON.stringify(String(view.state.doc.toString()).slice(-30)) };
      }
      // 模拟真实输入：经 CodeMirror 事务插入（等价键入触发 updateListener → 自动保存调度）
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n自动保存测试段落。' } });
      const saved = await waitFor(() => {
        const el = document.querySelector('.autosave-status');
        return el && el.textContent.includes('已自动保存') ? el.textContent : null;
      }, 12000);
      if (saved === null) {
        const el = document.querySelector('.autosave-status');
        return { ok: false, note: '自动保存未在 12s 内完成：当前状态=' + (el ? el.textContent : '(元素缺失)') + ' ｜ ' + pageText() };
      }
      const reread = await window.yushu.chapter.read(target.chapterPath);
      const persisted = reread.body.includes('自动保存测试段落。');
      const expectedWords = reread.body.replace(/\s+/g, '').length;
      const wordsSynced = reread.wordCount === expectedWords;
      return {
        ok: persisted && wordsSynced,
        note:
          '自动保存状态=' + saved +
          '；重新读盘（' + target.chapterPath + '）含「自动保存测试段落。」=' + persisted +
          '；frontmatter 字数=' + reread.wordCount + '（正文实际=' + expectedWords + '，一致=' + wordsSynced + '）',
      };
    `,
  },
  {
    step: 13,
    title: "写作视图：无干扰（专注）模式 + 打字机滚动（T2-3 切片 A）",
    file: "step13-focus.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!ie || !view) return { ok: false, note: '编辑器调试句柄未暴露：' + pageText() };
      await ie.reload();
      // 铺 40 行文本使编辑器可滚动（打字机滚动才有意义）
      const filler = [];
      for (let i = 1; i <= 40; i += 1) filler.push('第 ' + i + ' 行：专注模式下的打字机滚动验证文本。');
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' + filler.join('\n') } });
      const focusBtn = [...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent.includes('专注'));
      if (!focusBtn) return { ok: false, note: '找不到「专注模式」按钮：' + pageText() };
      focusBtn.click();
      await sleep(350);
      const tabsHidden = document.querySelector('.tabs').offsetParent === null;
      const asideHidden = document.querySelector('.chapter-editor aside').offsetParent === null;
      const hintShown = document.querySelector('.focus-hint') !== null;
      // 光标移到文档中部 → 打字机滚动应把该行带到视口中央附近
      // （注意：光标在文末时滚动会被 clamp 到最底部，末尾行无法居中，属正确行为，故取中部）
      const mid = Math.floor(view.state.doc.length / 2);
      view.dispatch({ selection: { anchor: mid } });
      await sleep(350);
      const pos = view.state.selection.main.head;
      const block = view.lineBlockAt(pos);
      const vp = view.scrollDOM.clientHeight;
      const scrolled = view.scrollDOM.scrollTop;
      const delta = Math.abs(block.top + block.height / 2 - scrolled - vp / 2);
      const centered = delta < 120;
      // Esc 退出专注模式
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(350);
      const tabsBack = document.querySelector('.tabs').offsetParent !== null;
      const hintGone = document.querySelector('.focus-hint') === null;
      // 停留在专注模式供截图取证（Esc 退出路径已在上面验证）
      focusBtn.click();
      await sleep(350);
      return {
        ok: tabsHidden && asideHidden && hintShown && scrolled > 0 && centered && tabsBack && hintGone,
        note: '标签栏隐藏=' + tabsHidden + '；侧栏隐藏=' + asideHidden + '；提示可见=' + hintShown +
          '；scrollTop=' + Math.round(scrolled) + '；光标行居中偏差=' + Math.round(delta) + 'px（<120 判定=' + centered + '）' +
          '；Esc 退出后标签栏恢复=' + tabsBack + '、提示消失=' + hintGone,
      };
    `,
  },
  {
    step: 14,
    title: "写作视图：双栏对照（左设定右正文）（T2-3 切片 B）",
    file: "step14-split.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!ie) return { ok: false, note: '编辑器调试句柄未暴露：' + pageText() };
      await ie.reload();
      const splitBtn = [...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent.includes('双栏'));
      if (!splitBtn) return { ok: false, note: '找不到「双栏对照」按钮：' + pageText() };
      splitBtn.click();
      const col = await waitFor(() => document.querySelector('.setting-column'), 8000);
      const card = await waitFor(() => {
        const el = document.querySelector('.setting-column .setting-card');
        return el && el.textContent.includes('测试设定1') ? el : null;
      }, 8000);
      if (!col || !card) {
        return { ok: false, note: '设定栏未出现或未加载到「测试设定1」：' + (col ? String(card && card.textContent) : '(无设定栏)') };
      }
      const excerpt = card.querySelector('.setting-excerpt');
      const excerptText = excerpt ? String(excerpt.textContent) : '';
      const panelEl = document.querySelector('.mention-panel');
      const panelHidden = panelEl === null || panelEl.offsetParent === null;
      // 打开设定卡 → 跳转档案页并选中
      const openBtn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('打开设定卡'));
      if (!openBtn) return { ok: false, note: '找不到「打开设定卡」按钮' };
      openBtn.click();
      await sleep(500);
      const jumped = document.body.innerText.includes('世界观档案') && document.querySelector('.archive') !== null;
      // 回编辑器并重开双栏（切页会卸载编辑器视图，开关状态不保留）——同时用于截图取证
      await tab('编辑器');
      const splitBtn2 = await waitFor(() => {
        const b = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('双栏'));
        return b && !b.disabled ? b : null;
      }, 8000);
      if (splitBtn2) {
        splitBtn2.click();
        await sleep(400);
      }
      const cardBack = await waitFor(() => (document.querySelector('.setting-column .setting-card') ? true : null), 10000);
      const colBack = document.querySelector('.setting-column') !== null;
      return {
        ok: col !== null && card !== null && excerptText.includes('测试设定1') && panelHidden && jumped && cardBack === true,
        note: '设定栏出现=' + (col !== null) + '；卡片含「测试设定1」=' + (card !== null) +
          '；摘要=' + JSON.stringify(excerptText.slice(0, 40)) +
          '；底部提及面板隐藏=' + panelHidden + '；打开设定卡跳转档案=' + jumped +
          '；切页返回后重开双栏=' + colBack + '、加载卡片=' + (cardBack === true),
      };
    `,
  },
  {
    step: 15,
    title: "项目文件：索引增量重建（复用未变文件）（T2-5 切片 A）",
    file: "step15-incremental.png",
    body: String.raw`
      await tab('项目文件');
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '增量重建');
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!btn) return { ok: false, note: '「增量重建」按钮不可用（索引尚未构建？）：' + pageText() };
      btn.click();
      const done = await waitFor(() => (document.body.innerText.includes('索引已重建（增量') ? true : null), 20000);
      if (done === null) return { ok: false, note: '未出现增量重建回执：' + pageText() };
      const text = document.body.innerText;
      const m = text.match(/增量：复用 (\d+) · 更新 (\d+) · 移除 (\d+) 个文件 · 解析 ([^）\n]+)/);
      const reused = m ? Number(m[1]) : -1;
      const updated = m ? Number(m[2]) : -1;
      const via = m ? m[4].trim() : '(未匹配)';
      return {
        ok: reused > 0 && updated >= 0 && via === 'utility 进程',
        note: '增量回执=' + (m ? m[0] : '(未匹配)') + '；复用>0=' + (reused > 0) + '；更新=' + updated + '；解析=' + via,
      };
    `,
  },
  {
    step: 16,
    title: "保存即增量：编辑器输入后索引自动刷新（T2-5 切片 B）",
    file: "step16-auto-index.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!ie || !view) return { ok: false, note: '编辑器调试句柄未暴露：' + pageText() };
      await ie.reload();
      // 经真实 CodeMirror 事务输入唯一短语 → 自动保存成功后触发后台增量刷新
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n落霞峰上剑气纵横。' } });
      const saved = await waitFor(() => {
        const el = document.querySelector('.autosave-status');
        return el && el.textContent.includes('已自动保存') ? true : null;
      }, 12000);
      if (saved === null) return { ok: false, note: '自动保存未完成：' + pageText() };
      // 切到项目文件页：不点任何重建按钮，等「自动增量：已同步」出现后检索新内容
      await tab('项目文件');
      const input = await waitFor(() => document.querySelector('.dir-row input'), 10000);
      const searchBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '检索');
      if (!input || !searchBtn) return { ok: false, note: '找不到检索输入框/按钮：' + pageText() };
      let synced = false;
      let hits = 0;
      for (let i = 0; i < 60; i += 1) {
        if (document.body.innerText.includes('自动增量：已同步')) synced = true;
        setV(input, '落霞峰');
        await sleep(120);
        searchBtn.click();
        await sleep(220);
        hits = document.querySelectorAll('.search-results li').length;
        if (synced && hits > 0) break;
        await sleep(200);
      }
      return {
        ok: synced && hits > 0,
        note: '未点击重建按钮；「自动增量：已同步」可见=' + synced + '；检索「落霞峰」命中行数=' + hits,
      };
    `,
  },
  {
    step: 17,
    title: "项目文件：本地快照（立即快照 → 列表 → 恢复二次确认）（T2-7 切片 A）",
    file: "step17-snapshot.png",
    body: String.raw`
      await tab('项目文件');
      const takeBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '立即快照');
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!takeBtn) return { ok: false, note: '找不到「立即快照」按钮：' + pageText() };
      const before = document.querySelectorAll('.snapshots li').length;
      takeBtn.click();
      const taken = await waitFor(() => {
        const items = [...document.querySelectorAll('.snapshots li')];
        return items.length > before && items.some((li) => li.textContent.includes('手动')) ? true : null;
      }, 20000);
      if (taken === null) {
        return { ok: false, note: '手动快照未出现在列表（当前 ' + document.querySelectorAll('.snapshots li').length + ' 条）：' + pageText() };
      }
      // 恢复入口：点「恢复」出现页内二次确认（防手滑）；预演点「取消」，不真正回滚本预演内容
      // （恢复的"写回 / 重建 / 新增保留 / 恢复前快照"文件级验证由 e2e 探针完成）
      const restoreBtn = [...document.querySelectorAll('.snapshots li button')].find((b) => b.textContent.trim() === '恢复');
      if (!restoreBtn) return { ok: false, note: '快照条目缺少「恢复」按钮：' + pageText() };
      restoreBtn.click();
      await sleep(300);
      const confirmBtn = [...document.querySelectorAll('.snapshot-confirm button')].find((b) => b.textContent.trim() === '确认恢复');
      const cancelBtn = [...document.querySelectorAll('.snapshot-confirm button')].find((b) => b.textContent.trim() === '取消');
      if (!confirmBtn || !cancelBtn) return { ok: false, note: '二次确认行未出现：' + pageText() };
      cancelBtn.click();
      await sleep(200);
      const confirmGone = document.querySelectorAll('.snapshot-confirm button').length === 0;
      const firstItem = document.querySelector('.snapshots li');
      return {
        ok: taken === true && confirmGone,
        note: '快照列表 ' + document.querySelectorAll('.snapshots li').length + ' 条（最新：' + lines(firstItem) + '）' +
          '；二次确认行出现并可取消=' + confirmGone,
      };
    `,
  },
  {
    step: 18,
    title: "码字统计：今日净增记账 / 目标设置（T2-9 切片 A）",
    file: "step18-stats.png",
    body: String.raw`
      await tab('码字统计');
      const today = await waitFor(() => document.querySelector('.stats-today-main'), 12000);
      if (!today) return { ok: false, note: '统计面板未出现：' + pageText() };
      const match = String(today.textContent).match(/今日\s*([\d,]+)\s*字/);
      const todayWords = match ? Number(match[1].replace(/,/g, '')) : -1;
      // 设置每日目标 2000 → 回执 + 面板「/ 目标」文本更新（含进度条与柱状图）
      const input = document.querySelector('.stats-goal input');
      const saveBtn = [...document.querySelectorAll('.stats-goal button')].find((b) => b.textContent.includes('保存目标'));
      if (!input || !saveBtn) return { ok: false, note: '找不到目标输入/保存按钮：' + pageText() };
      setV(input, '2000');
      saveBtn.click();
      const saved = await waitFor(() => (document.body.innerText.includes('已设置每日目标 2,000 字') ? true : null), 12000);
      const goalShown = await waitFor(() => {
        const el = document.querySelector('.stats-today-main');
        return el && String(el.textContent).includes('/ 目标 2,000 字') ? true : null;
      }, 8000);
      const bars = document.querySelectorAll('.stats-bar').length;
      const progressShown = document.querySelector('.stats-progress-bar') !== null;
      return {
        ok: todayWords > 0 && saved === true && goalShown === true && progressShown && bars >= 28,
        note: '今日字数=' + todayWords + '；目标保存回执=' + (saved === true) +
          '；目标进度可见=' + (goalShown === true) + '（进度条=' + progressShown + '）；柱状图 ' + bars + ' 根',
      };
    `,
  },
  {
    step: 19,
    title: "会话异常退出检测：上次会话未正常退出提示（T2-8 切片 B）",
    file: "step19-session.png",
    body: String.raw`
      // 本项目在挂载前写入了模拟崩溃标记（旧 pid），走真实检出路 → 横幅应自进入项目起可见
      const banner = await waitFor(() => document.querySelector('.session-banner'), 12000);
      if (!banner) return { ok: false, note: '会话提示横幅未出现：' + pageText() };
      const text = String(banner.textContent);
      const titleShown = text.includes('上次会话未正常退出');
      const snapshotHint = text.includes('本地快照');
      return {
        ok: titleShown && snapshotHint,
        note: '横幅文本：' + text.replace(/\s+/g, ' ').slice(0, 120),
      };
    `,
  },
  {
    step: 20,
    title: "码字统计：有效字数与档位 / 节奏曲线 / 写作日历热力图（T2-9 切片 B）",
    file: "step20-stats-b.png",
    body: String.raw`
      await tab('码字统计');
      const effective = await waitFor(() => document.querySelector('.stats-effective'), 12000);
      if (!effective) return { ok: false, note: '有效字数行未出现：' + pageText() };
      const effText = String(effective.textContent);
      const effectiveShown = effText.includes('有效字数') && effText.includes('4,000 普通 / 6,000 进阶');
      const tierText = String(effective.querySelector('.stats-tier')?.textContent ?? '');
      const tierShown = /(未达标|普通档|进阶档)/.test(tierText);
      const line = document.querySelector('.stats-speed svg polyline.speed-line');
      const speedPoints = line ? (line.getAttribute('points') || '').split(' ').filter(Boolean).length : 0;
      const cells = document.querySelectorAll('.stats-heat-grid .heat-cell').length;
      // 滚动到切片 B 区域（节奏曲线 + 热力图）：让截图证据拍到新 UI，再点击热力格查看单日详情
      const heatmap = document.querySelector('.stats-heatmap');
      if (heatmap) heatmap.scrollIntoView({ block: 'center' });
      await sleep(150);
      const firstCell = document.querySelector('.stats-heat-grid .heat-cell');
      if (firstCell) firstCell.click();
      const picked = await waitFor(() => (document.querySelector('.heat-foot .muted') ? true : null), 8000);
      return {
        ok: effectiveShown && tierShown && speedPoints >= 30 && cells >= 84 && picked === true,
        note: '有效字数行=' + effectiveShown + '（档位标签「' + tierText + '」）；速度曲线点数=' + speedPoints +
          '；热力格=' + cells + '；点击详情=' + (picked === true),
      };
    `,
  },
  {
    step: 21,
    title: "编辑器：富文本形态 @ 候选菜单（触发 / 过滤 / Esc / 键盘与点击插入）（T2-2）",
    file: "step21-rich-mention.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!ie) return { ok: false, note: '编辑器调试句柄未暴露：' + pageText() };
      await ie.reload(); // 对齐磁盘，确保后续输入从干净状态开始
      const richBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('富文本'));
      if (!richBtn) return { ok: false, note: '找不到富文本切换按钮：' + pageText() };
      richBtn.click();
      const tiptap = await waitFor(() => document.querySelector('.tiptap-host .tiptap'), 8000);
      if (!tiptap) return { ok: false, note: '富文本编辑器未挂载：' + pageText() };
      await sleep(300); // 等 modeRef 更新（切换后的输入才会计入富文本管线）
      // 真实输入模拟：聚焦 + 光标置文末段落末尾 + execCommand insertText（走 ProseMirror 输入管线）
      // （typeText 每次重新取元素：切形态会卸载/重挂载 .tiptap 宿主）
      const typeText = (text) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return;
        el.focus();
        const last = el.lastElementChild || el;
        const range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      };
      // press 每次重新取元素：tiptap 宿主会随形态切换被卸载重挂载，闭包捕获旧节点会让按键打到失效元素上
      // （step21 长期偶发抖动的根因就在这里——typeText 早就按这条写法改过，press 漏了）
      const press = (key) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return false;
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        return true;
      };
      // 计数口径：完整提及 @测试设定N 出现次数；atCount = 全文 @ 总数——
      // 「插入成功」与「查询词无残留」合并为 atCount === fullCount（所有 @ 都属于完整提及）
      const fullCount = () => (String(tiptap.textContent).match(/@测试设定\d/g) || []).length;
      const atCount = () => (String(tiptap.textContent).match(/@/g) || []).length;
      const fullBefore = fullCount();
      // 1) 输入 @ → 候选菜单出现（空查询显示全部设定卡）
      typeText('@');
      const menu = await waitFor(() => document.querySelector('.mention-menu'), 4000);
      if (!menu) return { ok: false, note: '输入 @ 后未出现候选菜单：' + pageText() };
      const allCount = document.querySelectorAll('.mention-menu li').length;

      // 2) Esc 关闭菜单，并清理本次留下的 @（避免污染后续计数）
      press('Escape');
      const escClosed = await waitFor(() => (document.querySelector('.mention-menu') === null ? true : null), 4000);
      document.execCommand('delete');
      await sleep(200);
      const cleaned = atCount() === fullCount();
      // 3) 键盘路径：输入 @测试 → ↓ 移动高亮 → 回车插入
      typeText('@测试');
      const fiveItems = await waitFor(() => {
        const n = document.querySelectorAll('.mention-menu li').length;
        return n >= 5 ? n : null;
      }, 4000);
      if (fiveItems === null) {
        const el = document.querySelector('.mention-menu');
        return { ok: false, note: '输入「@测试」后候选数异常（菜单' + (el ? lines(el) : '已消失') + '）：' + pageText() };
      }
      // 高亮起点**不假定是第 1 项**：真鼠标若正停在候选区上，mouseenter 会把 active 挪到悬停那一项
      // （本机实测撞过：连续两轮 ↓ 后高亮落在第 5 项，而组件语义 (active+1)%n 完全正确）。
      // 所以这里断言的是产品契约——「↓ 让高亮移动一格，回车插入的正是移动后那一格」，
      // 而不是「高亮必须在第 2 项」这个鼠标位置的巧合。
      const menuLis = () => [...document.querySelectorAll('.mention-menu li')];
      const activeOf = () => menuLis().findIndex((li) => li.className.includes('on'));
      const beforeIdx = activeOf();
      press('ArrowDown');
      await sleep(150);
      const itemCount = menuLis().length;
      const activeIdx = activeOf();
      const movedOk = itemCount >= 5 && beforeIdx >= 0 && activeIdx === (beforeIdx + 1) % itemCount;
      const pickedName = activeIdx >= 0 ? String((menuLis()[activeIdx].querySelector('strong') || {}).textContent || '') : '';
      press('Enter');
      const keyboardInserted = await waitFor(
        () => (fullCount() === fullBefore + 1 && atCount() === fullCount() && document.querySelector('.mention-menu') === null
          && pickedName !== '' && String(tiptap.textContent).indexOf('@' + pickedName) >= 0 ? true : null),
        4000,
      );
      // 4) 点击路径：输入「 @测试」（空格分隔——@ 前一字符若为 ASCII 数字/字母属邮箱防误触场景，不触发候选）→ 点「测试设定5」
      typeText(' @测试');
      await waitFor(() => (document.querySelectorAll('.mention-menu li').length >= 5 ? true : null), 4000);
      const target = await waitFor(() => {
        const li = [...document.querySelectorAll('.mention-menu li')].find((x) => x.textContent.includes('测试设定5'));
        return li || null;
      }, 4000);
      if (!target) return { ok: false, note: '候选列表未找到「测试设定5」：' + lines(document.querySelector('.mention-menu')) };
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      const clickInserted = await waitFor(
        () => (fullCount() === fullBefore + 2 && atCount() === fullCount() && document.querySelector('.mention-menu') === null ? true : null),
        4000,
      );
      // 5) 跨形态一致性：切源码 → CodeMirror 文档含新提及 + 提及面板同步 + 源码装饰高亮
      const srcBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('源码'));
      if (srcBtn) srcBtn.click();
      await sleep(500);
      const cmDoc = window.__yushuCmView ? String(window.__yushuCmView.state.doc.toString()) : '';
      const cmHasNew = cmDoc.includes('@测试设定5') && /@测试设定\d/.test(cmDoc);
      const panelText = String((document.querySelector('.mention-panel') || {}).textContent || '');
      const panelSynced = panelText.includes('测试设定1') && panelText.includes('测试设定5');
      const decorated = document.querySelectorAll('.cm-content .entity-mention').length;
      // 6) 切回富文本并保持候选菜单开启：供截图取证「菜单 UI 与候选列表」（空格分隔规避邮箱防误触）
      const richBtn2 = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('富文本'));
      if (richBtn2) richBtn2.click();
      await waitFor(() => (document.querySelector('.tiptap-host .tiptap') ? true : null), 8000);
      await sleep(300);
      typeText(' @测试');
      const menuShot = (await waitFor(() => (document.querySelector('.mention-menu') ? true : null), 4000)) === true;
      return {
        ok:
          allCount >= 5 && escClosed === true && cleaned && fiveItems !== null && movedOk &&
          keyboardInserted === true && clickInserted === true && cmHasNew && panelSynced && decorated >= 2 && menuShot,
        note:
          '空查询候选=' + allCount + '；Esc 关闭=' + escClosed + '；键盘路径（↓ 把高亮从第 ' + (beforeIdx + 1) + ' 项移到第 ' + (activeIdx + 1) + ' 项，回车插入「@' + pickedName + '」）=' + (keyboardInserted === true) +
          '；点击「测试设定5」插入=' + (clickInserted === true) + '；切源码后文档含新提及=' + cmHasNew +
          '；提及面板同步=' + panelSynced + '；源码形态装饰数=' + decorated +
          '；截图时菜单开启=' + menuShot,
      };
    `,
  },
  {
    step: 22,
    title: "编辑器：外部改动自动三方合并（T2-6 完整版）",
    file: "step22-auto-merge.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!ie || !view) return { ok: false, note: '编辑器调试句柄未暴露：' + pageText() };
      // 经产品「重新载入」先 flush 再强载：把上一步（截图用）的待保存输入确定落盘并复位编辑器——
      // 否则「本地待保存 + 外部改动」在补丁窗口内竞态，合并的 base 与磁盘不一致会保守判冲突
      const reloadBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('重新载入'));
      if (reloadBtn && !reloadBtn.disabled) reloadBtn.click();
      await sleep(700);
      await ie.reload(); // 双重保险：确保调试句柄下内容为磁盘态
      // 切到源码形态（本地编辑经真实 CM 事务；外部改动以 Markdown 文本为准）
      const srcBtn = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('源码'));
      if (srcBtn && !srcBtn.disabled) { srcBtn.click(); await sleep(300); }
      const drafts = await window.yushu.ai.drafts();
      const path = drafts[0] && drafts[0].chapterPath;
      if (!path) return { ok: false, note: '无草稿章节：' + pageText() };
      const localMarker = '本地续写（三方合并预演）。';
      const remoteMarker = '【外部开头改动】';
      const before = await window.yushu.chapter.read(path);
      // 基线诊断（排查用）：编辑器「上次已知磁盘内容」应恰为当前磁盘（否则三方合并会保守判冲突）
      const savedSnap = ie.saved ? ie.saved() : null;
      const baseDiag = savedSnap
        ? '基线/磁盘一致=' + (savedSnap.body === before.body) +
          '（基线 ' + savedSnap.body.length + ' 字 / 磁盘 ' + before.body.length + ' 字 / hash 一致=' + (savedSnap.hash === before.hash) + '）'
        : '基线句柄缺失';
      // 外部改动先行（不同区域：开头插入一行）→ 本地追加 → 自动保存必然撞 baseHash
      await window.yushu.chapter.write({ path, body: remoteMarker + '\n\n' + before.body, baseHash: before.hash });
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' + localMarker } });
      const merged = await waitFor(() => {
        const el = document.querySelector('.autosave-status');
        return el && el.textContent.includes('已自动保存') && document.body.innerText.includes('已自动合并外部改动') ? true : null;
      }, 15000);
      const after = await window.yushu.chapter.read(path);
      const bothKept = after.body.includes(remoteMarker) && after.body.includes(localMarker);
      const editorSynced = String(view.state.doc.toString()).includes(remoteMarker) && String(view.state.doc.toString()).includes(localMarker);
      const statusEl = document.querySelector('.autosave-status');
      const notFrozen = statusEl ? !statusEl.textContent.includes('暂停') : false;
      const statusText = statusEl ? String(statusEl.textContent) : '(无状态元素)';
      const errorEl = document.querySelector('.error-text');
      const errorText = errorEl ? String(errorEl.textContent).slice(0, 180) : '';
      return {
        ok: merged === true && bothKept && editorSynced && notFrozen,
        note: '自动合并完成=' + (merged === true) + '；磁盘含双方改动=' + bothKept +
          '；编辑器已同步合并结果=' + editorSynced + '；自动保存未冻结=' + notFrozen +
          '；' + baseDiag +
          '；自动保存状态=' + statusText + (errorText ? '；错误=' + errorText : ''),
      };
    `,
  },
  {
    step: 23,
    title: "稿件总览：全库视图 + 虚拟滚动 + 跳转编辑器（T2-4 切片 A）",
    file: "step23-library.png",
    body: String.raw`
      await tab('稿件总览');
      const head = await waitFor(() => document.querySelector('.library .panel-title'), 12000);
      if (!head) return { ok: false, note: '稿件总览未渲染：' + pageText() };
      const headText = String(head.textContent || '');
      const list = await waitFor(() => document.querySelector('.library-list'), 8000);
      if (!list) return { ok: false, note: '找不到虚拟列表容器：' + pageText() };
      const rowsTop = document.querySelectorAll('.library-row').length;
      const firstTop = String((document.querySelector('.library-row .library-idx') || {}).textContent || '');
      const spacer = document.querySelector('.library-spacer');
      const totalHeight = spacer ? spacer.offsetHeight : 0;
      // 滚动到中部：虚拟窗口应平移（渲染行不同、总数不变）
      list.scrollTop = Math.floor(totalHeight / 2);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(300);
      const rowsMid = document.querySelectorAll('.library-row').length;
      const firstMid = String((document.querySelector('.library-row .library-idx') || {}).textContent || '');
      const totalChapters = Number((headText.match(/共\s*(\d+)\s*章/) || [])[1] || 0);
      const draftedMatch = headText.match(/已建草稿\s*(\d+)/);
      const virtualized = totalChapters > rowsMid && rowsMid > 0;
      const windowMoved = firstTop !== '' && firstMid !== '' && firstTop !== firstMid;
      // 回到顶部并「打开」第一章（已建草稿）→ 跳转编辑器并选中
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(300);
      const openBtn = [...document.querySelectorAll('.library-row button')].find((b) => !b.disabled);
      if (!openBtn) return { ok: false, note: '没有可打开的草稿章节：' + pageText() };
      openBtn.click();
      const editorTab = await waitFor(() => {
        const on = document.querySelector('.tab.on');
        return on && on.textContent.includes('编辑器') ? true : null;
      }, 8000);
      const selected = await waitFor(() => (document.querySelector('.draft-list li.on') ? true : null), 8000);
      // 回到总览供截图取证（跳转断言已在上方完成）
      await tab('稿件总览');
      await sleep(300);
      return {
        ok: headText.includes('共') && draftedMatch !== null && rowsTop > 0 && virtualized && windowMoved && editorTab === true && selected === true,
        note: '汇总：' + headText.replace(/\s+/g, ' ').slice(0, 80) +
          '；虚拟滚动：总章数=' + totalChapters + ' 顶部渲染=' + rowsTop + ' 中部渲染=' + rowsMid +
          '（只渲染视窗窗口=' + virtualized + '，滚动后首行 ' + firstTop + '→' + firstMid + '=' + windowMoved + '）' +
          '；「打开」跳转编辑器=' + (editorTab === true) + '，草稿列表选中=' + (selected === true),
      };
    `,
  },
  {
    step: 24,
    title: "码字统计：写作会话与真实速度（活动心跳 → 今日速度）（T2-9 切片 C）",
    file: "step24-stats-speed.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!view) return { ok: false, note: 'CodeMirror 未挂载：' + pageText() };
      // 对齐磁盘（前序步骤有外部改动）后经真实 CodeMirror 事务输入——updateDerived 触发活动心跳（首键即上报）
      await ie.reload();
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n会话速度验证段落。' } });
      await sleep(600);
      // 切到码字统计：今日速度行（字/分钟 / 活跃 / 会话数）应已由心跳记账驱动
      await tab('码字统计');
      const speedRow = await waitFor(() => document.querySelector('.stats-speed-today'), 12000);
      if (!speedRow) return { ok: false, note: '统计页未出现「今日速度」行：' + pageText() };
      const rowText = String(speedRow.textContent || '').replace(/\s+/g, ' ').trim();
      const sessions = Number((rowText.match(/·\s*(\d+)\s*个会话/) || [])[1] || -1);
      const apiState = await window.yushu.stats.read();
      const apiActiveMs = apiState.today.activeMs;
      const apiSessions = apiState.today.sessions;
      return {
        ok:
          rowText.includes('今日速度') && rowText.includes('活跃') && sessions >= 1 &&
          apiSessions >= 1 && apiActiveMs >= 0,
        note:
          '今日速度行="' + rowText + '"；UI 会话数=' + sessions +
          '；心跳回执：活跃 ' + apiActiveMs + 'ms / 会话 ' + apiSessions +
          '（真实键入触发；空闲 ≥2 分钟不计，首次键入即开新会话）',
      };
    `,
  },
  {
    step: 25,
    title: "项目文件：版本管理（Git）——初始化 / 一次批量改动 = 一次提交（T2-7 切片 B）",
    file: "step25-git.png",
    body: String.raw`
      await tab('项目文件');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel-title')].find((x) => x.textContent.includes('版本管理（Git'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到 Git 面板：' + pageText() };
      // 全新项目应为未初始化 → 初始化仓库（main 分支）
      const initBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '初始化仓库');
      const wasUninitialized = initBtn !== undefined;
      if (initBtn) initBtn.click();
      const stateLine = await waitFor(() => {
        const matched = panel.innerText.match(/变更 \d+ 个文件/);
        return matched ? panel.innerText : null;
      }, 20000);
      if (!stateLine) return { ok: false, note: '初始化后未出现状态行：' + panel.innerText.slice(0, 200) };
      const changesBefore = Number((stateLine.match(/变更 (\d+) 个文件/) || [])[1] || 0);
      // 输入提交信息 → 提交全部变更（一次批量改动 = 一次提交）
      const input = panel.querySelector('.git-commit-row input');
      if (!input) return { ok: false, note: '找不到提交信息输入框：' + panel.innerText.slice(0, 200) };
      setV(input, '预演：批量改动一次提交');
      const commitBtn = await waitFor(() => {
        const b = [...panel.querySelectorAll('button')].find((x) => x.textContent.includes('提交全部变更'));
        return b && !b.disabled ? b : null;
      }, 8000);
      if (!commitBtn) return { ok: false, note: '提交按钮不可用：' + panel.innerText.slice(0, 200) };
      commitBtn.click();
      const committed = await waitFor(
        () => (panel.innerText.includes('已提交') && panel.innerText.includes('预演：批量改动一次提交') ? true : null),
        20000,
      );
      const logCount = panel.querySelectorAll('.git-log li').length;
      const headMatch = panel.innerText.match(/HEAD ([0-9a-f]{10})/);
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: wasUninitialized && committed === true && changesBefore > 0 && logCount >= 1 && headMatch !== null,
        note:
          '未初始化态=' + wasUninitialized + '；提交前变更=' + changesBefore + ' 个文件；提交回执=' + (committed === true) +
          '；提交列表=' + logCount + ' 条；HEAD=' + (headMatch ? headMatch[1] : '(未匹配)') +
          '（提交后变更应归零；回滚须二次确认，保留 pre_restore 快照）',
      };
    `,
  },
  {
    step: 26,
    title: "AI 副驾：Provider v2 能力矩阵展示（kind / protocol / models / limits，T3-1）",
    file: "step26-ai-provider-v2.png",
    body: String.raw`
      await tab('AI 副驾');
      const card = await waitFor(() => {
        const provider = [...document.querySelectorAll('.provider')].find((x) => x.textContent.includes('mock'));
        return provider || null;
      }, 12000);
      if (!card) return { ok: false, note: '未找到 mock provider 卡片：' + pageText() };
      card.scrollIntoView({ block: 'center' });
      await sleep(200);
      const text = card.innerText;
      const has = (s) => text.includes(s);
      return {
        ok: has('mock-model') && has('旗舰') && has('本地') && has('openai_chat') && has('流式') && has('上下文 32768'),
        note: 'Provider 卡片：' + text.replace(/\n+/g, ' | ').slice(0, 240),
      };
    `,
  },
  {
    step: 27,
    title: "AI 副驾：任务路由与可靠性展示（config/routing.yaml，T3-2）",
    file: "step27-ai-routing.png",
    body: String.raw`
      await tab('AI 副驾');
      const line = await waitFor(() => document.querySelector('.routing-line'), 12000);
      if (!line) return { ok: false, note: '未找到路由摘要行：' + pageText() };
      line.scrollIntoView({ block: 'center' });
      await sleep(200);
      const text = line.innerText;
      const has = (s) => text.includes(s);
      return {
        ok: has('路由（config/routing.yaml）') && has('drafting → 旗舰') && has('require：流式') && has('重试 5') && has('冷却 30s') && has('并发 4'),
        note: '路由摘要：' + text.slice(0, 200),
      };
    `,
  },
  {
    step: 28,
    title: "AI 副驾：本地模型接入与能力差异标注（T3-3 / T3-4）",
    file: "step28-ai-local.png",
    body: String.raw`
      await tab('AI 副驾');
      const privacy = await waitFor(
        () => ([...document.querySelectorAll('.provider')].map((x) => x.innerText).join('\n').includes('本地隐私模式') ? true : null),
        12000,
      );
      const warningsLine = await waitFor(() => {
        const list = document.querySelector('.warnings');
        return list && list.innerText.includes('未声明 capabilities') ? list.innerText : null;
      }, 8000);
      const addBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加');
      if (!addBtn) return { ok: false, note: '找不到「添加」按钮：' + pageText() };
      addBtn.click();
      // base_url 渲染在输入框（不在 innerText）：按输入值判定 ollama 卡片出现
      const baseOk = (card) => [...card.querySelectorAll('input')].some((input) => input.value.includes('127.0.0.1:11434'));
      const ollamaCard = await waitFor(() => {
        const card = [...document.querySelectorAll('.provider')].find((x) => x.innerText.includes('ollama'));
        return card && baseOk(card) ? card : null;
      }, 8000);
      if (!ollamaCard) {
        const cards = [...document.querySelectorAll('.provider')].map((x) => x.innerText.replace(/\n+/g, ' | ').slice(0, 80));
        return { ok: false, note: '预设添加后未出现 ollama 卡片；当前卡片=' + JSON.stringify(cards) };
      }
      const saveBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存 Provider 配置'));
      if (!saveBtn) return { ok: false, note: '找不到保存按钮：' + pageText() };
      saveBtn.click();
      const saved = await waitFor(() => (document.body.innerText.includes('配置已保存') ? true : null), 12000);
      const count = document.querySelectorAll('.provider').length;
      ollamaCard.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: privacy === true && warningsLine !== null && saved === true && count === 2 && ollamaCard.innerText.includes('本地隐私模式'),
        note:
          '隐私提示=' + (privacy === true) +
          '；能力标注="' + (warningsLine || '').replace(/\n+/g, ' | ').slice(0, 120) + '"' +
          '；预设添加=ollama(' + baseOk(ollamaCard) + ')' +
          '；保存回执=' + (saved === true) + '；provider 数=' + count,
      };
    `,
  },
{
    step: 29,
    title: "记忆：五层记忆（候选不入库 → 采纳 rev0 → 人工修订 rev1 保护 / 事实出处链，T3-5）",
    file: "step29-memory.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => document.querySelector('.memory'), 12000);
      if (!panel) return { ok: false, note: '记忆页未渲染：' + pageText() };
      // 选中有正文素材的章摘要目标
      const target = await waitFor(() => {
        const items = [...document.querySelectorAll('.memory-targets li')];
        return items.find((li) => li.innerText.includes('章摘要') && !li.innerText.includes('素材 0 字')) || null;
      }, 8000);
      if (!target) return { ok: false, note: '找不到有素材的章摘要目标：' + pageText() };
      // 列表行是真按钮（契约 §6：可点选的必须是键盘能到的控件），所以点它里面的 button
      const targetBtn = target.querySelector('button');
      if (targetBtn === null) return { ok: false, note: '章摘要目标里没有 button（键盘可达性回归）' };
      targetBtn.click();
      await sleep(250);
      const genBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '生成候选');
      if (!genBtn || genBtn.disabled) return { ok: false, note: '生成候选按钮不可用：' + pageText() };
      genBtn.click();
      const candidateReady = await waitFor(() => {
        const ta = document.querySelector('.memory-candidate');
        return ta && String(ta.value).trim().length > 0 ? true : null;
      }, 20000);
      if (candidateReady !== true) return { ok: false, note: '候选未生成：' + pageText() };
      // 候选未自动入库（state 中尚无摘要；面板仍显示未入库）
      const stateBefore = await window.yushu.memory.state();
      const notAutoSaved = stateBefore.summaries.length === 0;
      const revLineBefore = String((document.querySelector('.memory-summary-rev') || {}).textContent || '');
      // 采纳（AI 入库）→ rev 0
      const adoptBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('采纳候选'));
      if (!adoptBtn) return { ok: false, note: '找不到「采纳候选（AI 入库）」按钮：' + pageText() };
      adoptBtn.click();
      const aiSaved = await waitFor(() => {
        const el = document.querySelector('.memory-summary-rev');
        return el && el.textContent.includes('rev 0') ? true : null;
      }, 12000);
      // 人工修订 → rev 1（此后 AI 不得覆盖）
      const ta = document.querySelector('.memory-candidate');
      setV(ta, '人工修订：主角初入天启界，暗藏玄铁令伏笔。');
      const humanBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存人工修订');
      if (!humanBtn) return { ok: false, note: '找不到「保存人工修订」按钮：' + pageText() };
      humanBtn.click();
      const humanSaved = await waitFor(() => {
        const el = document.querySelector('.memory-summary-rev');
        return el && el.textContent.includes('rev 1') ? true : null;
      }, 12000);
      // AI 再入库 → 被拒（E_MEMORY_REV_PROTECTED：人工修订红线保护）
      const adoptBtn2 = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('采纳候选'));
      if (adoptBtn2) adoptBtn2.click();
      const rejected = await waitFor(() => {
        const el = document.querySelector('.error-text');
        return el && el.textContent.includes('E_MEMORY_REV_PROTECTED') ? true : null;
      }, 12000);
      // 事实台账：登记一条带出处的事实 → 出处有效徽标
      const chapterTarget = stateBefore.targets.find((t) => t.layer === 'chapter_summary' && t.sourceChars > 0);
      const keysInput = document.querySelector('.memory-fact-keys');
      const textInput = document.querySelector('.memory-fact-text');
      const startInput = document.querySelector('.memory-fact-start');
      const endInput = document.querySelector('.memory-fact-end');
      if (!keysInput || !textInput || !startInput || !endInput || !chapterTarget) {
        return { ok: false, note: '事实登记表单缺失：' + pageText() };
      }
      setV(keysInput, '天启界');
      setV(textInput, '主角在开篇抵达天启界。');
      setV(startInput, '0');
      setV(endInput, String(Math.min(6, chapterTarget.sourceChars)));
      const addBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '登记事实');
      if (!addBtn || addBtn.disabled) return { ok: false, note: '登记事实按钮不可用：' + pageText() };
      addBtn.click();
      const factOk = await waitFor(() => {
        const items = [...document.querySelectorAll('.memory-fact')];
        return items.some((li) => li.innerText.includes('出处有效')) ? true : null;
      }, 12000);
      const revLineAfter = String((document.querySelector('.memory-summary-rev') || {}).textContent || '');
      return {
        ok: notAutoSaved && aiSaved === true && humanSaved === true && rejected === true && factOk === true,
        note: '候选生成=' + (candidateReady === true) +
          '；候选未自动入库=' + notAutoSaved + '（入库前 rev 行="' + revLineBefore + '"）' +
          '；采纳后 rev0=' + (aiSaved === true) + '；人工修订后 rev1=' + (humanSaved === true) +
          '；AI 覆盖被拒=' + (rejected === true) +
          '；事实出处有效=' + (factOk === true) +
          '；rev 行="' + revLineAfter + '"',
      };
    `,
  },
  {
    step: 30,
    title: "记忆：注入控制与注入预演（trigger 命中 / 摘要常驻 / 排除原因，T3-6）",
    file: "step30-injection.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('注入预演'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到注入预演面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      // 事实台账显示注入配置摘要（step29 登记的事实：trigger · 优先级 50 · near_end · 400 token）
      const factInjection = [...document.querySelectorAll('.memory-fact-injection')].map((x) => String(x.textContent));
      const hasInjectionSummary = factInjection.some((text) => text.includes('trigger') && text.includes('优先级 50'));
      // 执行注入预演（默认目标 = 有素材的章摘要章节）
      const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '注入预演');
      if (!btn || btn.disabled) return { ok: false, note: '注入预演按钮不可用：' + pageText() };
      btn.click();
      const summaryLine = await waitFor(() => document.querySelector('.injection-preview'), 12000);
      if (!summaryLine) return { ok: false, note: '注入预演未返回：' + pageText() };
      const lineText = String(summaryLine.textContent);
      const injected = Number((lineText.match(/注入\s*(\d+)\s*条/) || [])[1] || 0);
      const excludedCount = Number((lineText.match(/排除\s*(\d+)\s*条/) || [])[1] || -1);
      const entries = [...document.querySelectorAll('.injection-entry')];
      const entryText = entries.map((x) => String(x.innerText)).join('\n');
      // 事实（keys 天启界）按正文提及触发；已入库摘要常驻注入
      const factTriggered = entryText.includes('trigger（命中') && entryText.includes('命中键：');
      const summaryAlways = entryText.includes('章摘要：') || entryText.includes('卷摘要：');
      const excludedList = [...document.querySelectorAll('.injection-excluded li')].map((x) => String(x.textContent)).join('\n');
      const excludedReasons = excludedList.includes('no_trigger') || excludedList.includes('no_manual') || excludedList.includes('reveal_gate');
      await sleep(200);
      return {
        ok: hasInjectionSummary && injected >= 1 && entries.length >= 1 && factTriggered && summaryAlways && excludedCount >= 1 && excludedReasons,
        note: '事实注入配置摘要=' + (hasInjectionSummary ? '含（trigger · 优先级 50）' : '缺失') +
          '；预演：' + lineText.replace(/\s+/g, ' ').slice(0, 120) +
          '；注入条目=' + entries.length + '（trigger 命中=' + factTriggered + '、摘要常驻=' + summaryAlways + '）' +
          '；排除=' + excludedCount + '（含原因清单=' + excludedReasons + '）',
      };
    `,
  },
  {
    step: 31,
    title: "记忆：上下文组装（固定槽位顺序 + 预算裁剪 + 去重，T3-7）",
    file: "step31-assembly.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('组装预演'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到组装预演面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      const findBtn = () => [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '组装预演');
      const btn = findBtn();
      if (!btn || btn.disabled) return { ok: false, note: '组装预演按钮不可用：' + pageText() };
      btn.click();
      const line = await waitFor(() => document.querySelector('.assembly-preview'), 12000);
      if (!line) return { ok: false, note: '组装预演未返回：' + pageText() };
      const lineText = String(line.textContent).replace(/\s+/g, ' ');
      const rows = [...document.querySelectorAll('.assembly-slot-row')];
      const rowText = rows.map((r) => String(r.innerText).replace(/\s+/g, ' ')).join(' | ');
      const slotsOk = rows.length === 8 && rowText.includes('system_prompt') && rowText.includes('recent_prose');
      const summaryOk = lineText.includes('预算 32000') && /合计 \d+ token/.test(lineText);
      // 小预算（40 token）：应出现逐出证据（reason=budget）且 system_prompt 仍在（只截断不丢）
      const budgetInput = panel.querySelector('.memory-assemble-budget');
      if (!budgetInput) return { ok: false, note: '找不到预算输入：' + pageText() };
      setV(budgetInput, '40');
      const btn2 = findBtn();
      if (btn2) btn2.click();
      const dropped = await waitFor(() => {
        const line = document.querySelector('.assembly-preview');
        const list = document.querySelector('.assembly-drop');
        // 同样要区分"旧节点"：只有小预算这次的回执（预算 40）配上逐出清单才算数
        if (!line || !list) return null;
        if (!String(line.textContent).replace(/\s+/g, ' ').includes('预算 40')) return null;
        return list.innerText.includes('budget') ? list.innerText : null;
      }, 12000);
      const smallLine = String((document.querySelector('.assembly-preview') || {}).textContent || '').replace(/\s+/g, ' ');
      const smallRows = [...document.querySelectorAll('.assembly-slot-row')];
      const systemRow = smallRows.find((r) => String(r.innerText).includes('system_prompt'));
      const systemKept = systemRow !== undefined && /^\S+\s+always\s+1\s/.test(String(systemRow.innerText).replace(/\s+/g, ' '));
      await sleep(200);
      return {
        ok: slotsOk && summaryOk && dropped !== null && smallLine.includes('预算 40') && systemKept,
        note: '默认：' + lineText.slice(0, 120) +
          '；槽位表 8 行=' + (rows.length === 8) + '（system_prompt / recent_prose 在列=' + slotsOk + '）' +
          '；小预算逐出证据="' + (dropped !== null ? String(dropped).replace(/\s+/g, ' ').slice(0, 90) : '无') + '"' +
          '；小预算 system_prompt 保留=' + systemKept +
          '；小预算回执="' + smallLine.slice(0, 80) + '"',
      };
    `,
  },
  {
    step: 32,
    title: "记忆：RAG 检索预演（向量 + bm25 双路召回 / RRF 融合 / 重排 top-6 / 出处，T3-8）",
    file: "step32-rag.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('RAG 检索预演'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到 RAG 检索预演面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      const input = panel.querySelector('.memory-rag-query');
      if (!input) return { ok: false, note: '找不到查询输入：' + pageText() };
      setV(input, '天启界');
      const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '检索预演');
      if (!btn || btn.disabled) return { ok: false, note: '检索预演按钮不可用：' + pageText() };
      btn.click();
      const line = await waitFor(() => document.querySelector('.rag-preview'), 12000);
      if (!line) return { ok: false, note: '检索预演未返回：' + pageText() };
      await sleep(150);
      const rows = [...document.querySelectorAll('.rag-hit-row')];
      const lineText = String(line.textContent).replace(/\s+/g, ' ');
      const rowText = rows.map((r) => String(r.innerText).replace(/\s+/g, ' ')).join(' | ');
      // 出处列：区间 [start, end) + 块 hash 前 8 位（hex）；至少一行来自章节（ch-*）
      const provenance = rows.length >= 1 &&
        rows.every((r) => /\[\d+, \d+\)/.test(String(r.innerText)) && /[0-9a-f]{8}/.test(String(r.innerText))) &&
        rows.some((r) => /ch-[0-9a-z]+/.test(String(r.innerText)));
      const dualPath = lineText.includes('向量路') && lineText.includes('关键词路');
      const fused = lineText.includes('融合');
      const reranked = lineText.includes('重排') && document.querySelector('.rag-hits table, .rag-hits');
      const storeNote = String((document.querySelector('.rag-note') || {}).textContent || '');
      await sleep(200);
      return {
        ok: rows.length >= 1 && provenance && dualPath && fused && Boolean(reranked) && storeNote.length > 0,
        note: '回执：' + lineText.slice(0, 170) +
          '；命中行=' + rows.length + '（出处列=' + provenance + '）' +
          '；向量实现注记=' + storeNote.replace(/\s+/g, ' ').slice(0, 80) +
          '；首行=' + (rowText.split(' | ')[0] || '').slice(0, 110),
      };
    `,
  },
  {
    step: 33,
    title: "记忆：上下文预览器与可复现快照（槽位/来源/Token/命中键/截断 + 指纹，T3-9）",
    file: "step33-context-snapshot.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('组装预演与上下文预览器'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到组装预演与上下文预览器面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      // step31 把小预算改为 40——恢复默认总预算后再组装（预览器条目完整）
      const budgetInput = panel.querySelector('.memory-assemble-budget');
      if (!budgetInput) return { ok: false, note: '找不到预算输入：' + pageText() };
      setV(budgetInput, '32000');
      const asmBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '组装预演');
      if (!asmBtn || asmBtn.disabled) return { ok: false, note: '组装预演按钮不可用：' + pageText() };
      // 这里等的必须是「这一步的新结果」：step31 末尾用 40 token 预算跑过一次，
      // 选择器 assembly-preview 此刻是**已在的旧节点**，只等"节点存在"会立刻返回、读到旧装配表，
      // 而请求还在 in-flight（按钮禁用）。判据改成「文本含本步特有的 预算 32000」+「导出按钮转绿」两者齐备。
      // 点击前 DOM 里那份回执是什么？（若是 step31 留下的"预算 40"，就证明旧节点确实存在、
      // 只等"节点在"的写法会读到它）
      const staleBefore = (() => {
        const l = document.querySelector('.assembly-preview');
        return l ? String(l.textContent).replace(/\s+/g, ' ').slice(0, 34) : '（无旧节点）';
      })();
      asmBtn.click();
      const inFlight = !!document.querySelector('.context-export') && document.querySelector('.context-export').disabled === true;      const previewLine = await waitFor(() => {
        const line = document.querySelector('.assembly-preview');
        const btn = document.querySelector('.context-export');
        if (!line || !btn || btn.disabled) return null;
        return String(line.textContent).replace(/\s+/g, ' ').includes('预算 32000') ? line : null;
      }, 12000);
      if (!previewLine) return { ok: false, note: '组装预演新结果未到位（旧节点判据=预算 32000 + 按钮转绿）：' + pageText() };
      const rows = [...document.querySelectorAll('.context-item-row')];
      const rowText = rows.map((r) => String(r.innerText).replace(/\s+/g, ' ')).join(' | ');
      // 表头五列（槽位 / 来源 / Token 数 / 命中键 / 是否被截断）
      const headerText = String((panel.querySelector('.context-items thead') || {}).textContent || '').replace(/\s+/g, ' ');
      const headerOk = ['槽位', '来源', 'Token 数', '命中键', '是否被截断'].every((name) => headerText.includes(name));
      // 命中键列有值（事实 trigger 命中「天启界」）
      const matchedKeys = rows.some((r) => String(r.innerText).includes('天启界'));
      // 导出快照：回执含路径与指纹
      const exportBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '导出快照');
      if (!exportBtn || exportBtn.disabled) return { ok: false, note: '导出快照按钮不可用：' + pageText() };
      exportBtn.click();
      const snapLine = await waitFor(() => document.querySelector('.context-snapshot'), 12000);
      if (!snapLine) return { ok: false, note: '快照导出未返回：' + pageText() };
      const snapText = String(snapLine.textContent).replace(/\s+/g, ' ');
      const snapOk = snapText.includes('.yushu/context-log/') && /fingerprint [0-9a-f]{12}/.test(snapText);
      await sleep(200);
      return {
        ok: rows.length >= 3 && headerOk && matchedKeys && snapOk,
        note: '预览器条目=' + rows.length + '（表头五列=' + headerOk + '；命中键含「天启界」=' + matchedKeys +
          '；点击前 DOM 已有回执="' + staleBefore + '"；点完即观察到请求 in-flight=' + inFlight + '）' +
          '；回执：' + snapText.slice(0, 150) +
          '；首行=' + (rowText.split(' | ')[0] || '').slice(0, 100),
      };
    `,
  },
  {
    step: 34,
    title: "记忆：设定抽取（JSON Schema 契约 / 候选三分类 / 确认入库，T3-10）",
    file: "step34-extract.png",
    body: String.raw`
      await tab('记忆');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('设定抽取'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到设定抽取面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '抽取候选');
      if (!btn || btn.disabled) return { ok: false, note: '抽取候选按钮不可用：' + pageText() };
      btn.click();
      const line = await waitFor(() => document.querySelector('.extract-preview'), 15000);
      if (!line) return { ok: false, note: '抽取未返回：' + pageText() };
      await sleep(150);
      const lineText = String(line.textContent).replace(/\s+/g, ' ');
      const rows = [...document.querySelectorAll('.extract-candidate')];
      const rowText = rows.map((r) => String(r.innerText).replace(/\s+/g, ' ')).join(' | ');
      const badges = rowText.includes('新增（可入库）') && (rowText.includes('补充（已存在同名卡）') || rowText.includes('冲突（需人工处置）'));
      const provenance = rows.length >= 3 && rows.every((r) => String(r.innerText).includes('出处：「') && String(r.innerText).includes('置信度'));
      // 采纳「玄铁令」（新增候选）——用户确认后入库（仅 new 可入库）
      const targetRow = rows.find((r) => String(r.innerText).includes('玄铁令'));
      const adoptBtn = targetRow && [...targetRow.querySelectorAll('button')].find((b) => b.textContent.trim() === '采纳入库');
      if (!adoptBtn) return { ok: false, note: '玄铁令候选「采纳入库」按钮不可用：' + rowText.slice(0, 200) };
      adoptBtn.click();
      const adopted = await waitFor(() => {
        const row = [...document.querySelectorAll('.extract-candidate')].find((r) => String(r.innerText).includes('玄铁令'));
        return row && String(row.innerText).includes('已入库：world/cards/') ? String(row.innerText).replace(/\s+/g, ' ') : null;
      }, 12000);
      await sleep(200);
      return {
        ok: rows.length >= 3 && badges && provenance && adopted !== null && /新增 \d+/.test(lineText),
        note: '回执：' + lineText.slice(0, 150) +
          '；候选行=' + rows.length + '（三分类徽标=' + badges + '；出处与置信度=' + provenance + '）' +
          '；采纳回执="' + (adopted ? adopted.slice(0, 110) : '无') + '"',
      };
    `,
  },
  {
    step: 35,
    title: "AI 副驾：多候选对比与局部采纳 / 拒绝原因（T3-11，J15）",
    file: "step35-multi-candidate.png",
    body: String.raw`
      await tab('AI 副驾');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('候选正文'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到候选正文面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(150);
      // AI 副驾随标签页卸载重建：先确保开关已开（生成按钮的启用条件；step5 的开关状态随卸载重置）
      const enableBox = document.querySelector('.ai input[type="checkbox"]');
      if (enableBox && !enableBox.checked) enableBox.click();
      await sleep(150);
      const modeSelect = panel.querySelector('.ai-typewriter-mode');
      if (!modeSelect) return { ok: false, note: '找不到打字机模式选择：' + pageText() };
      const multiBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.includes('个候选'));
      if (!multiBtn || multiBtn.disabled) return { ok: false, note: '多候选按钮不可用：' + pageText() };
      multiBtn.click();
      const cards = await waitFor(() => {
        const list = [...document.querySelectorAll('.ai-candidate-card')];
        return list.length >= 2 ? list : null;
      }, 30000);
      if (!cards) return { ok: false, note: '多候选未生成：' + pageText() };
      const cardText = cards.map((c) => String(c.innerText).replace(/\s+/g, ' ')).join(' | ');
      const diffOk = cardText.includes('句级差异');
      const varied = cardText.includes('候选1') && cardText.includes('候选2');
      const typewriter = String(modeSelect.value) === 'smooth';
      // 局部采纳：展开候选 1 句表 → 取消第二句 → 采纳所选句（追加）
      const first = [...document.querySelectorAll('.ai-candidate-card')][0];
      const toggle = [...first.querySelectorAll('button')].find((b) => b.textContent.includes('按句采纳'));
      if (!toggle) return { ok: false, note: '找不到按句采纳按钮：' + cardText.slice(0, 160) };
      toggle.click();
      await sleep(150);
      const boxes = [...first.querySelectorAll('.sentences input[type="checkbox"]')];
      if (boxes.length < 2) return { ok: false, note: '句表不足两句：' + pageText() };
      boxes[1].click();
      const adoptBtn = document.querySelector('.ai-sentence-adopt');
      if (!adoptBtn) return { ok: false, note: '找不到采纳所选句按钮：' + pageText() };
      adoptBtn.click();
      // 回执文案为「局部采纳：已追加 X/Y 句 → …」（带全角冒号——避免误匹配面板标题中的「局部采纳 / 拒绝原因」）
      const adoptNotice = await waitFor(() => {
        const el = [...document.querySelectorAll('.ai .muted')].find((x) => x.textContent.includes('局部采纳：'));
        return el ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 15000);
      // 拒绝原因：候选 2 → 拒绝…（默认「太水」）→ 记录拒绝 → 统计出现
      const second = [...document.querySelectorAll('.ai-candidate-card')][1];
      const rejectBtn = [...second.querySelectorAll('button')].find((b) => b.textContent.trim() === '拒绝…');
      if (!rejectBtn) return { ok: false, note: '找不到拒绝按钮：' + pageText() };
      rejectBtn.click();
      await sleep(150);
      const confirmBtn = [...second.querySelectorAll('button')].find((b) => b.textContent.trim() === '记录拒绝');
      if (!confirmBtn) return { ok: false, note: '找不到记录拒绝按钮：' + pageText() };
      confirmBtn.click();
      const stats = await waitFor(() => {
        const el = document.querySelector('.ai-feedback');
        return el && String(el.textContent).includes('太水') ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 12000);
      await sleep(200);
      return {
        ok: diffOk && varied && typewriter && adoptNotice !== null && stats !== null,
        note: '多候选=' + cards.length + '（差异化=' + varied + '；句级差异行=' + diffOk + '；打字机匀速=' + typewriter + '）' +
          '；局部采纳="' + (adoptNotice ?? '无').slice(0, 90) + '"' +
          '；拒绝统计="' + (stats ?? '无').slice(0, 90) + '"',
      };
    `,
  },
  {
    step: 36,
    title: "AI 副驾：Token 与成本面板 / 稳定前缀编排核对（T3-12，J09）",
    file: "step36-cost-panel.png",
    body: String.raw`
      await tab('AI 副驾');
      const panel = await waitFor(() => {
        const title = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('Token 与成本'));
        return title ? title.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到 Token 与成本面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(150);
      const refresh = panel.querySelector('.ai-cost-refresh');
      if (!refresh) return { ok: false, note: '找不到「刷新成本面板」按钮：' + pageText() };
      refresh.click();
      // 回执行口径固定为「成本面板：合计 …｜输入 N tok｜偏差 …」（金额与偏差文本均由主进程下发）
      const receipt = await waitFor(() => {
        const el = document.querySelector('.ai-cost-receipt');
        return el && String(el.textContent).includes('成本面板：合计') ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 15000);
      if (!receipt) return { ok: false, note: '成本回执未出现：' + pageText() };
      const promptTokens = Number((receipt.match(/输入 (\d+) tok/) || [])[1] ?? '-1');
      const totals = panel.querySelector('.ai-cost-totals');
      const totalsText = totals ? String(totals.textContent).replace(/\s+/g, ' ') : '';
      // 预演的 provider 配置未写 pricing → 必须如实标注「未配置价格」，不得凭空折算金额
      const unpriced = totalsText.includes('未配置价格') || receipt.includes('未配置价格');
      // 编排核对区：断点须落在 world_constraints（稳定前缀置头），未声明 cache 时不给节省额
      const audit = panel.querySelector('.ai-cost-cache');
      const auditText = audit ? String(audit.textContent).replace(/\s+/g, ' ') : '';
      const breakpointOk = auditText.includes('world_constraints') && auditText.includes('下标 2');
      const orderedOk = auditText.includes('稳定在前、易变在后');
      const cacheNote = auditText.includes('未声明') && auditText.includes('不估算');
      // 口径说明（notes）必须原样外显——本项目「边界如实标注」的一贯要求
      const notesOk = String(panel.innerText).includes('CJK');
      const rows = [...panel.querySelectorAll('.slot-table tbody tr')].length;
      // R49 预算护栏与成本体检区：预演目录没有 config/budget.yaml → 必须显示「未配置」而不是猜一个预算；
      // 未定价记录不得显示成「本月花了 0」；没跑成的规则要逐条点名（不把"没跑"显示成"没问题"）
      const budget = panel.querySelector('.ai-cost-budget');
      const budgetText = budget ? String(budget.textContent).replace(/\s+/g, ' ') : '';
      const budgetCap = budgetText.includes('月度上限 未配置（不设月度上限）');
      const budgetMonth = /本月（\d{4}-\d{2}/.test(budgetText);
      const budgetHonestZero = budgetText.includes('无可折算记录') || /条未定价不计金额/.test(budgetText);
      const budgetSkipped = budgetText.includes('未跑：') && budgetText.includes('budget-monthly-cap');
      await sleep(200);
      return {
        ok: promptTokens > 0 && unpriced && breakpointOk && orderedOk && cacheNote && notesOk && rows >= 5 &&
          budgetCap && budgetMonth && budgetHonestZero && budgetSkipped,
        note: '回执="' + receipt.slice(0, 96) + '"；输入 tok=' + promptTokens +
          '；未配置价格=' + unpriced + '；断点=' + breakpointOk + '；置头=' + orderedOk +
          '；缓存注记=' + cacheNote + '；口径说明=' + notesOk + '；表行=' + rows +
          '；编排="' + auditText.slice(0, 120) + '"' +
          '；预算区=' + (budgetCap && budgetMonth && budgetHonestZero && budgetSkipped) +
          '；预算="' + budgetText.slice(0, 150) + '"',
      };
    `,
  },
  {
    step: 37,
    title: "AI 副驾：API Key 加密保存 / 三态显示 / 后端不可用即禁用（T3-14，K12）",
    file: "step37-key-security.png",
    body: String.raw`
      await tab('AI 副驾');
      const card = await waitFor(() => {
        const list = [...document.querySelectorAll('.provider')].filter((x) => x.innerText.includes('mock'));
        return list.length > 0 ? list[0] : null;
      }, 12000);
      if (!card) return { ok: false, note: '找不到 provider 卡片：' + pageText() };
      card.scrollIntoView({ block: 'center' });
      // 每次重新取卡片：React 重渲染会替换子节点，缓存的引用会读到旧 DOM
      const keyBadge = () => {
        const c = [...document.querySelectorAll('.provider')].filter((x) => x.innerText.includes('mock'))[0];
        if (!c) return '';
        return [...c.querySelectorAll('.muted, span, div')]
          .map((el) => String(el.textContent).replace(/\s+/g, ' ').trim())
          .find((text) => text.startsWith('密钥：')) || '';
      };
      const stateLine = keyBadge();
      const input = card.querySelector('.ai-key-input');
      if (!input) return { ok: false, note: '找不到密钥输入框（三态行="' + stateLine + '"）：' + pageText() };
      const type = String(input.getAttribute('type') || '');
      const autocomplete = String(input.getAttribute('autocomplete') || '');
      const backendDisabled = input.disabled === true;
      const noteEl = card.querySelector('.ai-key-backend-note');
      const backendNote = noteEl ? String(noteEl.textContent).replace(/\s+/g, ' ') : '';
      const DEMO_KEY = 'sk-walkthrough-demo-0123456789abcdef';
      let receipt = '';
      let cleared = false;
      let echo = false;
      let stateAfterSave = '';
      let stateAfterClear = '';
      if (!backendDisabled) {
        // React 受控输入：必须走原生 setter + input 事件，直接改 .value 不会进组件状态
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, DEMO_KEY);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const saveBtn = card.querySelector('.ai-key-save');
        if (!saveBtn || saveBtn.disabled) return { ok: false, note: '「加密保存」不可用：' + pageText() };
        saveBtn.click();
        receipt = (await waitFor(() => {
          const hit = [...document.querySelectorAll('.ai .muted, .ai .notice, .ai p, .ai .warn')]
            .map((el) => String(el.textContent).replace(/\s+/g, ' '))
            .find((text) => text.includes('密钥已加密保存'));
          return hit || null;
        }, 15000)) || '';
        if (!receipt) return { ok: false, note: '加密保存后无回执：' + pageText() };
        // 三态徽标必须真的翻到「已加密保存」——只看 IPC 回执会漏掉"存成功但显示没跟上"
        stateAfterSave =
          (await waitFor(() => {
            const t = keyBadge();
            return t.includes('已加密保存') ? t : null;
          }, 15000)) || keyBadge();
        echo = String(document.body.innerText).includes(DEMO_KEY);
        const clearBtn = card.querySelector('.ai-key-clear');
        if (clearBtn) {
          clearBtn.click();
          cleared = (await waitFor(() => {
            const t = [...document.querySelectorAll('.ai .muted, .ai .notice, .ai p, .ai .warn')]
              .map((el) => String(el.textContent))
              .find((text) => text.includes('已清除凭据'));
            return t ? true : null;
          }, 15000)) === true;
          stateAfterClear =
            (await waitFor(() => {
              const t = keyBadge();
              return t !== '' && !t.includes('已加密保存') ? t : null;
            }, 15000)) || keyBadge();
        }
      }
      await sleep(150);
      // 后端可用 → 必须走完「加密保存 + 回执 + 徽标翻态 + 页面不回显 + 清除后徽标回落」；
      // 后端不可用 → 必须禁用输入并明说「不会写明文」（宁可不能用也不降级存明文）
      const branchOk = backendDisabled
        ? backendNote.includes('不会写明文')
        : receipt.includes('key_ref') &&
          echo === false &&
          cleared &&
          stateAfterSave.includes('已加密保存') &&
          stateAfterClear !== '' &&
          !stateAfterClear.includes('已加密保存');
      return {
        ok: stateLine !== '' && type === 'password' && branchOk,
        note: '三态="' + stateLine.slice(0, 40) + '"；输入框 type=' + type + '；autocomplete=' + (autocomplete || '（未设）') +
          '；后端可用=' + (!backendDisabled) + '；回执="' + receipt.slice(0, 90) + '"' +
          '；保存后三态="' + stateAfterSave.slice(0, 30) + '"；清除后三态="' + stateAfterClear.slice(0, 30) + '"' +
          '；页面回显密钥=' + echo + '；已清除=' + cleared + '；后端提示="' + backendNote.slice(0, 70) + '"',
      };
    `,
  },
  {
    step: 38,
    title: "编辑器：中文自查面板（别字/标点采纳、确认闸门、繁简候选须选定，T3-13）",
    file: "step38-proofread.png",
    body: String.raw`
      await tab('编辑器');
      const ie = await waitFor(() => window.__yushuEditorDebug, 8000);
      if (!ie) return { ok: false, note: '编辑器调试句柄 __yushuEditorDebug 未暴露' };
      const view = await waitFor(() => window.__yushuCmView, 8000);
      if (!view) return { ok: false, note: '调试句柄 window.__yushuCmView 未暴露' };
      const drafts = await window.yushu.ai.drafts();
      const path = drafts[0] && drafts[0].chapterPath;
      if (!path) return { ok: false, note: '无草稿章节：' + pageText() };
      // 植入待修正文（经产品自身的写入通道，等价于作者键入后保存），再让编辑器对齐磁盘
      const DIRTY = '他走头无路,只能甘败下风。头发被风吹乱。';
      const before = await window.yushu.chapter.read(path);
      await window.yushu.chapter.write({ path, body: DIRTY, baseHash: before.hash });
      await ie.reload();
      const panel = await waitFor(() => document.querySelector('.proofread-panel'), 12000);
      if (!panel) return { ok: false, note: '未找到中文自查面板：' + pageText() };
      panel.querySelector('.proofread-refresh').click();
      const listed = await waitFor(
        () => (panel.querySelectorAll('.proofread-row').length > 0 ? panel.querySelectorAll('.proofread-row') : null),
        15000,
      );
      if (!listed) return { ok: false, note: '自查无结果行（回执=' + String((panel.querySelector('.proofread-receipt') || {}).textContent || '') + '）：' + pageText() };
      const rowsBefore = listed.length;
      // ① 确认闸门在 UI 上也必须成立：未勾选「我已确认」时所有采纳按钮禁用
      const allBtn = panel.querySelector('.proofread-adopt-all');
      const disabledBeforeConfirm =
        !!allBtn && allBtn.disabled && [...panel.querySelectorAll('.proofread-adopt')].every((b) => b.disabled);
      const confirm = panel.querySelector('.proofread-confirm');
      if (!confirm) return { ok: false, note: '确认复选框缺失' };
      confirm.click();
      await sleep(250);
      const enabledAfterConfirm = await waitFor(() => {
        const b = panel.querySelector('.proofread-adopt-all');
        return b && !b.disabled ? true : null;
      }, 8000);
      // ② 采纳全部「可自动修」（别字 + 半角标点）
      panel.querySelector('.proofread-adopt-all').click();
      const adopted = await waitFor(() => {
        const el = panel.querySelector('.proofread-action');
        return el && el.textContent.includes('已采纳') ? el.textContent.replace(/\s+/g, ' ') : null;
      }, 15000);
      const docText = String(view.state.doc.toString());
      const docFixed = docText.includes('走投无路') && docText.includes('甘拜下风') && !docText.includes('走头无路');
      // ③ 落盘仍走既有保存路径：等自动保存把改动写下去（面板自身从不写文件）
      const persisted = await waitFor(async () => {
        const disk = await window.yushu.chapter.read(path);
        return disk.body.includes('走投无路') && disk.body.includes('甘拜下风') ? true : null;
      }, 15000);
      // ④ 繁简歧义必须从候选里选：未选定时该条「采纳」禁用，选定后才能提交
      const ambRow = [...panel.querySelectorAll('.proofread-row')].find((r) => r.querySelector('.proofread-candidate'));
      let candidateOk = false;
      let disabledBeforeChoice = false;
      let ambReceipt = '';
      if (ambRow) {
        const firstBtn = ambRow.querySelector('.proofread-adopt');
        disabledBeforeChoice = !!(firstBtn && firstBtn.disabled);
        const select = ambRow.querySelector('.proofread-candidate');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, '髮');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);
        const enabledAfterChoice = !(ambRow.querySelector('.proofread-adopt') || { disabled: true }).disabled;
        if (disabledBeforeChoice && enabledAfterChoice) {
          // 等「操作回执发生变化」而非只等它含「已采纳」——上一轮的旧回执同样含该词，会误读成刚提交的那次
          const prevAction = String((panel.querySelector('.proofread-action') || {}).textContent || '');
          ambRow.querySelector('.proofread-adopt').click();
          ambReceipt = (await waitFor(() => {
            const el = panel.querySelector('.proofread-action');
            const text = el ? el.textContent.replace(/\s+/g, ' ') : '';
            return text.includes('已采纳') && text !== prevAction ? text : null;
          }, 15000)) || '';
          candidateOk = (await waitFor(() => (String(view.state.doc.toString()).includes('髮') ? true : null), 10000)) === true;
        }
      }
      const rowsAfter = panel.querySelectorAll('.proofread-row').length;
      return {
        ok:
          rowsBefore >= 3 &&
          disabledBeforeConfirm &&
          enabledAfterConfirm === true &&
          !!adopted &&
          docFixed &&
          persisted === true &&
          !!ambRow &&
          disabledBeforeChoice &&
          candidateOk &&
          ambReceipt.indexOf('已采纳 1 处') >= 0,
        note: '结果行=' + rowsBefore + '（采纳后重扫剩 ' + rowsAfter + '）；未确认即禁用=' + disabledBeforeConfirm +
          '；勾选后可采纳=' + (enabledAfterConfirm === true) + '；采纳回执="' + String(adopted || '').slice(0, 56) + '"' +
          '；编辑器已改对=' + docFixed + '；已落盘（走既有保存路径）=' + (persisted === true) +
          '；候选未选定即禁用=' + disabledBeforeChoice + '；选定后已改=' + candidateOk + '；候选回执="' + ambReceipt.slice(0, 36) + '"',
      };
    `,
  },
  {
    step: 39,
    title: "AI 副驾：关闭 AI 后本地能力无退化 + 三个联网入口一律被拒（T3 / A4）",
    file: "step39-ai-off.png",
    body: String.raw`
      await tab('AI 副驾');
      const toggle = await waitFor(() => document.querySelector('.ai-enable-toggle'), 15000);
      if (!toggle) return { ok: false, note: '找不到 AI 开关复选框：' + pageText() };
      const wasOn = toggle.checked === true;
      if (wasOn) { toggle.click(); await sleep(400); }
      // ① UI 事实：关闭后生成按钮必须禁用
      const genBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始生成');
        return b && b.disabled ? b : null;
      }, 12000);
      // ② 进程事实：绕过 UI 直接 invoke 也必须被拒（否则闸门只是给眼睛看的）
      const drafts = await window.yushu.ai.drafts();
      const target = drafts[0];
      let blocked = '(no-target)';
      if (target) {
        try {
          await window.yushu.ai.start({ streamId: 'wt-a4-off', volumeId: target.volumeId, chapterId: target.chapterId, task: 'draft-first', targetWords: 120 });
          blocked = 'NOT-BLOCKED';
        } catch (err) {
          blocked = String((err && (err.code || err.message)) || err).slice(0, 40);
        }
        try {
          await window.yushu.extract.preview({ chapterId: target.chapterId });
          blocked += ' / extract-NOT-BLOCKED';
        } catch (err) {
          blocked += ' / ' + String((err && (err.code || err.message)) || err).slice(0, 24);
        }
      }
      const state = await window.yushu.ai.config();
      // ③ 本地能力不受影响：纯本地命名生成 + 中文自查（都零联网）
      const naming = await window.yushu.naming.generate({ kind: 'place', count: 3, seed: 'a4' });
      let proofreadRows = -1;
      if (target) {
        const panel = await window.yushu.text.proofread({ path: target.chapterPath });
        proofreadRows = panel.findings.length;
      }
      // 恢复开启态，别把关闭状态漏给后续步骤
      if (wasOn) { toggle.click(); await sleep(400); }
      const restored = await window.yushu.ai.config();
      return {
        ok:
          genBtn !== null &&
          state.aiEnabled === false &&
          blocked.indexOf('E_AI_DISABLED') >= 0 &&
          blocked.indexOf('NOT-BLOCKED') < 0 &&
          naming.names.length === 3 &&
          proofreadRows >= 0 &&
          restored.aiEnabled === wasOn,
        note: '关闭后生成按钮禁用=' + (genBtn !== null) + '；主进程 aiEnabled=' + state.aiEnabled +
          '；绕过UI直调结果="' + blocked + '"；本地命名=' + naming.names.length + ' 个；离线自查可行=true（结果 ' + proofreadRows + ' 条）；恢复后 aiEnabled=' + restored.aiEnabled,
      };
    `,
  },
  {
    step: 40,
    title: "规则页：派系包规则目录与沙箱试算（M4/T4-1，R51）",
    file: "step40-rules.png",
    body: String.raw`
      await tab('规则');
      const view = await waitFor(() => document.querySelector('.rules-view'), 12000);
      if (!view) return { ok: false, note: '未进入规则页：' + pageText() };
      const panel = await waitFor(() => {
        const hit = [...document.querySelectorAll('.panel h3')].find((x) => x.textContent.includes('规则目录'));
        return hit ? hit.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到规则目录面板：' + pageText() };
      panel.scrollIntoView({ block: 'start' });
      const summary = () => {
        const el = document.querySelector('.rules-summary');
        return el ? String(el.textContent).replace(/\s+/g, ' ') : '';
      };
      const summaryText = await waitFor(() => (summary().includes('规则 6 条') ? summary() : null), 12000);
      const rows = [...document.querySelectorAll('.rules-table tbody tr')].length;
      const fileHeads = [...document.querySelectorAll('.rules-file-head')].map((x) => String(x.textContent).trim());
      const broken = [...document.querySelectorAll('.rules-file-error')].length;
      const badExpr = [...document.querySelectorAll('.rules-problems.error')].length;
      // 沙箱试算：默认选中的是第一条规则（power-no-regress），夹具预置为「境界升而战力降」
      const runBtn = document.querySelector('.rules-dryrun-run');
      if (!runBtn) return { ok: false, note: '找不到「试算」按钮：' + pageText() };
      runBtn.click();
      const hitLine = await waitFor(() => {
        const el = document.querySelector('.rules-dryrun-hit');
        return el && String(el.textContent).includes('疑似战力崩塌') ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 12000);
      const evidenceRows = [...document.querySelectorAll('.rules-evidence-table tbody tr')].length;
      // 坏夹具必须被拒并给出原因，**不得回显成「未命中」**
      const box = document.querySelector('.rules-fixture');
      if (!box) return { ok: false, note: '找不到夹具输入框：' + pageText() };
      const proto = Object.getPrototypeOf(box);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(box, '{不是合法 JSON');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      document.querySelector('.rules-dryrun-run').click();
      const rejectedLine = await waitFor(() => {
        const el = document.querySelector('.rules-dryrun-rejected');
        return el && String(el.textContent).includes('合法 JSON') ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 12000);
      // 恢复默认夹具，别把坏状态漏给后续步骤
      setter.call(box, JSON.stringify({ a: { chapter: 'A', realm: { tier: 3 }, combat_power: 100 }, b: { chapter: 'B', realm: { tier: 4 }, combat_power: 80 } }, null, 2));
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      const missLine = document.querySelector('.rules-dryrun-miss');
      return {
        ok: summaryText !== null && rows === 6 && fileHeads.length === 2 && broken === 0 && badExpr === 0 &&
          hitLine !== null && evidenceRows === 4 && rejectedLine !== null && missLine === null,
        note: '汇总="' + summaryText + '"；规则行=' + rows + '；件=' + fileHeads.join(',') +
          '；解析失败件=' + broken + '；表达式问题格=' + badExpr +
          '；命中回执="' + (hitLine || '').slice(0, 60) + '"；依据行=' + evidenceRows +
          '；拒绝回执="' + (rejectedLine || '').slice(0, 70) + '"',
      };
    `,
  },
  {
    step: 41,
    title: "规则页：一致性体检三态 + 规则豁免率视图（坏清单不静默放行 / 没判的不显示成没问题）（M4/T4-4、T4-11，R54·R84）",
    file: "step41-consistency.png",
    body: String.raw`
      await tab('规则');
      const view = await waitFor(() => document.querySelector('.rules-view'), 12000);
      if (!view) return { ok: false, note: '未进入规则页：' + pageText() };
      const manualBtn = document.querySelector('.consistency-manual');
      if (!manualBtn) return { ok: false, note: '找不到「全书体检」按钮：' + pageText() };
      // 造一条悬空引用：不这么做，"每条发现能跳回原文"这条验收就永远是空跑（结论 0 也算通过）
      // 带固定 id 是为了后面能按 subject 把它豁免掉（豁免率那一段要用）；try/catch 让有界重试不撞已存在的卡
      try {
        await window.yushu.card.write({
          card: { id: 'char-cons-step41', type: 'character', name: '体检目标', layer: 'characters', refs: [{ relation: '师从', target: 'fac-ghost-step41' }] },
          body: '为一致性体检造的卡。',
        });
      } catch (e) { /* 重试时已存在就用现成的 */ }
      manualBtn.click();
      const summaryLine = await waitFor(() => {
        const el = document.querySelector('.consistency-summary');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('时机 manual') && text.includes('已重算') ? text : null;
      }, 20000);
      if (!summaryLine) return { ok: false, note: '体检汇总未出现：' + pageText() };
      const rows = [...document.querySelectorAll('.consistency-table tbody tr')].length;
      const clean = !!document.querySelector('.consistency-clean');
      const findings = Number((summaryLine.match(/结论 (\d+)/) || [])[1] ?? -1);
      const suppressedCount = Number((summaryLine.match(/豁免 (\d+)/) || [])[1] ?? -1);
      const outOfScopeCount = Number((summaryLine.match(/未纳入范围 (\d+)/) || [])[1] ?? -1);
      const spanButtons = [...document.querySelectorAll('.consistency-jump')].length;
      // 汇总里的三个计数必须都能解析到（解析不到是 -1 → 判红）：少一个就说明文案与计数口径漂移
      const countsParsed = findings >= 0 && suppressedCount >= 0 && outOfScopeCount >= 0;
      const countedOk = rows === findings && findings >= 1 && spanButtons >= 1;
      // 一键跳到原文（M4 §7.5 A4）：点跳转按钮应切到世界观档案并聚焦该卡
      const jumpBtn = document.querySelector('.consistency-jump');
      if (jumpBtn) jumpBtn.click();
      const jumped = await waitFor(() => {
        const on = document.querySelector('.tab.on');
        return on && String(on.textContent).includes('世界观档案') && document.querySelector('.archive') ? true : null;
      }, 12000);
      await tab('规则');
      const backAgain = !!document.querySelector('.consistency-summary');
      // 缓存语义：紧接着点「取最近结果」应显示"复用缓存"而不是又算一遍
      document.querySelector('.consistency-post-save').click();
      const cachedLine = await waitFor(() => {
        const el = document.querySelector('.consistency-summary');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('复用缓存') ? text : null;
      }, 15000);
      // 坏豁免清单：必须外显错误，且结论不得被清空（不静默放行）
      const before = findings;
      await window.yushu.doc.write('config/consistency.yaml',
        'apiVersion: yushu.consistency-allow/v1\nentries:\n  - rule: ref-dangling\n    subject: char-x\n');
      document.querySelector('.consistency-manual').click();
      const allowErrorLine = await waitFor(() => {
        const el = document.querySelector('.consistency-allow-error');
        return el && String(el.textContent).includes('reason') ? String(el.textContent).replace(/\s+/g, ' ') : null;
      }, 20000);
      const afterBroken = Number((String(document.querySelector('.consistency-summary')?.textContent || '')
        .match(/结论 (\d+)/) || [])[1] ?? -1);
      // 复原成"没有豁免"的合法清单，别把坏状态漏给后续步骤
      const cur = await window.yushu.doc.read('config/consistency.yaml');
      await window.yushu.doc.write('config/consistency.yaml',
        'apiVersion: yushu.consistency-allow/v1\nentries: []\n', cur.hash);
      document.querySelector('.consistency-manual').click();
      const restoredLine = await waitFor(() => {
        const el = document.querySelector('.consistency-summary');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('时机 manual') && text.includes('已重算') && !document.querySelector('.consistency-allow-error') ? text : null;
      }, 20000);
      // —— 规则豁免率（T4-11 / R84）：面板必须把「判了」与「没判」分开显示 ——
      const noiseHead = await waitFor(() => {
        const el = document.querySelector('.consistency-noise-head');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('规则豁免率') ? text : null;
      }, 5000);
      const neutralRow = [...document.querySelectorAll('.consistency-noise-table tbody tr')]
        .find((tr) => String(tr.querySelector('code')?.textContent).includes('ref-dangling'));
      // 没配阈值时这一格必须是"不判"字样，不许留空、也不许显示成"没问题"
      const neutralText = neutralRow ? String(neutralRow.textContent).replace(/\s+/g, ' ') : '(无该行)';
      const showsNotJudged = neutralText.includes('不判');
      // 配上阈值并把这条豁免掉 ⇒ 同一规则应翻成「偏吵」（报了却被作者全数打折）
      // 写盘一律"先读再写"：产品侧对已存在的文件拒绝无 baseHash 的盲写（E_DOC_CONFLICT），
      // 而有界重试的第二遍里这些文件已经存在了——这是脚本的前置状态没归零，不是产品问题
      const writeDocSafe = async (path, text) => {
        const cur = await window.yushu.doc.read(path).catch(() => null);
        return cur === null
          ? window.yushu.doc.write(path, text)
          : window.yushu.doc.write(path, text, cur.hash);
      };
      await writeDocSafe('config/consistency-thresholds.yaml',
        'apiVersion: yushu.consistency-thresholds/v1\nsuppression_rate: 0.1\nmin_samples: 1\n');
      await writeDocSafe('config/consistency.yaml',
        'apiVersion: yushu.consistency-allow/v1\nentries:\n  - rule: ref-dangling\n    subject: char-cons-step41\n    related: fac-ghost-step41\n    reason: 第二部再揭晓\n');
      document.querySelector('.consistency-manual').click();
      const noisyRow = await waitFor(() => {
        const hit = [...document.querySelectorAll('.consistency-noise-table tbody tr')]
          .find((tr) => String(tr.querySelector('code')?.textContent).includes('ref-dangling'));
        return hit && hit.className.includes('noisy') ? String(hit.textContent).replace(/\s+/g, ' ') : null;
      }, 20000);
      // 复原成中性状态（空豁免 + 只写 apiVersion 的阈值文件），别把判定状态漏给后续步骤
      await writeDocSafe('config/consistency.yaml',
        'apiVersion: yushu.consistency-allow/v1\nentries: []\n');
      await writeDocSafe('config/consistency-thresholds.yaml',
        'apiVersion: yushu.consistency-thresholds/v1\n');
      document.querySelector('.consistency-manual').click();
      const backToNeutral = await waitFor(() => {
        const el = document.querySelector('.consistency-noise-head');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('未配置') ? text : null;
      }, 20000);
      // 截图取证：把体检结论表滚进视口（规则页很长，不滚只拍到页首的规则目录）
      const consPanel = document.querySelector('.consistency-summary');
      if (consPanel) consPanel.scrollIntoView({ block: 'start' });
      await sleep(150);
      return {
        ok: summaryLine !== null && cachedLine !== null && allowErrorLine !== null && restoredLine !== null &&
          countedOk && afterBroken === before && countsParsed && jumped === true && backAgain &&
          noiseHead !== null && showsNotJudged && noisyRow !== null && backToNeutral !== null,
        note: '汇总="' + summaryLine.slice(0, 120) + '"；表行=' + rows + '；空态=' + clean +
          '；跳转生效=' + (jumped === true) + '；跳回规则页=' + backAgain +
          '；结论=' + findings + '；豁免=' + suppressedCount + '；未纳入范围=' + outOfScopeCount +
          '；跳转按钮=' + spanButtons + '；缓存复用=' + (cachedLine !== null) +
          '；坏清单报错="' + (allowErrorLine || '').slice(0, 70) + '"；坏清单后结论=' + afterBroken +
          '；复原=' + (restoredLine !== null) +
          '；豁免率表=' + (noiseHead !== null) + '；未配阈值显示="' + neutralText.slice(0, 60) +
          '"；配阈值+豁免后="' + (noisyRow || '').slice(0, 70) + '"；复原中性=' + (backToNeutral !== null),
      };
    `,
  },
  {
    step: 42,
    title: "AI 副驾：采纳后即时轻校验（post-generate 命中分支与范围外过滤）（M4/T4-4，R56）",
    file: "step42-post-adopt-audit.png",
    body: String.raw`
      await tab('AI 副驾');
      // 造一张会被本次生成文本提到的卡（mock 固定出文含「夜色」），并挂一条悬空引用。
      // 不这么做，轻校验在预演里只会走"范围为空"那一支，命中分支与范围外过滤都没人看过。
      await window.yushu.card.write({
        card: { type: 'character', name: '夜色', layer: 'characters', refs: [{ relation: '师从', target: 'fac-ghost-step42' }] },
        body: '为采纳后轻校验造的卡。',
      });
      const label = await waitFor(() => [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('启用 AI 调用')), 12000);
      if (!label) return { ok: false, note: '找不到「启用 AI 调用」复选框：' + pageText() };
      const cb = label.querySelector('input');
      if (cb && !cb.checked) { cb.click(); await sleep(250); }
      const genBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始生成');
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!genBtn) return { ok: false, note: '「开始生成」不可用：' + pageText() };
      genBtn.click();
      const cand = await waitFor(() => {
        const c = document.querySelector('.candidate');
        return c && c.textContent.trim() !== '' && document.body.innerText.includes('生成完成') ? c : null;
      }, 20000);
      if (!cand) return { ok: false, note: '候选未生成：' + pageText() };
      const adoptBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '追加到正文');
        return b && !b.disabled ? b : null;
      }, 12000);
      if (!adoptBtn) return { ok: false, note: '「追加到正文」不可用：' + pageText() };
      adoptBtn.click();
      // 回执必须自带轻校验面板（范围来自刚采纳的那段正文）
      const summary = await waitFor(() => {
        const el = document.querySelector('.ai-adopt-audit-summary');
        const text = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('本次正文提到') && text.includes('结论') ? text : null;
      }, 20000);
      if (!summary) return { ok: false, note: '采纳后轻校验汇总未出现：' + pageText() };
      const mentioned = Number((summary.match(/提到 (\d+) 个/) || [])[1] ?? -1);
      const entryCount = Number((summary.match(/结论 (\d+) 条/) || [])[1] ?? -1);
      const filteredOut = Number((summary.match(/范围外未展示 (\d+) 条/) || [])[1] ?? -1);
      const rows = [...document.querySelectorAll('.ai-adopt-audit .consistency-table tbody tr')].length;
      const errorLine = document.querySelector('.ai-adopt-audit-error');
      const noticeOk = document.body.innerText.includes('追加采纳');
      await sleep(200);
      // 截图要能作证：把本次断言的那一段滚进视口（规则页很长，不滚就只拍到页首）
      const auditPanel = document.querySelector('.ai-adopt-audit');
      if (auditPanel) auditPanel.scrollIntoView({ block: 'start' });
      await sleep(150);
      return {
        // 命中分支必须有真东西：提到 1 个实体、结论 ≥1 条、表行数与结论数一致，
        // 且 step41 留下的那张卡（范围外）确实没混进来而是被计数
        ok: !errorLine && noticeOk && mentioned === 1 && entryCount >= 1 && rows === entryCount && filteredOut >= 1,
        note: '汇总="' + summary.slice(0, 130) + '"；提到=' + mentioned + '；结论=' + entryCount +
          '；表行=' + rows + '；范围外=' + filteredOut + '；采纳回执在位=' + noticeOk +
          (errorLine ? '；未跑成="' + String(errorLine.textContent).slice(0, 60) + '"' : ''),
      };
    `,
  },
  {
    step: 43,
    title: "规则页：派系包规则拿项目数据求值（战力台账结论 + 未参与点名 + 坏台账报错）（M4/T4-2，R57）",
    file: "step43-pack-rule-data.png",
    body: String.raw`
      await tab('规则');
      const view = await waitFor(() => document.querySelector('.rules-view'), 12000);
      if (!view) return { ok: false, note: '未进入规则页：' + pageText() };
      // 一张台账正确（境界升、战力降）+ 一张章号写不出（必须报错点名，不能当没这张卡）。
      // 造卡是幂等的：本步骤可能被有界重试再跑一遍，那时卡已存在（E_DOC_CONFLICT 不算失败）
      const ensureCard = async (card, body) => {
        try { await window.yushu.card.write({ card, body }); } catch (e) { /* 已存在就用现成的 */ }
      };
      await ensureCard({
        id: 'char-power-wt', type: 'character', name: '战力样本', layer: 'characters',
        aliases: [], refs: [], source_chapters: [], visibility: 'hidden', format_version: 1,
        extensions: { power_log: [
          { chapter: '第 3 章', tier: 3, combat_power: 100 },
          { chapter: '第 4 章', tier: 4, combat_power: 80 },
        ] },
      }, '为派系包规则求值造的卡。');
      await ensureCard({
        id: 'char-badlog-wt', type: 'character', name: '坏台账样本', layer: 'characters',
        aliases: [], refs: [], source_chapters: [], visibility: 'hidden', format_version: 1,
        extensions: { power_log: [{ chapter: '序章', tier: 1, combat_power: 10 }] },
      }, '章号写不出来的卡。');
      const manualBtn = document.querySelector('.consistency-manual');
      if (!manualBtn) return { ok: false, note: '找不到「全书体检」按钮：' + pageText() };
      manualBtn.click();
      // 等的是「这一轮新报告里出现了包规则结论」，不是上一轮就在的汇总行——
      // 第一版在这里等 .consistency-pack 文案，命中了上一轮的旧报告，于是把新结论读成 0 条
      const packRow = await waitFor(() => {
        const found = [...document.querySelectorAll('.consistency-table tbody tr')]
          .find((tr) => String(tr.textContent).includes('power-no-regress'));
        return found || null;
      }, 20000);
      const errShown = await waitFor(() => {
        const el = document.querySelector('.consistency-pack-errors');
        const t = el ? String(el.textContent).replace(/\s+/g, ' ') : '';
        return t.includes('char-badlog-wt') ? t : null;
      }, 20000);
      const packLineEl = document.querySelector('.consistency-pack');
      const packLine = packLineEl ? String(packLineEl.textContent).replace(/\s+/g, ' ') : '';
      const skippedLine = document.querySelector('.consistency-pack-skipped');
      const skippedText = skippedLine ? String(skippedLine.textContent).replace(/\s+/g, ' ') : '';
      const diskBack = await window.yushu.doc.read('world/cards/character/char-power-wt.md');
      const diskHasLog = String(diskBack.content).indexOf('power_log') >= 0;
      const rows = [...document.querySelectorAll('.consistency-table tbody tr')];
      const originText = packRow ? String([...packRow.querySelectorAll('td')][5]?.textContent || '').trim() : '(无该行)';
      const jumpInRow = packRow ? !!packRow.querySelector('.consistency-jump') : false;
      if (jumpInRow) packRow.querySelector('.consistency-jump').click();
      const jumped = await waitFor(() => {
        const on = document.querySelector('.tab.on');
        return on && String(on.textContent).includes('世界观档案') ? true : null;
      }, 12000);
      await tab('规则');
      const backOk = !!document.querySelector('.consistency-pack');
      // 截图取证：滚到包规则那一段，否则截图只有页首的规则目录
      const packPanel = document.querySelector('.consistency-pack');
      if (packPanel) packPanel.scrollIntoView({ block: 'start' });
      await sleep(150);
      return {
        ok: packRow !== null && diskHasLog && packLine.includes('power-no-regress') && packLine.includes('未参与 5 条') &&
          skippedText.includes('power-ceiling-exceeded') && skippedText.includes('scene.combat_power') &&
          errShown !== null && originText.includes('xuanhuan-xitong') &&
          jumpInRow && jumped === true && backOk,
        note: '盘上含 power_log=' + diskHasLog + '；表行=' + rows.length + '；汇总="' + packLine.slice(0, 110) +
          '"；未参与段="' + skippedText.slice(0, 60) + '"；错误行="' + (errShown || '').slice(0, 70) +
          '"；出处="' + originText.slice(0, 46) + '"；该行可跳转=' + jumpInRow +
          '；跳到档案=' + (jumped === true) + '；跳回=' + backOk,
      };
    `,
  },
  {
    step: 44,
    title: "规则页：全书体检 + AI 采样核验（结论并入同表、章节片段不给卡跳转）（M4/T4-4，R58）",
    file: "step44-ai-audit.png",
    body: String.raw`
      await tab('规则');
      const aiBtn = await waitFor(() => document.querySelector('.consistency-ai'), 12000);
      if (!aiBtn) return { ok: false, note: '找不到「全书体检 + AI 采样核验」按钮：' + pageText() };
      aiBtn.click();
      const aiLine = await waitFor(() => {
        const el = document.querySelector('.consistency-ai-line');
        const text = el ? String(el.textContent).replace(/\s+/g, " ") : "";
        return text.includes('AI 采样：已核验') ? text : null;
      }, 25000);
      if (!aiLine) {
        const el = document.querySelector('.consistency-ai-line');
        return { ok: false, note: 'AI 采样汇总行未达预期；当前行="' + (el ? String(el.textContent).replace(/\s+/g, ' ') : '(元素不存在)') + '"' };
      }
      const rows = [...document.querySelectorAll('.consistency-table tbody tr')];
      const aiRow = rows.find((tr) => String(tr.textContent).includes('ai-sampled-hallucination'));
      // 规则列取**单元格文本**而不是整行：级别紧挨规则 id（"errorref-dangling"），
      // 用 \b 在行文本上匹配会因为两侧都是词字符而根本匹配不上
      const ruleIds = rows.map((tr) => String([...tr.querySelectorAll('td')][1]?.textContent || '').trim());
      const structRows = ruleIds.filter((id) => id === 'ref-dangling' || id === 'layer-order-violation' || id === 'ref-cycle').length;
      const packRows = ruleIds.filter((id) => id === 'power-no-regress').length;
      const cells = aiRow ? [...aiRow.querySelectorAll("td")] : [];
      const aiOrigin = cells.length > 5 ? String(cells[5].textContent || '').trim() : '(无该行)';
      // 章节正文的片段不能走「打开设定卡」那一跳：它会奔世界观档案去找一张不存在的卡
      const aiJump = aiRow ? !!aiRow.querySelector('.consistency-jump') : true;
      const cellText = cells.length > 6 ? String(cells[6].textContent || '').trim() : '';
      const rejected = Number((aiLine.match(/丢弃 (\d+) 条/) || [])[1] ?? -1);
      const sampled = Number((aiLine.match(/已核验 (\d+) 段/) || [])[1] ?? -1);
      // 截图取证：滚到 AI 采样那一段（含汇总行与并表结论），否则截图只有页首
      const aiPanel = document.querySelector('.consistency-ai-line');
      if (aiPanel) aiPanel.scrollIntoView({ block: 'start' });
      await sleep(150);
      return {
        ok: aiRow !== undefined && sampled >= 1 && rejected === 0 && aiOrigin.includes("AI 采样") &&
          aiJump === false && cellText.includes("正文片段") && structRows >= 1 && packRows >= 1,
        note: "汇总=" + aiLine.slice(0, 120) + "；采样段=" + sampled + "；丢弃=" + rejected +
          "；AI 行存在=" + (aiRow !== undefined) + "；出处=" + aiOrigin.slice(0, 40) +
          "；该行给卡跳转=" + aiJump + "；原文列=" + cellText.slice(0, 24) +
          "；结构类行=" + structRows + "；包规则行=" + packRows + "；全部行=" + rows.length +
          "；规则列=" + ruleIds.join(","),
      };
    `,
  },
  {
    step: 45,
    title: "规则页：影响传播提案与逐项决策（真源只读，决策只写派生区）（M4/T4-5，R61）",
    file: "step45-propagation.png",
    body: String.raw`
      await tab('规则');
      const lawPath = 'world/cards/law/law-prop-wt.md';
      const geoPath = 'world/cards/location/geo-prop-wt.md';
      // 造一对有引用关系的卡；造卡不幂等（E_DOC_CONFLICT），有界重试时沿用已存在的即可
      const ensure = async (card, body) => {
        try { await window.yushu.card.write({ card, body }); } catch (e) { /* 已存在就用现成的 */ }
      };
      await ensure({
        id: 'law-prop-wt', type: 'law', name: '灵气传播样本', layer: 'laws',
        aliases: [], refs: [], source_chapters: [], visibility: 'hidden', format_version: 1,
      }, '为影响传播预演造的法则卡。');
      await ensure({
        id: 'geo-prop-wt', type: 'location', name: '云隐谷传播样本', layer: 'geography',
        aliases: [], refs: [{ relation: '依存', target: 'law-prop-wt' }],
        source_chapters: [], visibility: 'hidden', format_version: 1,
      }, '引用上面那条法则的地点卡。');
      const lawBefore = await window.yushu.doc.read(lawPath);
      const geoBefore = await window.yushu.doc.read(geoPath);
      const entityInput = await waitFor(() => document.querySelector('.propagate-entity'), 12000);
      if (!entityInput) return { ok: false, note: '找不到影响传播输入框：' + pageText() };
      setV(entityInput, 'law-prop-wt');
      await sleep(150);
      const previewBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('生成影响提案'));
      if (!previewBtn) return { ok: false, note: '找不到「生成影响提案」按钮' };
      previewBtn.click();
      const row = await waitFor(() => {
        const rows = [...document.querySelectorAll('.proposal-table tbody tr')];
        return rows.find((tr) => tr.textContent.includes('geo-prop-wt')) || null;
      }, 20000);
      const cells = row ? [...row.querySelectorAll('td')] : [];
      const pathShown = cells.length > 3 ? String(cells[3].textContent).indexOf('law-prop-wt → geo-prop-wt') >= 0 : false;
      const beforeDecision = row ? String(row.querySelector('.proposal-decision').textContent).trim() : '(无该行)';
      if (row) row.querySelector('.proposal-accept').click();
      const decided = await waitFor(() => {
        const again = [...document.querySelectorAll('.proposal-table tbody tr')].find((tr) => tr.textContent.includes('geo-prop-wt'));
        const text = again ? String(again.querySelector('.proposal-decision').textContent).trim() : '';
        return text === 'accept' ? text : null;
      }, 20000);
      const lawAfter = await window.yushu.doc.read(lawPath);
      const geoAfter = await window.yushu.doc.read(geoPath);
      const lineEl = document.querySelector('.propagate-line');
      const line = lineEl ? String(lineEl.textContent).replace(/\s+/g, ' ') : '(无汇总行)';
      const panel = document.querySelector('.propagate-panel');
      if (panel) panel.scrollIntoView({ block: 'start' });
      await sleep(200);
      return {
        ok: row !== null && pathShown && beforeDecision === '未决策' && decided === 'accept' &&
          lawBefore.hash === lawAfter.hash && geoBefore.hash === geoAfter.hash && line.includes('未决策 0 条'),
        note: '提案行=' + (row !== null) + '；路径列=' + pathShown + '；决策前=' + beforeDecision +
          '；决策后=' + String(decided) + '；法则卡 hash 未变=' + (lawBefore.hash === lawAfter.hash) +
          '；地点卡 hash 未变=' + (geoBefore.hash === geoAfter.hash) + '；汇总="' + line.slice(0, 70) + '"',
      };
    `,
  },
  {
    step: 46,
    title: "规则页：写回已接受的条目（改名改指 refs.target + 撤销快照在写之前）（M4/T4-5，R62）",
    file: "step46-apply-proposal.png",
    body: String.raw`
      await tab('规则');
      const geoPath = 'world/cards/location/geo-prop-wt.md';
      const input = await waitFor(() => document.querySelector('.propagate-entity'), 12000);
      if (!input) return { ok: false, note: '找不到影响传播输入框：' + pageText() };
      setV(input, 'law-prop-wt');
      const fieldInput = document.querySelector('.propagate-field');
      if (!fieldInput) return { ok: false, note: '找不到字段输入框' };
      setV(fieldInput, 'id');
      // 「新 id」输入框只在字段=id 时渲染，等它出现再填（否则 React 还没重绘）
      const toInput = await waitFor(() => document.querySelector('.propagate-to'), 12000);
      if (!toInput) return { ok: false, note: '改名用的「新 id」输入框没出现' };
      setV(toInput, 'law-prop-wt-v2');
      await sleep(200);
      const genBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('生成影响提案'));
      if (!genBtn) return { ok: false, note: '找不到「生成影响提案」按钮' };
      genBtn.click();
      const renameBlock = await waitFor(() => {
        const blocks = [...document.querySelectorAll('.proposal-block')];
        return blocks.find((b) => String(b.textContent).includes('新 id') && String(b.textContent).includes('law-prop-wt-v2')) || null;
      }, 20000);
      if (!renameBlock) return { ok: false, note: '改名提案没出现（面板里没有含新 id 的那一份）：' + pageText().slice(0, 200) };
      const acceptBtn = [...renameBlock.querySelectorAll('.proposal-accept')][0];
      if (!acceptBtn) return { ok: false, note: '改名提案里没有可接受的条目行' };
      acceptBtn.click();
      const decided = await waitFor(() => {
        const again = [...document.querySelectorAll('.proposal-block')].find((b) => b.textContent.includes('law-prop-wt-v2'));
        const cell = again ? again.querySelector('.proposal-decision') : null;
        return cell && String(cell.textContent).trim() === 'accept' ? 'accept' : null;
      }, 20000);
      const geoBefore = await window.yushu.doc.read(geoPath);
      const applyBtn = await waitFor(() => {
        const again = [...document.querySelectorAll('.proposal-block')].find((b) => b.textContent.includes('law-prop-wt-v2'));
        const btn = again ? again.querySelector('.proposal-apply') : null;
        return btn && !btn.disabled ? btn : null;
      }, 20000);
      if (!applyBtn) return { ok: false, note: '「写回已接受的条目」不可点（应等全部条目表态后放开）' };
      applyBtn.click();
      const appliedText = await waitFor(() => {
        const again = [...document.querySelectorAll('.proposal-block')].find((b) => b.textContent.includes('law-prop-wt-v2'));
        const row = again ? again.querySelector('.proposal-apply-row') : null;
        const text = row ? String(row.textContent).replace(/\s+/g, ' ') : '';
        return text.includes('已写回 1 条') ? text : null;
      }, 25000);
      const geoAfter = await window.yushu.doc.read(geoPath);
      const diskRetargeted = String(geoAfter.content).indexOf('law-prop-wt-v2') >= 0;
      const snaps = await window.yushu.snapshot.state();
      const snapshotTaken = snaps.snapshots.some((row) => row.reason === 'pre_apply_proposal');
      const panel = document.querySelector('.propagate-panel');
      if (panel) panel.scrollIntoView({ block: 'start' });
      await sleep(200);
      return {
        ok: decided === 'accept' && appliedText !== null && diskRetargeted && snapshotTaken && geoBefore.hash !== geoAfter.hash,
        note: '决策=' + String(decided) + '；写回回执=' + (appliedText !== null) + '；盘上已改指新 id=' + diskRetargeted +
          '；pre_apply_proposal 快照=' + snapshotTaken + '；卡 hash 已变（确认真被写）=' + (geoBefore.hash !== geoAfter.hash),
      };
    `,
  },
  {
    step: 47,
    title: "世界观档案：展开扩展字段（按真实内容高度连续过渡 + 箭头转 180°）（R63 交互精修）",
    file: "step47-disclosure.png",
    body: String.raw`
      await tab('世界观档案');
      // 「扩展字段」只在选中某张带 extensions 的卡时才渲染：逐张点列表项，直到那段出现
      const rows = [...document.querySelectorAll('.card-list li')];
      let opened = false;
      let tried = 0;
      for (const row of rows) {
        tried += 1;
        const target = row.querySelector('button, a, [role="button"]') || row;
        target.click();
        opened = await waitFor(() => (document.querySelector('.extensions .disclosure-toggle') ? true : null), 1500);
        if (opened) break;
      }
      if (!opened) return { ok: false, note: '点了 ' + tried + ' 张卡都没出现扩展字段那段（列表项 ' + rows.length + ' 个）' };
      const measure = () => {
        const panel = document.querySelector('.extensions .disclosure-panel');
        const body = document.querySelector('.extensions .disclosure-body');
        return {
          panel: panel ? Math.round(panel.getBoundingClientRect().height) : -1,
          content: body ? Math.round(body.scrollHeight) : -1,
          body: body ? Math.round(body.getBoundingClientRect().height) : -1,
        };
      };
      // 幂等（R104 修，v223 实撞）：失败重试时上一轮可能把这段留在了展开态，
      // 于是第二次 attempt 量到的是**收起**这条路径（收起高=236 起、终值高=0、aria true→false），
      // 判据读的根本不是同一样东西。先回源到收起态再量——与 step55 的「折叠态要幂等」同一手法。
      const toggleEl = document.querySelector('.extensions .disclosure-toggle');
      if (toggleEl.getAttribute('aria-expanded') === 'true') {
        toggleEl.click();
        await waitFor(() => (measure().panel === 0 ? true : null), 4000);
      }
      const before = measure();
      const caretBefore = String(getComputedStyle(document.querySelector('.extensions .disclosure-caret')).transform);
      const expandedBefore = document.querySelector('.extensions .disclosure-toggle').getAttribute('aria-expanded');
      // 连续采样：动效是 grid-template-rows 0fr→1fr 的真实过渡（R111：展开走 --motion-reveal 380ms、收起走 --motion-exit 140ms）。
      // 要证的是「存在中间态」，那就**逐帧采到中间值**（rAF），
      // 而不是「第 60ms 恰好落在中间」——那只是运气：慢机器上 60ms 才 3px，快机器上直接到终值。
      const samples = [];
      let sampling = true;
      const sampler = () => {
        if (!sampling) return;
        samples.push(measure().panel);
        requestAnimationFrame(sampler);
      };
      requestAnimationFrame(sampler);
      document.querySelector('.extensions .disclosure-toggle').click();
      // 等动效**落定**再量：0fr→1fr 过渡期间正文本来就是被裁的（那正是动效本身），
      // 在半路取样会把「正在过渡」误判成「内容被裁掉」（v223 实撞：终值高=235、内容高=236 就被判了被裁）。
      const settled = await waitFor(() => {
        const now = measure();
        return now.panel > 0 && Math.abs(now.panel - now.content) <= 2 && Math.abs(now.body - now.content) <= 2 ? now : null;
      }, 6000);
      sampling = false;
      const after = settled || measure();
      // 「中间态」要真的在中间：离终值不到 4px 的那几帧不算（否则只采到终值前一帧也叫"中间态"）
      const intermediates = samples.filter((h) => h > 0 && h <= after.panel - 4);
      const caretAfter = String(getComputedStyle(document.querySelector('.extensions .disclosure-caret')).transform);
      const expandedAfter = document.querySelector('.extensions .disclosure-toggle').getAttribute('aria-expanded');
      const clipped = Math.abs(measure().body - after.content) > 2;
      const panel = document.querySelector('.extensions');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(150);
      return {
        ok: before.panel === 0 && after.panel > 0 && intermediates.length > 0 && !clipped &&
          expandedBefore === 'false' && expandedAfter === 'true' && caretBefore !== caretAfter,
        note: '收起高=' + before.panel + '；终值高=' + after.panel +
          '；内容高=' + after.content + '；正文高=' + after.body +
          '；逐帧采样 ' + samples.length + ' 帧·中间态 ' + intermediates.length + ' 个' +
          (intermediates.length > 0 ? '（最高 ' + String(Math.max.apply(null, intermediates)) + 'px）' : '') +
          '；被裁=' + clipped +
          '；aria ' + expandedBefore + '→' + expandedAfter + '；箭头 ' + caretBefore.slice(0, 26) + ' → ' + caretAfter.slice(0, 26),
      };
    `,
  },
  {
    step: 48,
    title: "全局：标签图标与中文排版（避头尾/中西空格/版心/等宽数位）（R64 排版精修）",
    file: "step48-typography.png",
    body: String.raw`
      // ① 标签栏：11 个标签都要有图标、图标必须 aria-hidden（可访问名来自旁边的文字）、文字不能被挤掉
      const tabs = [...document.querySelectorAll('.tabs .tab')];
      const icons = tabs.map((t) => t.querySelector('svg.yushu-icon'));
      const iconCount = icons.filter((s) => s !== null).length;
      const hiddenOk = icons.every((s) => s !== null && s.getAttribute('aria-hidden') === 'true');
      const labelled = tabs.filter((t) => ((t.textContent || '').trim().length > 0)).length;
      // 图标不能把标签压扁：每个至少 44px（够放 15px 图标 + 两个汉字 + 内边距）
      const widths = tabs.map((t) => Math.round(t.getBoundingClientRect().width));
      const squeezed = widths.filter((w) => w < 44).length;
      const bar = document.querySelector('.tabs');
      const overflowPx = Math.round(bar.scrollWidth - bar.clientWidth);
      // ② 排版三性：不支持的浏览器 getPropertyValue 返回空串，所以"有值"本身就是支持证据
      const cs = getComputedStyle(document.body);
      const lineBreak = cs.getPropertyValue('line-break');
      const autospace = cs.getPropertyValue('text-autospace');
      const spacingTrim = cs.getPropertyValue('text-spacing-trim');
      const supports = {
        lineBreak: window.CSS.supports('line-break', 'strict'),
        autospace: window.CSS.supports('text-autospace', 'normal'),
        spacingTrim: window.CSS.supports('text-spacing-trim', 'normal'),
      };
      // ③ 版心：正文编辑容器要真被限宽（不是写了不生效，也不是限到看不见）
      await tab('编辑器');
      const host = await waitFor(() => document.querySelector('.cm-host') || null, 3000);
      if (!host) return { ok: false, note: '编辑器页找不到源码形态容器（.cm-host）' };
      const hostStyle = getComputedStyle(host);
      const maxPx = Math.round(parseFloat(hostStyle.maxWidth || '0'));
      const hostW = Math.round(host.getBoundingClientRect().width);
      // ④ 等宽数位：规则页的结论表数字列不该随位数变宽而挪动
      await tab('规则');
      const table = await waitFor(() => document.querySelector('.slot-table') || null, 3000);
      const numeric = table ? getComputedStyle(table).getPropertyValue('font-variant-numeric') : '';
      const tnum = table ? getComputedStyle(table).getPropertyValue('font-feature-settings') : '';
      if (table) table.scrollIntoView({ block: 'center' });
      await sleep(150);
      const tabsOk = tabs.length === 11 && iconCount === 11 && hiddenOk && labelled === 11 && squeezed === 0;
      const typographyOk = lineBreak === 'strict' && autospace !== '' && spacingTrim !== '';
      const measureOk = maxPx >= 480 && maxPx <= 720 && hostW > 0 && hostW <= maxPx + 1;
      const digitsOk = numeric.indexOf('tabular-nums') >= 0 && tnum.indexOf('tnum') >= 0;
      return {
        ok: tabsOk && typographyOk && measureOk && digitsOk && supports.autospace && supports.spacingTrim,
        note: '标签=' + tabs.length + ' 图标=' + iconCount + ' aria隐= ' + hiddenOk + ' 有文字=' + labelled +
          ' 被压扁=' + squeezed + '（最窄 ' + Math.min(...widths) + 'px）；标签栏溢出=' + overflowPx + 'px；' +
          'line-break=' + lineBreak + '；autospace=' + autospace + '；spacing-trim=' + spacingTrim +
          '；CSS.supports ' + JSON.stringify(supports) + '；版心=' + maxPx + 'px（实测宽 ' + hostW + 'px）；' +
          '数字列=' + numeric + ' / ' + tnum,
      };
    `,
  },
  {
    step: 49,
    title: "世界观档案：伏笔台账看板（只读、判定在引擎、合法终态不报缺陷）（M4/T4-6，R66）",
    file: "step49-foreshadow.png",
    body: String.raw`
      // 台账内容按**本项目真实的章序**构造（不猜 id）：早章埋、早章该收、进度写到最后 ⇒ 必然逾期
      const outline = await window.yushu.outline.read();
      const volumes = (outline.doc || {}).volumes || [];
      const ids = [];
      for (const volume of volumes) {
        for (const chapter of volume.chapters || []) ids.push(chapter.chapter_id || chapter.id);
      }
      if (ids.length < 3) return { ok: false, note: '章清单只有 ' + ids.length + ' 条，构造不出逾期样本' };
      const early = ids[1];
      const last = ids[ids.length - 1];
      const entry = (id, extra) => {
        const lines = [
          '  - id: ' + id,
          '    name: ' + JSON.stringify(extra.name),
          '    promise: ' + JSON.stringify(extra.promise),
          '    carrier: 道具',
          '    visibility: 半遮',
          '    state: ' + extra.state,
          '    plant_chapters: ' + JSON.stringify([early]),
          '    expected_payoff_chapter: ' + early,
          '    payoff_chapters: ' + JSON.stringify(extra.payoff),
          '    payoff_type: 揭示',
          '    is_red_herring: ' + String(extra.rh),
          '    recheck_after: 3',
        ];
        if (extra.reason) lines.push('    abandon_reason: ' + JSON.stringify(extra.reason));
        return lines.join('\n');
      };
      const text = ['apiVersion: yushu.foreshadow/v1', 'entries:',
        entry('fs-overdue', { name: '祖宅的青铜钥匙', promise: '钥匙能打开地下室', state: 'due', payoff: [], rh: false }),
        entry('fs-redherring', { name: '哑仆的半句话', promise: '指向管家是凶手', state: 'abandoned', payoff: [], rh: true, reason: '第 14 章点破是伪造的线索，不再回收' }),
        entry('fs-contradict', { name: '断剑的重铸', promise: '重铸之日即回归之时', state: 'paid', payoff: [], rh: false }),
      ].join('\n') + '\n';
      // 台账是真源：走产品写通道新建（不带 baseHash = 仅允许新建，已存在则拒），工装不裸写磁盘
      try {
        await window.yushu.doc.write('world/foreshadow.yaml', text);
      } catch (err) {
        const current = await window.yushu.doc.read('world/foreshadow.yaml');
        await window.yushu.doc.write('world/foreshadow.yaml', text, current.hash);
      }
      await tab('世界观档案');
      const table = await waitFor(() => document.querySelector('.foreshadow-board .foreshadow-table') || null, 4000);
      if (!table) return { ok: false, note: '伏笔台账表没渲染出来（面板可能没拿到数据或通道未通）' };
      const rows = [...table.querySelectorAll('tbody tr')];
      // 汇总现在是**结构化行**（R127）⇒ 不再读那串自由文本（那个类已经没了）
      const summaryRows = [...document.querySelectorAll('.foreshadow-board .summary-row')];
      const summary = summaryRows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim()).join(' ');
      const fsCount = /伏笔\s*(\d+)\s*条/.exec(summary);
      const findings = [...document.querySelectorAll('.foreshadow-finding')];
      const rules = findings.map((li) => {
        const span = li.querySelectorAll('span')[1];
        return span ? span.textContent : '';
      });
      const closedRh = rows.some((tr) => tr.textContent.indexOf('哑仆') >= 0 && tr.textContent.indexOf('已闭环') >= 0);
      const overdueShown = rows.some((tr) => tr.textContent.indexOf('逾期') >= 0 && /逾期 [1-9][0-9]* 章/.test(tr.textContent));
      const contradiction = rules.indexOf('fs-paid-without-payoff') >= 0;
      const rhNotReported = !findings.some((li) => li.textContent.indexOf('哑仆') >= 0);
      // 红线：这一页只读——没有"替作者改状态"的按钮
      const writeBack = [...document.querySelectorAll('.foreshadow-board button')]
        .some((b) => (b.textContent || '').indexOf('写回') >= 0 || (b.textContent || '').indexOf('应用') >= 0);
      const panel = document.querySelector('.foreshadow-panel') || document.querySelector('.foreshadow-board');
      // 伏笔结论并入全书体检（R75）的运行时证据：去规则页点一次「全书体检」，
      // 表里必须出现 fs- 那条，且出处写着伏笔台账（单测切过区间，这里要的是界面上真看得见）
      await tab('规则');
      const auditBtn = await waitFor(() => document.querySelector('.consistency-manual'), 12000);
      if (!auditBtn) return { ok: false, note: '找不到「全书体检」按钮：' + pageText() };
      auditBtn.click();
      const fsRow = await waitFor(() => {
        const rows = [...document.querySelectorAll('.consistency-table tr')];
        return rows.find((r) => String(r.innerText).indexOf('fs-') >= 0 && String(r.innerText).indexOf('伏笔台账') >= 0) || null;
      }, 25000);
      const ledgerInAudit = fsRow !== null;
      const fsRuleShown = fsRow === null ? '' : String(fsRow.innerText).replace(/\s+/g, ' ').slice(0, 46);
      await tab('世界观档案');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: rows.length === 3 && overdueShown && closedRh && contradiction && rhNotReported && !writeBack &&
          ledgerInAudit && fsCount !== null && Number(fsCount[1]) === 3,
        note: '行=' + rows.length + '；汇总="' + summary.slice(0, 64) + '"；伏笔条数=' +
          (fsCount === null ? '读到不到' : fsCount[1]) + '；逾期外显=' + overdueShown +
          '；红鲱鱼已闭环=' + closedRh + '；红鲱鱼未被报缺陷=' + rhNotReported +
          '；paid 无回收章报矛盾=' + contradiction + '；结论规则=' + JSON.stringify(rules) +
          '；体检同表含伏笔结论=' + ledgerInAudit + '（行="' + fsRuleShown + '"）' +
          '；面板内写回按钮=' + writeBack,
      };
    `,
  },
  {
    step: 50,
    title: "世界观档案：时间线视图（统一刻度 + 历法只换显示 + 冲突与未判定外显）（M4/T4-7，R68）",
    file: "step50-timeline.png",
    body: String.raw`
      const YAML = [
        'apiVersion: yushu.timeline/v1',
        'anchor_event: ev-found',
        'calendars:',
        '  - id: imperial',
        '    label: 帝国纪年',
        '    offset: 1204',
        '  - id: common',
        '    label: 通纪',
        '    offset: 0',
        'timelines:',
        '  - id: tl-main',
        '    anchor_event: ev-found',
        '    calendar: imperial',
        '    scale: numeric',
        '    events: [ev-found, ev-destroy, ev-born, ev-unknown]',
        'events:',
        '  - id: ev-found',
        '    title: 建国',
        '    year: 0',
        '    timeline: tl-main',
        '    participants: [char-1]',
        '    location: geo-city',
        '    kind: founding',
        '    causes: []',
        '    effects: [ev-destroy]',
        '  - id: ev-destroy',
        '    title: 城破',
        '    year: 20',
        '    timeline: tl-main',
        '    participants: []',
        '    location: geo-city',
        '    kind: destruction',
        '    causes: [ev-found]',
        '    effects: []',
        '  - id: ev-born',
        '    title: 遗民生',
        '    year: 25',
        '    timeline: tl-main',
        '    participants: [char-2]',
        '    location: geo-city',
        '    kind: birth',
        '    causes: []',
        '    effects: []',
        '  - id: ev-unknown',
        '    title: 无名集会',
        '    year: 30',
        '    timeline: tl-main',
        '    participants: [char-1]',
        '    causes: []',
        '    effects: []',
      ].join('\n') + '\n';
      try {
        await window.yushu.doc.write('world/timeline.yaml', YAML);
      } catch (err) {
        const current = await window.yushu.doc.read('world/timeline.yaml');
        await window.yushu.doc.write('world/timeline.yaml', YAML, current.hash);
      }
      const hashBefore = (await window.yushu.doc.read('world/timeline.yaml')).hash;
      // 上一步就停在「世界观档案」：面板只在挂载时取数，直接等就是"等一个早就成立的条件"。
      // 先去别的页再回来，强制重挂载，才测得到"写完文件之后视图真的读到了"。
      await tab('规则');
      await tab('世界观档案');
      const table = await waitFor(() => document.querySelector('.timeline-view .timeline-table') || null, 4000);
      if (!table) return { ok: false, note: '时间线表没渲染出来（通道未通或视图没挂载）' };
      const rowsOf = () => [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()));
      const first = rowsOf();
      const ordered = first.length === 4 && first[0][0].indexOf('帝国纪年 1204 年') >= 0 && first[3][0].indexOf('帝国纪年 1234 年') >= 0;
      const findingsText = [...document.querySelectorAll('.timeline-finding')].map((li) => li.textContent || '').join(' | ');
      const conflictShown = findingsText.indexOf('tl-born-after-destruction') >= 0 && findingsText.indexOf('ev-born') >= 0;
      const skippedText = (document.querySelector('.timeline-skipped') || {}).textContent || '';
      const skippedShown = skippedText.indexOf('tl-kind-required') >= 0 && skippedText.indexOf('ev-unknown') >= 0;
      // 切历法：只该换掉「年份」列，「刻度」列一个数字都不动
      const select = document.querySelector('.timeline-calendar');
      if (!select) return { ok: false, note: '找不到历法下拉（时间线里没有 calendars 或面板没渲染选择器）' };
      select.value = 'common';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const after = await waitFor(() => {
        const rows = rowsOf();
        return rows.length === 4 && rows[0][0].indexOf('通纪 元年') >= 0 ? rows : null;
      }, 3000);
      if (!after) return { ok: false, note: '切换历法后年份列没变成通纪口径（当前=' + JSON.stringify(rowsOf()[0]) + '）' };
      const scaleUntouched = first.every((row, i) => row[2] === after[i][2]);
      const hashAfter = (await window.yushu.doc.read('world/timeline.yaml')).hash;
      const panel = document.querySelector('.timeline-view');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: ordered && conflictShown && skippedShown && scaleUntouched && hashBefore === hashAfter,
        note: '行=' + first.length + '；首行年份=' + first[0][0] + '；末行年份=' + first[3][0] +
          '；冲突外显=' + conflictShown + '；未判定外显=' + skippedShown +
          '；切历法后首行=' + after[0][0] + '；刻度列未动=' + scaleUntouched +
          '；真源 hash 未变=' + (hashBefore === hashAfter),
      };
    `,
  },
  {
    step: 51,
    title: "世界观档案：关系图谱（真源直算 + 悬空与未归类外显 + 点击聚焦）（M4/T4-9，R69）",
    file: "step51-graph.png",
    body: String.raw`
      // 先造一条**能成边**的关系：预演项目里的 3 条引用都指向章节（属 outOfScope，本来就不成边），
      // 不自己造一条就只能验"空图不报错"，验不到"边真的画出来了"。
      // 这张临时卡留在**预演项目**里（每次预演都是全新目录 ⇒ 不会脏到用户项目）。
      const cards = await window.yushu.card.list();
      const anchor = cards.find((c) => c.type === 'character') || cards[0];
      if (!anchor) return { ok: false, note: '项目里一张卡都没有，造不出关系' };
      // **幂等写**：这张临时卡可能已经在（上一次尝试失败时留下的）⇒ 先查再写。
      // 盲写会被拒（E_DOC_CONFLICT：未携带 baseHash）⇒ 不幂等的话第二次尝试就永远过不了。
      const probe = cards.find((c) => c.id === 'char-graph-probe');
      if (!probe) {
        await window.yushu.card.write({
          card: {
            id: 'char-graph-probe',
            type: 'character',
            name: '图谱探针',
            layer: 'characters',
            refs: [{ relation: 'rival_of', target: anchor.id }],
          },
          body: '临时卡：只为让关系图谱出现一条可画的边（预演项目每次都是全新目录 ⇒ 不会脏到用户项目）。',
        });
      }
      // 面板只在挂载时取数：先去别的页再回来，强制重挂载
      await tab('规则');
      await tab('世界观档案');
      const svg = await waitFor(() => document.querySelector('.graph-panel .graph-svg') || null, 4000);
      if (!svg) return { ok: false, note: '图谱 SVG 没渲染（通道未通或没有实体可画）' };
      const circles = [...svg.querySelectorAll('.graph-node circle')];
      const lines = [...svg.querySelectorAll('line')];
      // 汇总现在是**结构化行**（R126）⇒ 不再读那串自由文本（那个自由文本汇总的类名已经没了）
      const summaryText = () => [...document.querySelectorAll('.graph-panel .summary-row')]
        .map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim())
        .join(' ');
      const summary = summaryText();
      const legend = (document.querySelector('.graph-legend') || {}).textContent || '';
      const legendOk = legend.indexOf('人物') >= 0 && legend.indexOf('势力') >= 0 && legend.indexOf('地点') >= 0;
      // 悬空引用必须"未成边但被点名"：汇总里说有几条，就得有对应的提示块
      const danglingMentioned = /悬空引用\s*(\d+)\s*条/.exec(summary);
      const notices = [...document.querySelectorAll('.graph-notices')];
      const danglingOk = danglingMentioned === null
        ? true
        : (Number(danglingMentioned[1]) > 0 ? notices.some((n) => (n.textContent || '').indexOf('悬空引用') >= 0) : true);
      const edgesDrawn = lines.length > 0;
      // 点节点 = 聚焦：汇总行应改成"聚焦「X」2 跳内"
      const before = summary;
      circles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const focused = await waitFor(() => {
        const now = summaryText();
        return now.indexOf('聚焦') >= 0 && now !== before ? now : null;
      }, 3000);
      const panel = document.querySelector('.graph-panel');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: circles.length >= 3 && edgesDrawn && legendOk && danglingOk && focused !== null,
        note: '临时卡 char-graph-probe 造 1 条边；节点=' + circles.length + '；边=' + lines.length +
          '；汇总="' + before.slice(0, 72) + '"' +
          '；图例三网=' + legendOk + '；悬空外显=' + danglingOk +
          '（提到条数=' + (danglingMentioned ? danglingMentioned[1] : '无') + '，提示块=' + notices.length + '）' +
          '；点击聚焦后="' + (focused === null ? '（未变）' : focused.slice(0, 46)) + '"',
      };
    `,
  },
  {
    step: 52,
    title: "世界观档案：编年史伪史书（多文化分行 + 分歧与诸说一致 + era 分段不猜）（M4/T4-8，R71）",
    file: "step52-chronicle.png",
    body: String.raw`
      // 真源造三件事：一个有两个文化记载且说法不同的事件、一个说法一致的事件、一个没有多文化版本的事件；
      // 外加两张 era 卡——一张写了年代区间、一张没写（后者必须进 eraSkipped，而不是被猜出边界）
      const YAML = [
        'apiVersion: yushu.timeline/v1',
        'anchor_event: ev-war',
        'calendars:',
        '  - id: common',
        '    label: 通纪',
        '    offset: 0',
        'timelines:',
        '  - id: tl-main',
        '    anchor_event: ev-war',
        '    calendar: common',
        '    scale: numeric',
        '    events: [ev-war, ev-treaty, ev-market]',
        'events:',
        '  - id: ev-war',
        '    title: 开国之役',
        '    year: 0',
        '    timeline: tl-main',
        '    participants: []',
        '    causes: []',
        '    effects: []',
        // R133：事件发生的**地点实体 id**（K08 §3.8 的 place_ref）⇒ 与地图上的标注对得上号
        '    place_ref: loc-map-probe',
        '    pov_viewpoints:',
        '      - culture: 官修史',
        '        account: 王师一战而定',
        '        source: 起居注',
        '      - culture: 边地谣',
        '        account: 冻死过半才破城',
        '        source: 采诗官',
        '  - id: ev-treaty',
        '    title: 十二城之盟',
        '    year: 12',
        '    timeline: tl-main',
        '    participants: []',
        '    causes: []',
        '    effects: []',
        '    pov_viewpoints:',
        '      - culture: 官修史',
        '        account: 诸城会盟定界',
        '      - culture: 边地谣',
        '        account: 诸城会盟定界',
        '  - id: ev-market',
        '    title: 开市',
        '    year: 40',
        '    timeline: tl-main',
        '    participants: []',
        '    causes: []',
        '    effects: []',
      ].join('\n') + '\n';
      const current = await window.yushu.doc.read('world/timeline.yaml').catch(() => null);
      if (current === null) await window.yushu.doc.write('world/timeline.yaml', YAML);
      else await window.yushu.doc.write('world/timeline.yaml', YAML, current.hash);
      const writeCardIdempotent = async (path, payload) => {
        const existing = await window.yushu.card.read(path).catch(() => null);
        if (existing === null) return window.yushu.card.write({ path, card: payload.card, body: payload.body });
        return window.yushu.card.write({ path, card: payload.card, body: payload.body, baseHash: existing.hash });
      };
      await writeCardIdempotent('world/cards/era/era-founding.md', {
        card: { id: 'era-founding', type: 'era', name: '建国时代', layer: 'eras', extensions: { chronicle: { from: -10, to: 30 } } },
        body: '有年代区间的时代卡。',
      });
      await writeCardIdempotent('world/cards/era/era-no-range.md', {
        card: { id: 'era-no-range', type: 'era', name: '无区间时代', layer: 'eras' },
        body: '没写 chronicle 区间的时代卡：必须进 eraSkipped，而不是被猜出边界。',
      });
      await tab('规则');
      await tab('世界观档案');
      const table = await waitFor(() => document.querySelector('.chronology-panel .chronology-table') || null, 4000);
      if (!table) return { ok: false, note: '编年史表没渲染（通道未通或视图没挂载）' };
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()));
      const text = rows.map((r) => r.join('|')).join('\n');
      const splitRows = rows.filter((r) => r[3].indexOf('开国之役') >= 0).length === 2;
      const diffFlag = /开国之役[^\n]*分歧 2/.test(text);
      const sameFlag = /十二城之盟[^\n]*诸说一致/.test(text);
      const neutral = /开市[^\n]*中性记载/.test(text);
      const eraColumn = rows.some((r) => r[0] === '建国时代') && rows.some((r) => r[0] === '—');
      const yearVsScale = rows.some((r) => r[1].indexOf('通纪') >= 0 && r[2] !== r[1]);
      const notices = [...document.querySelectorAll('.chronology-notices')].map((n) => n.textContent || '').join(' ');
      const skippedOk = notices.indexOf('era-no-range') >= 0;
      const panel = document.querySelector('.chronology-panel');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: rows.length === 5 && splitRows && diffFlag && sameFlag && neutral && eraColumn && yearVsScale && skippedOk,
        note: '行数=' + rows.length + '；同一事件分两行=' + splitRows + '；分歧徽标=' + diffFlag +
          '；诸说一致徽标=' + sameFlag + '；中性记载=' + neutral + '；时代列含未入段=' + eraColumn +
          '；年份与刻度分列=' + yearVsScale + '；无区间 era 被点名=' + skippedOk,
      };
    `,
  },
  {
    step: 53,
    title: "世界观档案：分析面板各自成框（内容不得溢出框外压住相邻面板）（R71 布局回归锁）",
    file: "step53-panel-boxes.png",
    body: String.raw`
      await tab('世界观档案');
      const boxes = await waitFor(() => {
        const list = [...document.querySelectorAll('.archive > *, .archive-analysis > *')];
        return list.length >= 7 ? list : null;
      }, 8000);
      if (!boxes) return { ok: false, note: '档案页顶层块不足 7 个：' + pageText() };
      const rects = boxes.map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          cls: String(el.className),
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          left: Math.round(r.left), right: Math.round(r.right),
          clientH: el.clientHeight, scrollH: el.scrollHeight,
          overflowY: cs.overflowY,
        };
      });
      // ① 内容画到框外：滚动高明显大于盒子高、又没开滚动条——这些字会直接压在下一个面板上
      const spilling = rects.filter((b) => b.scrollH > b.clientH + 4 && b.overflowY === 'visible');
      // ② 两个顶层框真的相交（>8px 见方才算，1px 边框贴合不算）
      const hits = [];
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i];
          const b = rects[j];
          const ow = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ow > 8 && oh > 8) hits.push(a.cls + ' × ' + b.cls + '(' + ow + 'x' + oh + ')');
        }
      }
      const tag = (b) => (String(b.cls).split(' ')[1] || String(b.cls) || '(无类名)');
      // 截图要能看见"面板各自成框"：把分析区顶部对齐视口（step52 是把编年史居中，两帧必须不同画面，
      // 否则截图守卫会报"与上一张相同"，那这一帧就不算证据）
      const scroller = document.querySelector('.archive-scroll');
      const analysis = document.querySelector('.archive-analysis');
      if (scroller && analysis) scroller.scrollTop = analysis.offsetTop - 6;
      await sleep(220);
      return {
        ok: spilling.length === 0 && hits.length === 0,
        note: '顶层块=' + rects.length +
          '；内容溢出框外=' + (spilling.length === 0 ? '无' : spilling.map((b) => tag(b) + '(框' + b.clientH + '<容' + b.scrollH + ')').join(' ')) +
          '；框框相交=' + (hits.length === 0 ? '无' : hits.join(' ')) +
          '；各块高=' + rects.map((b) => tag(b) + ':' + (b.bottom - b.top)).join(' ') +
          '；截图前 scrollTop=' + (scroller ? Math.round(scroller.scrollTop) : -1),
      };
    `,
  },
  {
    step: 54,
    title: "世界观档案：爽点与期待感看板（阈值不设就不判 + 推进率无声明 + 只读）（M4/T4-10，R73）",
    file: "step54-satisfaction.png",
    body: String.raw`
      // 台账按本项目真实章序构造：一条逾期承诺、一条 dropped 无理由、一条 paid 无证据、
      // 一个 advances 自相矛盾的场景、一段中间断档的曲线（断档那章必须被点名）
      const outline = await window.yushu.outline.read();
      const volumes = (outline.doc || {}).volumes || [];
      const ids = [];
      for (const volume of volumes) {
        for (const chapter of volume.chapters || []) ids.push(chapter.chapter_id || chapter.id);
      }
      if (ids.length < 5) return { ok: false, note: '章清单只有 ' + ids.length + ' 条，构造不出断档样本' };
      const YAML = [
        'apiVersion: yushu.satisfaction/v1',
        'hits:',
        '  - {id: sh-wt-a, chapter: ' + ids[0] + ', type: upgrade, intensity: 4, beneficiary: 主角}',
        '  - {id: sh-wt-b, chapter: ' + ids[1] + ', type: upgrade, intensity: 4, beneficiary: 主角}',
        '  - {id: sh-wt-c, chapter: ' + ids[2] + ', type: upgrade, intensity: 4, beneficiary: 主角}',
        'promises:',
        '  - {id: pr-wt-open, promise: "三年之约", source: 简介, made_ch: ' + ids[0] + ', due_ch: ' + ids[1] + ', status: open}',
        '  - {id: pr-wt-drop, promise: "废掉宗主之位", source: 台词, made_ch: ' + ids[0] + ', status: dropped}',
        '  - {id: pr-wt-paid, promise: "救回妹妹", source: 核心梗, made_ch: ' + ids[0] + ', status: paid}',
        'curve:',
        '  - {phase: suppress, from_ch: ' + ids[0] + ', to_ch: ' + ids[1] + '}',
        '  - {phase: release, from_ch: ' + ids[3] + ', to_ch: ' + ids[4] + '}',
        'scenes:',
        '  - {id: sc-wt-go, chapter: ' + ids[0] + ', advances: [main], outcome: "yes"}',
        '  - {id: sc-wt-bad, chapter: ' + ids[1] + ', advances: [none, main], outcome: "yes"}',
        '',
      ].join('\n');
      const current = await window.yushu.doc.read('world/satisfaction.yaml').catch(() => null);
      if (current === null) await window.yushu.doc.write('world/satisfaction.yaml', YAML);
      else await window.yushu.doc.write('world/satisfaction.yaml', YAML, current.hash);
      const hashBefore = (await window.yushu.doc.read('world/satisfaction.yaml')).hash;
      // 面板只在挂载时取数：先去别的页再回来强制重挂载（R68 的教训）
      await tab('规则');
      await tab('世界观档案');
      const panel = await waitFor(() => {
        const t = [...document.querySelectorAll('.panel-title')].find((x) => x.textContent.indexOf('爽点与期待感') >= 0);
        return t ? t.closest('.panel') : null;
      }, 12000);
      if (!panel) return { ok: false, note: '未找到爽点与期待感面板：' + pageText() };
      panel.scrollIntoView({ block: 'center' });
      await sleep(250);
      const text = String(panel.innerText).replace(/\s+/g, ' ');
      const readNote = text.indexOf('读不了') >= 0;
      // ① 阈值全空 ⇒ 「没判的」必须成块出现并点名缺哪个旋钮（把没判显示成绿灯，比不显示更坏）
      const ne = panel.querySelector('.satisfaction-not-evaluated');
      const neText = ne === null ? '' : String(ne.textContent);
      const neOk = neText.indexOf('sf-release-gap') >= 0 && neText.indexOf('release_interval_max') >= 0;
      const findingsOk = ['sf-promise-overdue', 'sf-dropped-without-reason', 'sf-paid-without-evidence', 'sf-scene-contradiction']
        .every((r) => text.indexOf(r) >= 0);
      const gapOk = text.indexOf('不属于任何阶段') >= 0 && text.indexOf(ids[2]) >= 0;
      const overdueOk = /逾期 \d+ 章/.test(text);
      const noDeclareOk = text.indexOf('无声明') >= 0;
      const writeButtons = [...panel.querySelectorAll('button')].length;
      // ② 设一个阈值 ⇒ 该规则从「没判的」里**消失**并在结论里出现。
      //    等的是「消失」这个变化，不是等节点存在——R71 那条「等一个已经为真的条件」的教训。
      const inputs = [...panel.querySelectorAll('.satisfaction-threshold')];
      if (inputs.length < 6) return { ok: false, note: '阈值输入框只有 ' + inputs.length + ' 个：' + pageText() };
      setV(inputs[0], '2');
      const afterSet = await waitFor(() => {
        const neNow = panel.querySelector('.satisfaction-not-evaluated');
        const now = neNow === null ? '' : String(neNow.textContent);
        if (now.indexOf('sf-same-type-streak') >= 0) return null;
        const body = String(panel.innerText).replace(/\s+/g, ' ');
        return body.indexOf('sf-same-type-streak') >= 0 ? body : null;
      }, 12000);
      const streakOk = afterSet !== null;
      const hashAfter = (await window.yushu.doc.read('world/satisfaction.yaml')).hash;
      return {
        ok: !readNote && neOk && findingsOk && gapOk && overdueOk && noDeclareOk && streakOk && writeButtons === 0 && hashAfter === hashBefore,
        note: '结论四类齐=' + findingsOk + '；断档点名 ' + ids[2] + '=' + gapOk + '；逾期外显=' + overdueOk +
          '；无声明显示=' + noDeclareOk + '；阈值未设进「没判的」=' + neOk + '；设阈值后改出结论=' + streakOk +
          '；面板内写回按钮=' + writeButtons + '；真源 hash 未变=' + (hashAfter === hashBefore) +
          (readNote ? '；台账被判读不了（严格解析拒了夹具）' : ''),
      };
    `,
  },
  {
    step: 55,
    title: "稿件总览：导入存量稿件只预演不写盘（编码猜的要说出来 / 清洗留报告 / 切不开要认）（M5/T5-7，R77）",
    file: "step55-import-preview.png",
    fixture: "import-dialog",
    body: String.raw`
      // 原生选文件对话框无法自动化：夹具只替换"操作系统那一层"（见 openImportDialogFixture），
      // 面板点击 → import:pick → 闸门登记 → import:preview → 引擎探测清洗分章 → 面板渲染全程真实。
      const info = window.__yushuImportFixture ? JSON.parse(window.__yushuImportFixture) : null;
      if (info === null) return { ok: false, note: '导入夹具未注入（主进程 harness 没跑？）' };
      // 真源目录快照（派生区 .yushu/ 与 .git/ 排除：快照循环与心跳会写那儿，与导入无关）
      const truthTree = async () => {
        const tree = await window.yushu.project.tree();
        return JSON.stringify(tree.filter((e) => /^(chapters|world|outline|config)\//.test(e.path)));
      };
      const before = await truthTree();
      await tab('稿件总览');
      const toggle = await waitFor(() => {
        const t = [...document.querySelectorAll('.disclosure-toggle')].find((x) => String(x.textContent).indexOf('导入存量稿件') >= 0);
        return t || null;
      }, 8000);
      if (toggle === null) return { ok: false, note: '总览页没有导入折叠区：' + pageText() };
      // 折叠态要幂等：失败重试时上一轮可能已经展开了，再点一次就把它**关掉**（v175 的第二次 attempt 就这么红的）
      const isOpen = () => String(toggle.closest('.disclosure').className).indexOf('open') >= 0;
      if (!isOpen()) toggle.click();
      await sleep(320);
      const opened = isOpen();
      const panel = await waitFor(() => document.querySelector('.import-panel'), 4000);
      if (panel === null) return { ok: false, note: '展开后没有导入面板' };
      const btn = (label) => [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf(label) >= 0);
      const pickBtn = btn('选择文件');
      if (pickBtn === undefined) return { ok: false, note: '面板里没有「选择文件…」按钮：' + lines(panel) };
      const read = () => String(panel.innerText).replace(/\s+/g, ' ');
      // 选哪份稿件由主进程桩读 window.__yushuPick 决定（不靠点击次序）
      const setPick = (which) => { window.__yushuPick = which; };

      // ⓪ 失败重试会带着上一次的面板状态重进（自定义规则还在），先清回基线再验 ①
      setPick('utf8');
      pickBtn.click();
      await waitFor(() => (read().indexOf('编码探测') >= 0 ? true : null), 12000);
      const staleClear = btn('清空自定义');
      if (staleClear !== undefined) {
        staleClear.click();
        await waitFor(() => (read().indexOf('custom-') < 0 && read().indexOf('分章预演：3 章') >= 0 ? true : null), 12000);
      }

      // ① UTF-8 稿件：报告三项 + 密钥就地替换 + 面板里读不到绝对路径
      const first = await waitFor(() => {
        const t = read();
        return t.indexOf('编码探测') >= 0 && t.indexOf('utf-8') >= 0 && t.indexOf('分章预演：3 章') >= 0 ? t : null;
      }, 12000);
      if (first === null) return { ok: false, note: '第一次预演没出完整报告：' + read().slice(0, 300) };
      const urlRemoved = first.indexOf('pure-url') >= 0;
      const keyRedacted = first.indexOf('abcdefghijklmnopqrstuvwx') < 0 && first.indexOf('已剔除疑似密钥') >= 0;
      const chaptersOk = ['第一章 起', '第二章 承', '第三章 转'].every((t) => first.indexOf(t) >= 0);
      const volumeOk = first.indexOf('第一卷 风起') >= 0;
      const preambleOk = first.indexOf('首章之前另有') >= 0;
      const notGuessed = first.indexOf('这是猜的') < 0;
      const noPath = first.indexOf(info.dir) < 0;
      const boundaryOk = first.indexOf('导入这条线还没做完') >= 0;

      // ② 追加一条自定义正则删掉三个章标题 ⇒ 必须显式承认"没切开"（可配正则不是摆设）
      const input = panel.querySelector('.import-rule-input');
      if (input === null) return { ok: false, note: '没有自定义规则输入框' };
      setV(input, '^第[一二三]章');
      await sleep(120);
      const addBtn = btn('追加');
      if (addBtn === undefined) return { ok: false, note: '没有「追加」按钮' };
      addBtn.click();
      const second = await waitFor(() => {
        const t = read();
        return t.indexOf('没找到章节标题') >= 0 && t.indexOf('分章预演：1 章') >= 0 ? t : null;
      }, 12000);
      const hardSplitOk = second !== null;

      // ③ 清空自定义 ⇒ 回到三章（规则参与的是同一份字节，不是另起一版）
      const clearBtn = btn('清空自定义');
      if (clearBtn !== undefined) clearBtn.click();
      const cleared = clearBtn === undefined ? null : await waitFor(() => {
        const t = read();
        return t.indexOf('分章预演：3 章') >= 0 && t.indexOf('没找到章节标题') < 0 ? t : null;
      }, 12000);
      const clearedOk = cleared !== null;

      // ④ 改选 GBK 稿件 ⇒ 「这是猜的」必须成横幅
      setPick('gbk');
      pickBtn.click();
      const gbk = await waitFor(() => {
        const t = read();
        return t.indexOf('gb18030') >= 0 && t.indexOf('这是猜的') >= 0 ? t : null;
      }, 12000);
      const assumedOk = gbk !== null;

      // ⑤ 第三次点选是"用户取消" ⇒ 面板回到初始态，不留一份悬空的报告
      setPick('cancel');
      pickBtn.click();
      const cancelled = await waitFor(() => {
        const t = read();
        return t.indexOf('编码探测') < 0 && t.indexOf('路径不进渲染层') >= 0 ? t : null;
      }, 8000);
      const cancelOk = cancelled !== null;

      // ⑥ 截图前把 UTF-8 报告再放回来：⑤ 之后面板是空态，空态截图证明不了任何一份报告被显示过
      setPick('utf8');
      pickBtn.click();
      const finalView = await waitFor(() => {
        const t = read();
        return t.indexOf('分章预演：3 章') >= 0 && t.indexOf('pure-url') >= 0 ? t : null;
      }, 12000);
      const finalOk = finalView !== null;
      // 「确认入库」按钮**在**（step56 才点它）：本步的零写入不靠"没有按钮"来证明，
      // 靠的是真源目录树逐字未变——把按钮数当零写入的证据是假证据（按钮可以藏、可以改名）。
      // 取在 ⑥ 之后：空态下面板根本没有这个按钮，取早了量到的是 0（v175 就这么红过一次）。
      const applyButtons = [...panel.querySelectorAll('button')]
        .filter((b) => /确认入库/.test(String(b.textContent))).length;
      // 零写入的对照覆盖整步（含 ⑥），所以取在最后一次预演之后
      const after = await truthTree();
      panel.scrollIntoView({ block: 'center' });
      // 面板内部滚到底：分章表与边界说明要和清洗报告进同一帧（面板自身有滚动上限，不撑没下面的列表）
      panel.scrollTop = panel.scrollHeight;
      await sleep(240);
      return {
        ok: opened && urlRemoved && keyRedacted && chaptersOk && volumeOk && preambleOk && notGuessed &&
          noPath && boundaryOk && hardSplitOk && clearedOk && assumedOk && cancelOk && finalOk &&
          applyButtons === 1 && after === before,
        note: '折叠区展开=' + opened + '；删行规则外显=' + urlRemoved + '；密钥就地替换=' + keyRedacted +
          '；三章列出=' + chaptersOk + '；卷标题不当章=' + volumeOk + '；楔子单独安置=' + preambleOk +
          '；UTF-8 不标猜测=' + notGuessed + '；面板无绝对路径=' + noPath + '；边界说明=' + boundaryOk +
          '；自定义正则改出「没切开」=' + hardSplitOk + '；清空后复原=' + clearedOk +
          '；GBK 标「这是猜的」=' + assumedOk + '；取消回初始态=' + cancelOk +
          '；截图前报告复位=' + finalOk +
          '；入库按钮在场未点=' + applyButtons + '；真源目录未变=' + (after === before),
      };
    `,
  },
  {
    step: 56,
    title: "稿件总览：确认入库——建卷建章 + 逐章字数对账 + 票据一次性（M5/T5-7，R79）",
    file: "step56-import-apply.png",
    fixture: "import-dialog",
    body: String.raw`
      // 与 step55 同一套夹具（原生对话框桩由驱动侧提供，产品代码零测试分支）。
      // 这一步开始**写真源**，所以断言从"报告对不对"换成"写下去的东西对得上吗"。
      const info = window.__yushuImportFixture ? JSON.parse(window.__yushuImportFixture) : null;
      if (info === null) return { ok: false, note: '导入夹具未注入' };
      const truthTree = async () => {
        const tree = await window.yushu.project.tree();
        // 只数文件：新建一卷会连带建一个 chapters/vol-xxx/ 目录，按条目数会多算（v175 实测 6 而非 4）
        return tree.filter((e) => e.type === 'file' && /^(chapters|world|outline)\//.test(e.path));
      };
      const sliceOf = (list, prefix) => JSON.stringify(list.filter((e) => e.path.indexOf(prefix) === 0));
      const before = await truthTree();
      const beforeChapters = before.filter((e) => e.path.indexOf('chapters/') === 0).length;
      const beforeOutline = sliceOf(before, 'outline/');
      await tab('规则');
      await tab('稿件总览'); // 强制重挂载：面板状态不该从上一次预演里继承
      const toggle = await waitFor(() => {
        const t = [...document.querySelectorAll('.disclosure-toggle')].find((x) => String(x.textContent).indexOf('导入存量稿件') >= 0);
        return t || null;
      }, 8000);
      if (toggle === null) return { ok: false, note: '没有导入折叠区：' + pageText() };
      // 折叠态幂等：重试时上一轮可能已经展开，再点一次就把它关掉
      const isOpen = () => String(toggle.closest('.disclosure').className).indexOf('open') >= 0;
      if (!isOpen()) toggle.click();
      await sleep(320);
      const panel = await waitFor(() => document.querySelector('.import-panel'), 4000);
      if (panel === null) return { ok: false, note: '展开后没有导入面板' };
      const btn = (label) => [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf(label) >= 0);
      const read = () => String(panel.innerText).replace(/\s+/g, ' ');
      const setPick = (which) => { window.__yushuPick = which; };
      const resultText = () => {
        const el = document.querySelector('.import-result');
        return el === null ? '' : String(el.innerText).replace(/\s+/g, ' ');
      };

      // ① 没切开的稿子：不勾确认框 ⇒ 入库按钮必须是禁用的（不是"点了再说"）
      setPick('flat');
      btn('选择文件').click();
      const flatView = await waitFor(() => (read().indexOf('没找到章节标题') >= 0 ? true : null), 12000);
      if (flatView === null) return { ok: false, note: '没切开的稿子没给出说明：' + read().slice(0, 200) };
      const applyBtn = btn('确认入库');
      if (applyBtn === undefined) return { ok: false, note: '没有「确认入库」按钮：' + read().slice(0, 200) };
      const gatedBefore = applyBtn.disabled === true;
      const box = panel.querySelector('.import-confirm-box');
      if (box === null) return { ok: false, note: '没切开时没出现「整篇作为一章」确认框' };
      box.click();
      await sleep(160);
      const gatedAfter = btn('确认入库').disabled === false;

      // ② 勾了之后入库：卷名自己起，回执必须点名"1 章 / 对账 / 撤销窗口 / 票据作废"
      const nameInput = panel.querySelector('.import-volume-input');
      if (nameInput === null) return { ok: false, note: '没有卷名输入框' };
      setV(nameInput, '作者命名的一卷');
      await sleep(120);
      btn('确认入库').click();
      const done1 = await waitFor(() => {
        const t = resultText();
        return t.indexOf('作者命名的一卷') >= 0 && t.indexOf('1 章') >= 0 ? t : null;
      }, 20000);
      const appliedFlat = done1 !== null;
      const undoShown = appliedFlat && done1.indexOf('撤销窗口') >= 0 && done1.indexOf('票据已作废') >= 0;
      const reconciled1 = appliedFlat && done1.indexOf('对账通过') >= 0;

      // ③ 写进真源的东西要在稿件总览里看得见（大纲驱动，看不见等于没导进去）。
      //    列表是虚拟滚动的，新卷排在最后 30 多行之外——不靠过滤框收窄，DOM 里根本没有那一行（v175 实测）。
      const refresh = [...document.querySelectorAll('button')].find((b) => String(b.textContent).trim() === '刷新');
      if (refresh !== undefined) refresh.click();
      await sleep(300);
      const filterInput = document.querySelector('.library-tools input');
      if (filterInput === null) return { ok: false, note: '没有章节过滤框，无法在虚拟列表里定位新章' };
      setV(filterInput, '作者命名的一卷');
      const rowShown = await waitFor(() => {
        const rows = [...document.querySelectorAll('.library-row')];
        const hit = rows.find((r) => String(r.textContent).indexOf('作者命名的一卷') >= 0);
        return hit !== undefined && /\d+ 字/.test(String(hit.textContent)) ? true : null;
      }, 10000);
      const listed = rowShown !== null;
      setV(filterInput, ''); // 清回全量，别把过滤态带给后面的步骤

      // ④ 再来一份三章的：不勾确认框也能直接入库（切开了），且楔子只点名不入库
      setPick('utf8');
      btn('选择文件').click();
      const v3 = await waitFor(() => (read().indexOf('分章预演：3 章') >= 0 ? true : null), 12000);
      const previewed3 = v3 !== null;
      btn('确认入库').click();
      const done2 = await waitFor(() => {
        const t = resultText();
        return t.indexOf('3 章') >= 0 && t.indexOf('未入库') >= 0 ? t : null;
      }, 20000);
      const applied3 = done2 !== null;
      const preambleKept = done2 !== null && done2.indexOf('未入库') >= 0;
      const noSecret = done2 !== null && done2.indexOf('abcdefghijklmnopqrstuvwx') < 0;

      const after = await truthTree();
      const addedChapters = after.filter((e) => e.path.indexOf('chapters/') === 0).length - beforeChapters;
      const outlineChanged = sliceOf(after, 'outline/') !== beforeOutline;
      const result2 = document.querySelector('.import-result');
      if (result2 !== null) result2.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: gatedBefore && gatedAfter && appliedFlat && undoShown && reconciled1 && listed &&
          previewed3 && applied3 && preambleKept && noSecret && addedChapters === 4 && outlineChanged,
        note: '未确认时禁用=' + gatedBefore + '；勾了才可点=' + gatedAfter + '；整篇一章入库=' + appliedFlat +
          '；回执带撤销窗口与票据作废=' + undoShown + '；逐章对账通过=' + reconciled1 +
          '；总览看得见新章=' + listed + '；三章预演=' + previewed3 + '；三章入库=' + applied3 +
          '；楔子只点名不入库=' + preambleKept + '；密钥不进回执=' + noSecret +
          '；新增草稿文件=' + addedChapters + '（期望 4）；大纲已变=' + outlineChanged,
      };
    `,
  },
  {
    step: 57,
    title: "导出与自查：本机能力矩阵按实测说话（M5/T5-4，R87）",
    file: "step57-export-capabilities.png",
    body: String.raw`
      // 这一步不写盘，也不猜机器：面板上的每一格都必须是"现场探测 + 判定"的结果。
      // 断言刻意只钉**与机器无关**的口径（顺序、每条都有原因、TXT 必可用、措辞不许含糊），
      // 换台机器 EPUB/PDF 的结论会变，但"给了结论且给了依据"这件事不会变。
      await tab('导出与自查');
      const panel = await waitFor(() => document.querySelector('.export-capabilities'), 10000);
      if (panel === null) return { ok: false, note: '导出页没有能力矩阵面板：' + pageText() };
      const text = () => String(panel.innerText).replace(/\s+/g, ' ');
      const rows = await waitFor(() => {
        const r = [...panel.querySelectorAll('tbody tr')];
        return r.length >= 4 ? r : null;
      }, 20000);
      if (rows === null) {
        return { ok: false, note: '能力矩阵不足 4 行（探测没回来？面板写的是：' + text().slice(0, 220) + '）' };
      }
      const formats = rows.map((r) => String(r.children[0].textContent).trim());
      const verdicts = rows.map((r) => String(r.children[1].textContent).trim());
      const reasons = rows.map((r) => String(r.children[2].textContent).trim());
      const orderOk = formats.join(',') === 'TXT,EPUB,DOCX,PDF';
      const verdictsOk = verdicts.every((v) => v === '可产出' || v === '暂不可');
      // 「暂不可」必须点名缺什么（"缺引擎"这类具体词），不许只写"不支持"糊过去
      const specific = reasons.every((r) => r.length >= 8);
      const txtAvailable = verdicts[0] === '可产出';
      const honestWording = text().indexOf('按本机实测') >= 0 && text().indexOf('不写入任何文件') >= 0;
      panel.scrollIntoView({ block: 'center' });
      await sleep(260);
      return {
        ok: orderOk && verdictsOk && specific && txtAvailable && honestWording,
        note: '顺序=' + formats.join('/') + '（期望 txt/epub/docx/pdf）；判定只用两档=' + verdictsOk +
          '；每条都有具体依据=' + specific + '；TXT 判可产出=' + txtAvailable +
          '；措辞如实（实测口径 + 只读探测）=' + honestWording + '；本机结论=' +
          formats.map((f, i) => f + '=' + verdicts[i]).join('、'),
      };
    `,
  },
  {
    step: 58,
    title: "导出与自查：格式选择 + 真出一份 EPUB，门禁说「未校验」（M5/T5-4，R90）",
    file: "step58-export-formats.png",
    body: String.raw`
      // 这一轮第一次让产品真的产出非 TXT 格式。三条要紧的断言：
      // ① 选择器与能力矩阵必须说同一句话（同一个事实不许有两个结论）；
      // ② 选中的格式要一路带到按钮与回执里（"点了 EPUB 结果拿到 TXT"是最坏的那种错）；
      // ③ EPUBCheck 不在 ⇒ 回执写「未校验」，不许写「通过」。
      await tab('规则');
      await tab('导出与自查'); // 强制重挂载：重试时不能继承上一轮选中的格式（v192 第二次 attempt 就带着 EPUB 选中态进来）
      const chips = await waitFor(() => {
        const c = [...document.querySelectorAll('.export-formats .chip')];
        return c.length >= 4 ? c : null;
      }, 20000);
      if (chips === null) return { ok: false, note: '没有格式选择器：' + pageText() };
      const labels = chips.map((c) => String(c.textContent).trim());
      const orderOk = labels.join(',') === 'TXT,EPUB,DOCX,PDF';
      // 能力矩阵面板里的结论（同一页另一处，必须与选择器一致）
      const capRows = [...document.querySelectorAll('.export-capabilities tbody tr')].map((tr) => ({
        format: String(tr.children[0].textContent).trim().toUpperCase(),
        verdict: String(tr.children[1].textContent).trim(),
      }));
      const agree = labels.every((label, i) => {
        const row = capRows.find((r) => r.format === label);
        if (row === undefined) return false;
        const chipAvailable = chips[i].disabled === false;
        return chipAvailable === (row.verdict === '可产出');
      });
      const txtSelectedByDefault = String(chips[0].className).indexOf('on') >= 0;

      // 挑一个"本机可产出"的非 TXT 格式真出一次；本机没有就如实标注（不假装跑过）
      const pickIndex = labels.findIndex((label, i) => i > 0 && chips[i].disabled === false);
      let ranFormat = '';
      let failText = '';
      let receiptOk = false;
      let gateOk = false;
      let fileOnDisk = false;
      if (pickIndex > 0) {
        const picked = labels[pickIndex];
        chips[pickIndex].click();
        await sleep(220);
        const btnLabel = [...document.querySelectorAll('button')]
          .find((b) => String(b.textContent).indexOf('确认导出') >= 0);
        ranFormat = picked + '=' + (btnLabel === undefined ? '按钮不见了' : String(btnLabel.textContent).trim());
        const reasonText = String((document.querySelector('.export-format-reason') || {}).textContent || '').trim();
        const reasonChanged = reasonText.length > 6 && reasonText.indexOf('御书自己装配') < 0;
        const chk = document.querySelector('.confirm-check input[type=checkbox]');
        if (chk && !chk.disabled && !chk.checked) chk.click();
        await sleep(160);
        const go = [...document.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('确认导出') >= 0);
        if (go && !go.disabled) go.click();
        const notice = await waitFor(() => {
          const t = String(document.body.innerText);
          const hit = t.split('\n').find((line) => line.indexOf('已导出 ' + picked) >= 0);
          return hit === undefined ? null : String(hit);
        }, 40000);
        receiptOk = notice !== null && reasonChanged;
        // 失败时把错误条原文抄进证据行：下一次不用再猜"为什么没有回执"（v192 就是这样查出来的相对路径）
        const errBar = document.querySelector('.error-bar');
        failText = errBar === null ? '' : String(errBar.textContent).replace(/\s+/g, ' ').slice(0, 220);
        // 门禁措辞：EPUBCheck 不在 ⇒ 必须出现「未校验」；在 ⇒ 必须出现"通过/未通过"，两者都不许沉默
        gateOk = notice === null ? false : (picked !== 'EPUB' || /未校验|质检通过|质检未通过/.test(notice));
        if (notice !== null) {
          const tree = await window.yushu.project.tree();
          fileOnDisk = tree.some((e) => e.type === 'file' && e.path.indexOf('exports/') === 0
            && e.path.endsWith('.' + picked.toLowerCase()));
        }
      } else {
        ranFormat = '本机除 TXT 外无可产出格式（跳过实际产出，不假装跑过）';
        receiptOk = true;
        gateOk = true;
        fileOnDisk = true;
      }
      document.querySelector('.export-formats').scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: orderOk && agree && txtSelectedByDefault && receiptOk && gateOk && fileOnDisk,
        note: '顺序=' + labels.join('/') + '；选择器与能力矩阵一致=' + agree +
          '；默认选中 TXT=' + txtSelectedByDefault + '；实跑格式=' + ranFormat +
          '；回执到位=' + receiptOk + '；门禁措辞=' + gateOk + '；产物落盘=' + fileOnDisk +
          (failText === '' ? '' : '；错误条=' + failText),
      };
    `,
  },
  {
    step: 59,
    title: '导出与自查：平台章节格式从包读，样例与盘上产物一致（M5/T5-4·K11，R94）',
    file: 'step59-platform-format.png',
    body: String.raw`
      // K11 的验收点是"参数从包读，而且真的落到产物上"。这一步管四件事：
      // ① 平台清单来自 packs/platforms/——一个都没有就如实跳过，不假装跑过；
      // ② 选中平台后必须给出"你写的标题 → 导出会写出的章头"样例，且章头里**不许出现重复的"第N章"**
      //    （这是 R94 查出来的真缺陷：模板补一个前缀、标题自带一个，产物就成了"第1章 第一章 边城少年"）；
      // ③ 坏包必须 disabled 且 title 带原因（点不动要有理由，不许静默）；
      // ④ 按平台格式导出 TXT：回执要点名平台，且**盘上文件的章头必须等于 UI 展示的那条样例**
      //    ——UI 与磁盘不许有第二个结论。
      await tab('规则');
      await tab('导出与自查'); // 强制重挂载：不继承上一轮的格式 / 平台选中态
      const chips = await waitFor(() => {
        const c = [...document.querySelectorAll('.export-platforms .chip')];
        return c.length >= 2 ? c : null;
      }, 20000);
      if (chips === null) {
        const empty = String((document.querySelector('.export-platforms-empty') || {}).textContent || '').trim();
        return { ok: empty.length > 0, note: '本机没有平台包（如实跳过，不给结论）：' + (empty || pageText()).slice(0, 120) };
      }
      const labels = chips.map((c) => String(c.textContent).trim());
      const noneFirst = labels[0] === '不按平台';
      const packButtons = chips.slice(1);
      const disabledOnes = packButtons.filter((c) => c.disabled === true);
      const disabledHaveReason = disabledOnes.every((c) => String(c.title).length > 6);
      const target = packButtons.find((c) => c.disabled === false);
      if (target === undefined) return { ok: false, note: '平台包全不可用：' + labels.join('/') };
      const picked = String(target.textContent).trim();
      target.click();
      const panel = await waitFor(() => document.querySelector('.export-platform-panel'), 20000);
      if (panel === null) return { ok: false, note: '选了 ' + picked + ' 但没长出平台面板' };
      const samples = [...panel.querySelectorAll('.export-platform-samples tbody tr')].map((tr) => ({
        title: String(tr.children[1].textContent).trim(),
        head: String(tr.children[2].textContent).trim(),
      }));
      const DUPLICATED = /第[0-9一二三四五六七八九十百千]+[章节回]\s*第[0-9一二三四五六七八九十百千]+[章节回]/;
      const noDup = samples.length > 0 && samples.every((s) => s.head.length > 0 && !DUPLICATED.test(s.head));
      const rowNodes = [...panel.querySelectorAll('.export-platform-rows tbody tr')];
      const severities = rowNodes.map((tr) => String(tr.children[0].textContent).trim());
      const severityOk = severities.every((s) => ['错误', '警告', '提示'].indexOf(s) >= 0);
      const meta = String(panel.textContent).replace(/\s+/g, ' ');
      const metaOk = meta.indexOf('生效') >= 0 && meta.indexOf('核对于') >= 0 && meta.indexOf('来源') >= 0;
      // 等确认框可勾再勾：换平台会触发一次重新核对，期间它是 disabled（v188 的那次抖动就出在这里）
      const chk = await waitFor(() => {
        const c = document.querySelector('.confirm-check input[type=checkbox]');
        return c !== null && c.disabled === false ? c : null;
      }, 20000);
      if (chk === null) return { ok: false, note: '确认框一直不可勾：' + pageText().slice(0, 160) };
      if (!chk.checked) chk.click();
      await sleep(160);
      const go = [...document.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('确认导出') >= 0);
      if (go && !go.disabled) go.click();
      const notice = await waitFor(() => {
        const t = String(document.body.innerText);
        const hit = t.split('\n').find((line) => line.indexOf('已导出 TXT') >= 0 && line.indexOf('平台格式') >= 0);
        return hit === undefined ? null : String(hit);
      }, 40000);
      const errBar = document.querySelector('.error-bar');
      const failText = errBar === null ? '' : String(errBar.textContent).replace(/\s+/g, ' ').slice(0, 200);
      let diskOk = false;
      let diskNote = '没有回执，未读盘';
      if (notice !== null && samples.length > 0) {
        const pathMatch = /→ (\S+?\.txt)/.exec(notice);
        if (pathMatch === null) {
          diskNote = '回执里抠不出路径：' + notice.slice(0, 120);
        } else {
          const doc = await window.yushu.doc.read(pathMatch[1]).catch(() => null);
          if (doc === null) {
            diskNote = '读不到 ' + pathMatch[1];
          } else {
            diskOk = String(doc.content).indexOf(samples[0].head) >= 0;
            diskNote = '盘上章头等于样例=' + diskOk + '（' + samples[0].head + '）';
          }
        }
      }
      panel.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: noneFirst && disabledHaveReason && noDup && severityOk && metaOk && notice !== null && diskOk,
        note: '平台包=' + picked + '；清单首项不按平台=' + noneFirst +
          '；坏包带原因=' + disabledHaveReason + '（disabled ' + disabledOnes.length + ' 个）' +
          '；样例 ' + samples.length + ' 条·无重复前缀=' + noDup +
          '；核对行=' + rowNodes.length + '·级别合法=' + severityOk +
          '；溯源齐=' + metaOk + '；回执带平台=' + (notice !== null) + '；' + diskNote +
          (failText === '' ? '' : '；错误条=' + failText),
      };
    `,
  },
  {
    step: 60,
    title: '记忆：冷启动待补与摘要目标同一个事实，点待补即选中目标（M5/T5-9，R95）',
    file: 'step60-memory-coldstart.png',
    body: String.raw`
      // T5-9 的验收点是"长篇导入后不至于开场失忆"。这一步只看**事实一致与衔接可用**：
      // ① 待补清单里的每一条都能在上方「摘要目标」里找到同名条目（两个面板不许有第二份事实）；
      // ② 点一条待补 ⇒ 上面就选中它（内容仍走既有「生成候选 → 采纳」，这里不生成任何东西）；
      // ③ 待补项的素材字数必须 > 0（空正文不进批次，没素材就不编摘要）；
      // ④ 覆盖率那一行必须给出数字或"无从计算"，不许留白。
      await tab('规则');
      await tab('记忆');
      const panel = await waitFor(() => document.querySelector('.memory-coldstart'), 20000);
      if (panel === null) return { ok: false, note: '没有冷启动面板：' + pageText().slice(0, 160) };
      const text = String(panel.textContent).replace(/\s+/g, ' ');
      const ratioOk = /覆盖率 (\d+%|无从计算)/.test(text);
      const batchLis = [...panel.querySelectorAll('.memory-coldstart-batch li')];
      const batchTitles = batchLis.map((li) => String((li.querySelector('strong') || {}).textContent || '').trim());
      const targetTitles = [...document.querySelectorAll('.memory-targets li strong')].map((el) => String(el.textContent).trim());
      const chars = batchLis.map((li) => {
        const m = /素材 (\d+) 字/.exec(String(li.textContent));
        return m === null ? -1 : Number(m[1]);
      });
      let allPresent = true;
      let clickOk = false;
      let clicked = '(批次为空)';
      let before = '';
      if (batchLis.length > 0) {
        allPresent = batchTitles.every((title) => targetTitles.indexOf(title) >= 0);
        const charsOk = chars.every((n) => n > 0);
        if (!charsOk) allPresent = false;
        // 必须点一条"当前还没被选中"的待补项：点已选中的那条，处理器是空的也会绿
        // （M6 变异就是这么活下来的——选择态是上一步留下的，不是本步点出来的）
        before = String((document.querySelector('.memory-targets li.on strong') || {}).textContent || '').trim();
        const candidate = batchLis.find((li) => {
          const title = String((li.querySelector('strong') || {}).textContent || '').trim();
          return title !== '' && title !== before;
        });
        if (candidate === undefined) {
          clickOk = false;
          clicked = '(待补里没有与当前选中不同的条目，无法判定)';
        } else {
          clicked = String((candidate.querySelector('strong') || {}).textContent || '').trim();
          const candidateBtn = candidate.querySelector('button');
          if (candidateBtn === null) {
            clickOk = false;
            clicked = '(待补项里没有 button，键盘不可达：' + clicked + ')';
          } else {
            candidateBtn.click();
          }
          await sleep(220);
          const after = String((document.querySelector('.memory-targets li.on strong') || {}).textContent || '').trim();
          clickOk = after === clicked && before !== clicked;
        }
      }
      const emptyOk = batchLis.length === 0 ? /没有待补目标/.test(text) : true;
      panel.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: ratioOk && allPresent && clickOk && emptyOk,
        note: '覆盖率行有结论=' + ratioOk + '；待补 ' + batchLis.length + ' 条与目标表同名=' + allPresent +
          '；点待补把选中从「' + before + '」挪到=' + clickOk + '（' + clicked + '）；空批次如实说明=' + emptyOk +
          '；空素材未列入=' + (chars.filter((n) => n <= 0).length === 0),
      };
    `,
  },
  {
    step: 61,
    title: '设定集：目录按层级编排、脱敏真的不写字、面板与产物同一份结论（M5/T5-5，R98）',
    file: 'step61-world-bible.png',
    body: String.raw`
      // T5-5 的验收点不是"页面上有个面板"，而是这四件事能对上：
      // ① 条目数来自真卡（一张卡都没有就如实给不出结论）；
      // ② 未揭示条目在**不开脱敏**时逐条点名（warn 行必须存在——上游建的卡默认是 hidden）；
      // ③ 勾上脱敏后：屏幕上的预览里那些名字必须消失，且"少掉的条数"等于脱敏清单点名的条数（面板自洽）；
      // ④ 落笔那一次与面板同一份结论：产物第一行等于面板那个标题，三级标题（###）数等于面板条目数，
      //    回执报的条目 / 略过 / 未揭示三个数与文件里数出来的对上，不留第二个结论。
      // 分支（两条都真跑，不挑好看的）：若项目里的卡全是未揭示，开脱敏后条目数为 0——
      // 这时先当场验"导出按钮不可点"（空设定集不许落盘），再退回不脱敏导出，
      // 并要求那些名字**确实出现在产物里**、回执点名泄露数 > 0。
      await tab('规则');
      await tab('导出与自查');
      const panel = await waitFor(() => document.querySelector('.bible-panel'), 20000);
      if (panel === null) return { ok: false, note: '没有设定集面板：' + pageText().slice(0, 160) };
      if ((await waitFor(() => panel.querySelector('.bible-summary'), 30000)) === null) {
        return { ok: false, note: '预览没回来（没有摘要行）' };
      }
      const read = () => {
        const n = panel.querySelector('.bible-included');
        return n === null ? -1 : Number(String(n.textContent).trim());
      };
      const clip = () => {
        const n = panel.querySelector('.clip-preview');
        return n === null ? '' : String(n.textContent);
      };
      const title = String((panel.querySelector('.bible-title') || {}).textContent || '').trim();
      const sectionRows = [...panel.querySelectorAll('.bible-toc tbody tr')];
      const leakRows = [...panel.querySelectorAll('.bible-leaks tbody tr')].length;
      const m0 = read();
      if (m0 <= 0) return { ok: false, note: '默认选取下条目数=' + m0 + '（项目里没有设定卡，本步给不出结论）' };
      if (title === '') return { ok: false, note: '面板标题是空的' };
      if (leakRows === 0) return { ok: false, note: '未开脱敏却一条 warn 都没有（不该发生）：条目 ' + m0 };
      const maskBox = panel.querySelector('.bible-mask input[type=checkbox]');
      if (maskBox === null) return { ok: false, note: '没有脱敏开关' };
      if (!maskBox.checked) maskBox.click();
      const maskedRows = await waitFor(() => {
        const rows = [...panel.querySelectorAll('.bible-masked tbody tr')];
        return rows.length > 0 ? rows : null;
      }, 30000);
      if (maskedRows === null) return { ok: false, note: '勾了脱敏但没有脱敏清单：条目 ' + read() };
      const maskedNames = maskedRows.map((tr) => String(tr.children[0].textContent).trim()).filter((x) => x !== '');
      const m1 = read();
      const selfConsistent = m1 === m0 - maskedNames.length;
      const clipAfter = clip();
      const truncated = clipAfter.indexOf('预览截断') >= 0;
      const goneFromClip = truncated ? true : maskedNames.every((n) => clipAfter.indexOf(n) < 0);
      const goBtn = () => [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('导出设定集') >= 0);
      let emptyBlocked = true;
      if (m1 === 0) {
        const btn = goBtn();
        emptyBlocked = btn !== undefined && btn.disabled === true;
      }
      const withMask = m1 > 0;
      if (!withMask) {
        maskBox.click();
        await waitFor(() => (read() === m0 ? read() : null), 30000);
      }
      const chk = await waitFor(() => {
        const c = panel.querySelector('.confirm-check input[type=checkbox]');
        return c !== null && c.disabled === false ? c : null;
      }, 30000);
      if (chk === null) {
        return { ok: false, note: '确认框一直不可勾（脱敏后=' + m1 + '，回落读到=' + read() + '）：' + pageText().slice(0, 120) };
      }
      if (!chk.checked) chk.click();
      await sleep(160);
      const go = goBtn();
      if (go === undefined || go.disabled) return { ok: false, note: '导出设定集按钮不可点' };
      go.click();
      const receipt = await waitFor(() => {
        const n = panel.querySelector('.bible-receipt');
        return n === null ? null : String(n.textContent).replace(/\s+/g, ' ');
      }, 40000);
      if (receipt === null) {
        const err = document.querySelector('.error-bar');
        return { ok: false, note: '没有回执' + (err === null ? '' : '：' + String(err.textContent).slice(0, 160)) };
      }
      const pathMatch = /→ (\S+?\.md)/.exec(receipt);
      if (pathMatch === null) return { ok: false, note: '回执里抠不出路径：' + receipt.slice(0, 140) };
      const doc = await window.yushu.doc.read(pathMatch[1]).catch(() => null);
      if (doc === null) return { ok: false, note: '读不到 ' + pathMatch[1] };
      const text = String(doc.content);
      const firstLine = text.split(String.fromCharCode(10))[0].trim();
      const titleOk = firstLine === '# ' + title;
      const headingCount = (text.match(/^### /gm) || []).length;
      const expectCount = withMask ? m1 : m0;
      const countOk = headingCount === expectCount;
      const stillIn = maskedNames.filter((n) => text.indexOf(n) >= 0);
      const contentOk = withMask ? stillIn.length === 0 : stillIn.length === maskedNames.length;
      const sectionOk = sectionRows.length > 0 && text.indexOf('## ') >= 0;
      // 字符串里的正则：写两条反斜杠，求值后才剩 \d
      const num = (label) => {
        const m = new RegExp(label + ' (\\d+) 条').exec(receipt);
        return m === null ? -1 : Number(m[1]);
      };
      const receiptIncluded = /(\d+) 条 ·/.test(receipt) ? Number(/(\d+) 条 ·/.exec(receipt)[1]) : -1;
      const receiptMasked = num('略过');
      const receiptLeaks = num('未揭示仍在产物');
      const receiptOk = receiptIncluded === expectCount &&
        receiptMasked === (withMask ? maskedNames.length : 0) &&
        (withMask ? receiptLeaks === 0 : receiptLeaks === leakRows);
      panel.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: titleOk && selfConsistent && goneFromClip && emptyBlocked && countOk && sectionOk && contentOk && receiptOk,
        note: '标题同源=' + titleOk + '（' + firstLine + '）；层级节=' + sectionRows.length + '；未开脱敏点名=' +
          leakRows + ' 条；开脱敏 ' + m0 + '→' + m1 + '（剔除 ' + maskedNames.length + ' 条，自洽=' + selfConsistent +
          '，预览不再出现=' + goneFromClip + (truncated ? '·预览截断未判' : '') + '）；空设定集不可导=' + emptyBlocked +
          '；落笔用' + (withMask ? '脱敏' : '不脱敏（全是未揭示设定）') + '；产物 ###=' + headingCount + '/' + expectCount +
          '；脱敏名出现在产物=' + stillIn.length + '；回执=' + receipt.slice(0, 130),
      };
    `,
  },  {
    step: 62,
    title: '迁移包导出：交给别人的那份没有密钥、也没有派生物；界面数字与盘上文件对账（M3/T3-14 后半，R101）',
    file: 'step62-project-bundle.png',
    fixture: 'export-dir',
    body: String.raw`
      // T3-14 后半的验收点是"导出的那份干净"。这一步只管屏幕上四件事，
      // 盘上的账由夹具的 check() 独立核（清单声明的真源数 + 清单自身 == 实到文件数，且包里不许出现 .yushu / secrets.json）：
      // ① 没选导出位置之前，确认框必须**不可勾**（防手滑，也防"勾完了才发现没地方写"）；
      // ② 点了选目录（对话框被换成临时目录）⇒ 按钮变成"已选：xxx"，确认框随之可勾——这两条都必须是这一步点出来的**变化**；
      // ③ 回执里的文件数 == 预览报的真源数 + 1（+1 是 MANIFEST 自己），两个口径必须能互相算平；
      // ④ 回执里"复扫命中 N 条"必须为 0——不是"没写这行"，是写了且为 0。
      await tab('规则');
      await tab('导出与自查');
      const panel = await waitFor(() => document.querySelector('.project-export-panel'), 20000);
      if (panel === null) return { ok: false, note: '没有迁移包面板：' + pageText().slice(0, 160) };
      const summary = await waitFor(() => panel.querySelector('.export-summary'), 30000);
      if (summary === null) return { ok: false, note: '清点没回来（没有摘要行）' };
      const summaryText = String(summary.textContent).replace(/\s+/g, ' ');
      const declared = /(\d+) 个真源文件/.exec(summaryText);
      if (declared === null) return { ok: false, note: '抠不出真源文件数：' + summaryText.slice(0, 140) };
      const early = panel.querySelector('.confirm-check input[type=checkbox]');
      const blockedBefore = early !== null && early.disabled === true;
      const pick = [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('选择导出位置') >= 0);
      if (pick === undefined) return { ok: false, note: '没有"选择导出位置"按钮（可能上一轮残留了选中态）' };
      pick.click();
      const pickedLabel = await waitFor(() => {
        const b = [...panel.querySelectorAll('button')].find((x) => String(x.textContent).indexOf('已选：') >= 0);
        return b === undefined ? null : String(b.textContent).replace(/\s+/g, ' ');
      }, 20000);
      if (pickedLabel === null) return { ok: false, note: '点了选目录但按钮没变成「已选」（对话框桩或票据通道没通）' };
      const chk = await waitFor(() => {
        const c = panel.querySelector('.confirm-check input[type=checkbox]');
        return c !== null && c.disabled === false ? c : null;
      }, 20000);
      if (chk === null) {
        return { ok: false, note: '选了目录但确认框仍不可勾：' + String(pickedLabel) };
      }
      if (!chk.checked) chk.click();
      await sleep(160);
      const go = [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('导出迁移包') >= 0);
      if (go === undefined || go.disabled) return { ok: false, note: '导出迁移包按钮不可点' };
      go.click();
      const receipt = await waitFor(() => {
        const r = panel.querySelector('.project-export-receipt');
        return r === null ? null : String(r.textContent).replace(/\s+/g, ' ');
      }, 60000);
      if (receipt === null) {
        const err = document.querySelector('.error-bar');
        return { ok: false, note: '没有回执' + (err === null ? '' : '：' + String(err.textContent).slice(0, 160)) };
      }
      const written = /（(\d+) 个文件/.exec(receipt);
      const residue = /复扫命中 (\d+) 条/.exec(receipt);
      const redacted = /剥离明文密钥 (\d+) 处/.exec(receipt);
      const countOk = written !== null && Number(written[1]) === Number(declared[1]) + 1;
      const scanOk = residue !== null && Number(residue[1]) === 0;
      const ok = blockedBefore && pickedLabel !== null && countOk && scanOk;
      panel.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok,
        note: '未选目录时不可勾=' + blockedBefore + '；' + String(pickedLabel) +
          '；真源=' + declared[1] + ' → 写出=' + (written === null ? '?' : written[1]) + '（含 MANIFEST，对平=' + countOk + '）' +
          '；剥离明文=' + (redacted === null ? '?' : redacted[1]) + ' 处；复扫命中=' + (residue === null ? '?' : residue[1]) + ' 条',
      };
    `,
  },  {
    step: 63,
    title: '视角看板：没声明就不判、策略当场生效、绑视角少一条结论、并进全书体检（M4/T4-2 第三批，R102）',
    file: 'step63-pov-board.png',
    body: String.raw`
      // T4-2 第三批的验收点不是"页面上有个面板"，而是这四件事在屏幕上真的接上了：
      // ① 没写策略时引擎那句原话必须在（「没有结论不等于没有问题」），面板不许把它显示成"暂无结论"；
      // ② 在文本框里改策略 ⇒ 保存按钮从**不可点**变可点（这必须是本步点出来的变化，不是既有状态），
      //    点保存后策略摘要与逐章结论同屏出现；
      // ③ 下拉换到某个真实角色 ⇒ 那条「本章未声明视角」当场少一条（写入点不是摆设）；
      // ④ 点「全书体检」后，视角结论出现在那张总表里（出处列点名视角核对）——
      //    并进总表才谈得上豁免与豁免率，只在面板里自说自话的结论豁不掉。
      // 顺序：④ 放在 ③ 之前，因为绑掉最后一章就没有可并进的结论了（那是"判干净了"，不是本步要证的）。
      await tab('规则');
      const panel = await waitFor(() => document.querySelector('.pov-panel'), 20000);
      if (panel === null) return { ok: false, note: '没有视角看板面板：' + pageText().slice(0, 160) };
      const text = (sel) => String((panel.querySelector(sel) || {}).textContent || '').replace(/\s+/g, ' ');
      const stateLine = await waitFor(() => {
        const n = panel.querySelector('.pov-state');
        return n === null ? null : String(n.textContent).replace(/\s+/g, ' ');
      }, 30000);
      if (stateLine === null) return { ok: false, note: '没有状态行（未声明/读不了都没显示）：' + pageText().slice(0, 160) };
      const honestEmpty = stateLine.indexOf('不等于') >= 0;
      const countedBefore = text('.pov-counted');
      if (countedBefore.indexOf('未建草稿') < 0) return { ok: false, note: '计数行没点名未建草稿的章：' + countedBefore };
      const findingsRows = () => panel.querySelectorAll('.pov-findings tbody tr').length;
      const saveBtn = () => [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('保存策略') >= 0);
      const btn0 = saveBtn();
      if (btn0 === undefined) return { ok: false, note: '没有「保存策略」按钮' };
      const disabledBefore = btn0.disabled === true;
      const box = panel.querySelector('.pov-config');
      if (box === null) return { ok: false, note: '没有策略输入框' };
      const NL = String.fromCharCode(10);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set;
      setter.call(box, 'mode: third_limited' + NL + 'distance: 贴近' + NL);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const enabledAfter = await waitFor(() => (saveBtn() !== undefined && saveBtn().disabled === false ? true : null), 15000);
      if (enabledAfter === null) return { ok: false, note: '改了策略但保存按钮仍不可点（dirty 判定没接上）' };
      saveBtn().click();
      const strategy = await waitFor(() => (panel.querySelector('.pov-strategy') === null ? null : text('.pov-strategy')), 30000);
      if (strategy === null) return { ok: false, note: '保存后没出现策略摘要（回执错误：' + text('.error-text') + '）' };
      const modeOk = strategy.indexOf('third_limited') >= 0;
      const rowsAfterSave = findingsRows();
      if (rowsAfterSave === 0) return { ok: false, note: '已声明三限模式却零结论——项目里没有已建草稿的章？计数=' + text('.pov-counted') };
      document.querySelector('.consistency-manual').click();
      const merged = await waitFor(() => {
        const rows = [...document.querySelectorAll('.consistency-table tbody tr')];
        return rows.some((tr) => String(tr.textContent).indexOf('pov-missing') >= 0 &&
          String(tr.textContent).indexOf('视角策略核对') >= 0) ? rows.filter((tr) => String(tr.textContent).indexOf('pov-missing') >= 0).length : null;
      }, 60000);
      const mergeOk = merged !== null;
      const firstSel = panel.querySelector('.pov-chapters tbody tr .pov-bind');
      if (firstSel === null) return { ok: false, note: '章节表里没有视角下拉' };
      const opts = [...firstSel.querySelectorAll('option')].filter((o) => String(o.value) !== '');
      if (opts.length === 0) return { ok: false, note: '下拉里没有角色候选（项目里没有角色卡）' };
      const pick = String(opts[0].value);
      const selSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(firstSel), 'value').set;
      selSetter.call(firstSel, pick);
      firstSel.dispatchEvent(new Event('change', { bubbles: true }));
      const dropped = await waitFor(() => (findingsRows() === rowsAfterSave - 1 ? findingsRows() : null), 30000);
      const bindOk = dropped !== null;
      const receipt = text('.pov-receipt');
      const receiptOk = receipt.indexOf(pick) >= 0;
      panel.scrollIntoView({ block: 'start' });
      await sleep(240);
      return {
        ok: honestEmpty && disabledBefore && modeOk && mergeOk && bindOk && receiptOk,
        note: '未声明原话=' + honestEmpty + '（' + stateLine.slice(0, 40) + '…）；保存按钮 禁用→可点=' + (disabledBefore && enabledAfter !== null) +
          '；策略摘要 mode=' + modeOk + '；并进全书体检的视角结论=' + (mergeOk ? merged : 0) + ' 条；绑「' + pick +
          '」前 ' + rowsAfterSave + ' 条 → 后 ' + (bindOk ? dropped : '?') + ' 条=' + bindOk + '；回执点名=' + receiptOk,
      };
    `,
  },  {
    step: 64,
    title: '信息可见性：档案页登记来源章节 → 全书体检当场多出该条结论，清掉登记后又当场消失（M4/T4-2 第四批，R103）',
    file: 'step64-visibility-check.png',
    body: String.raw`
      // 这一步要证的是"写入点 → 判定 → 同表"整条链，而且**两个方向都要动**：
      // ① 挑一张可见性 hidden、且当前没登记任何来源章节的卡（从盘上真源判，不猜夹具形状）；
      // ② 在「世界观档案」把某章 id 填进「来源章节」并保存 ⇒ 盘上必须真有这一行；
      // ③ 点「全书体检」⇒ 表里必须新增 vis-hidden-but-sourced 且主体是这张卡、出处写着"信息可见性核对"
      //    （并进总表才谈得上豁免与豁免率）；
      // ④ **把那行登记清掉再体检一次 ⇒ 该条必须消失**。方向 ④ 是这一步真正的牙：
      //    读到旧表也会"有该行"，只有真的按当下数据重判才会"消失"——单靠 ③ 分不清新表与旧表。
      // 收尾再登记一次并把那一行滚进视口：截图要拍在被断言的那一段（R58 的截图纪律），
      // 这条登记是合法的作者动作，本步是末步，保留它不回滚。
      await tab('世界观档案');
      const archive = await waitFor(() => document.querySelector('.archive'), 20000);
      if (archive === null) return { ok: false, note: '没有档案页：' + pageText().slice(0, 140) };
      const cards = await window.yushu.card.list();
      let target = null;
      for (const item of cards || []) {
        if (!item.id || item.visibility !== 'hidden' || item.error) continue;
        const raw = await window.yushu.doc.read(item.path).catch(() => null);
        if (raw === null) continue;
        const line = /^source_chapters:\s*(.*)$/m.exec(String(raw.content));
        const filled = line !== null && line[1].trim() !== '' && line[1].trim() !== '[]';
        if (!filled) { target = item; break; }
      }
      if (target === null) return { ok: false, note: '找不到"hidden 且未登记来源章节"的卡，本步无从验证' };
      const library = await window.yushu.library.list();
      const drafted = (library.chapters || []).find((c) => c.chapterPath);
      if (!drafted) return { ok: false, note: '项目里没有已建草稿的章，没有章 id 可登记' };
      const matched = /\/(ch-[^/]+)\.md$/.exec(drafted.chapterPath);
      if (matched === null) return { ok: false, note: '章节路径抠不出章 id：' + drafted.chapterPath };
      const chapterId = matched[1];
      const row = [...archive.querySelectorAll('li')].find((li) => String(li.textContent).indexOf(target.id) >= 0);
      if (!row) return { ok: false, note: '列表里找不到那张卡：' + target.id };
      // R110 之后清单行的可点目标是**行内的真按钮**（按钮铺满整行 ⇒ 真人点哪儿都一样，
    // 但程序化点 <li> 不会触发按钮的处理器 ⇒ 这里要点按钮本身）
    (row.querySelector('button') ?? row).click();
      // 载入是异步的（card:read → setDoc）：在旧 doc 上改值会被随后到达的载入结果整片盖掉，
      // 更糟的是"保存"会写给**上一张还开着的卡**（v217/v218 实测：界面回"已保存"、目标卡盘上却没有那一行）。
      // 所以先等编辑区的面板标题真的换成这张卡的路径（.panel-title 在侧栏也有一个，必须限定在 .editor 里）。
      const loadedInto = async (pathText) => await waitFor(() => {
        const t = document.querySelector('.editor .panel-title .muted');
        return t && String(t.textContent).indexOf(pathText) >= 0 ? true : null;
      }, 20000);
      if ((await loadedInto(target.path)) === null) return { ok: false, note: '档案页没有载入这张卡：' + target.path };
      const box = await waitFor(() => document.querySelector('.card-source-chapters'), 20000);
      if (box === null) return { ok: false, note: '档案页没有「来源章节」输入框（写入点没接上）' };
      if (String(box.value).trim() !== '') return { ok: false, note: '挑中的卡已经登记了来源章节：' + box.value };
      await sleep(200);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set;
      const saveCard = async (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // React 的 onChange → setState 是异步的：同一拍里点保存会拿到**旧 state**（v217 实测：
        // 界面回执"已保存"、盘上却没有那一行）。先等一帧让状态落定，再点保存。
        await sleep(160);
        const btn = [...document.querySelectorAll('.editor-foot button')].find((b) => String(b.textContent).indexOf('保存') >= 0);
        if (!btn) return false;
        btn.click();
        return await waitFor(() => {
          const out = document.querySelector('.editor-foot .muted');
          return out && String(out.textContent).indexOf('已保存') >= 0 ? true : null;
        }, 20000) !== null;
      };
      setter.call(box, chapterId);
      const savedOn = await saveCard(box);
      const disk = await window.yushu.doc.read(target.path);
      const diskOk = disk !== null && String(disk.content).indexOf(chapterId) >= 0;
      await tab('规则');
      const keyOf = (tr) => String((tr.querySelectorAll('td')[1] || {}).textContent || '').trim() + ':' +
        String((tr.querySelectorAll('td')[2] || {}).textContent || '').trim().split(' ')[0];
      const expect = 'vis-hidden-but-sourced:' + target.id;
      const tableHas = () => [...document.querySelectorAll('.consistency-table tbody tr')].some((tr) => keyOf(tr) === expect);
      const manualBtn = document.querySelector('.consistency-manual');
      if (!manualBtn) return { ok: false, note: '没有全书体检按钮' };
      manualBtn.click();
      const appeared = await waitFor(() => (tableHas() ? true : null), 40000);
      const originRow = [...document.querySelectorAll('.consistency-table tbody tr')].find((tr) => keyOf(tr) === expect);
      const originText = originRow ? String([...originRow.querySelectorAll('td')][5]?.textContent || '').trim() : '';
      const originOk = originText.indexOf('信息可见性核对') >= 0;
      if (originRow) originRow.scrollIntoView({ block: 'center' });
      await sleep(240);
      // 反向：清掉登记 → 恢复原状，并验那条结论跟着消失（旧表分不清，只有重判才会消失）
      await tab('世界观档案');
      // 换标签页会卸载档案页组件，卡得重新点开——否则输入框根本不在 DOM 里
      const archive2 = await waitFor(() => document.querySelector('.archive'), 20000);
      if (archive2 === null) return { ok: false, note: '回到档案页失败' };
      const row2 = [...archive2.querySelectorAll('li')].find((li) => String(li.textContent).indexOf(target.id) >= 0);
      if (!row2) return { ok: false, note: '回来后列表里找不到那张卡：' + target.id };
      (row2.querySelector('button') ?? row2).click();
      if ((await loadedInto(target.path)) === null) return { ok: false, note: '回来后没载入这张卡' };
      const box2 = await waitFor(() => document.querySelector('.card-source-chapters'), 20000);
      if (box2 === null) return { ok: false, note: '回来后没有来源章节输入框' };
      await sleep(200);
      setter.call(box2, '');
      const cleared = await saveCard(box2);
      await tab('规则');
      document.querySelector('.consistency-manual').click();
      const gone = await waitFor(() => (tableHas() ? null : true), 40000);
      const diskBack = await window.yushu.doc.read(target.path);
      const restored = diskBack !== null && String(diskBack.content).indexOf(chapterId) < 0;
      // 收尾再登记一次并把那一行滚进视口（R58 的截图纪律：证据要拍在被断言的那一段，
      // 只拍到页首的"表里没有"不算证据）。这条登记是合法的作者动作，末步保留它、不再回滚。
      await tab('世界观档案');
      const archive3 = await waitFor(() => document.querySelector('.archive'), 20000);
      const row3 = archive3 === null ? null : [...archive3.querySelectorAll('li')].find((li) => String(li.textContent).indexOf(target.id) >= 0);
      if (!row3) return { ok: false, note: '第三次回不到那张卡' };
      (row3.querySelector('button') ?? row3).click();
      if ((await loadedInto(target.path)) === null) return { ok: false, note: '第三次没载入这张卡' };
      const box3 = await waitFor(() => document.querySelector('.card-source-chapters'), 20000);
      if (box3 === null) return { ok: false, note: '第三次没有输入框' };
      await sleep(200);
      setter.call(box3, chapterId);
      const reRegistered = await saveCard(box3);
      await tab('规则');
      document.querySelector('.consistency-manual').click();
      const finalRow = await waitFor(() => [...document.querySelectorAll('.consistency-table tbody tr')]
        .find((tr) => keyOf(tr) === expect) || null, 40000);
      if (finalRow) finalRow.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: savedOn && diskOk && appeared !== null && originOk && cleared && gone !== null && restored && reRegistered && !!finalRow,
        note: '登记 ' + chapterId + ' → ' + target.id + '：保存=' + savedOn + '；盘上生效=' + diskOk +
          '；体检表新增该条=' + (appeared !== null) + '；出处=' + (originOk ? originText : '(未找到该行)') +
          '；清空=' + cleared + '；再体检后该条消失=' + (gone !== null) + '；盘上恢复原状=' + restored +
          '；第三次重新登记并回到该行=' + (reRegistered && !!finalRow),
      };
    `,
  },
  {
    step: 65,
    title: '黄金三章：章纲七要素填满 → 全书体检少一条，清掉一项 → 又多回来（M4/T4-2 第五批·第一段，R104）',
    file: 'step65-opening-brief.png',
    body: String.raw`
      // 这一步要证「黄金三章」那条链在界面上是通的，而且**两个方向都动**：
      // ① 判据回源 F02 §5（章纲七要素）与 F11 §3（开局窗口逐章必填，缺项黄牌）：
      //    开局窗口（默认前三章）里章纲七要素缺项 ⇒ 报 open-brief-incomplete（info，结论落在章纲条目上）。
      //    「新设定名词 ≤3」不在本步——那条由 R103 的 vis-first-appearance-overload 同阈值负责，
      //    同一件事发两个 id 会让作者在表里看见两行同样的话（引擎侧同一个理由）。
      // ② 「填满 → 体检表少一条」证明这条结论**跟着真源走**，不是一张静态表；
      // ③ 「清掉一项 → 又多回来」是**反向的牙**：只验"少一条"分不清"表没刷新"与"真判没了"，
      //    两边都动才排得掉"读到旧表"这种最体面的假绿灯（与 step64 同一条纪律）。
      // 真源一律从盘上读（章纲条目的 id、标题、七项当前值），不猜夹具形状、不信界面数字。
      const LABELS = ['谁', '在哪', '目标', '阻碍', '转折', '结果', '钩子'];
      const yaml = String((await window.yushu.doc.read('outline/outline.yaml')).content);
      const coMatch = /- id: (co-[a-z0-9]+)[\s\S]{0,200}?title: ([^\n]*)/.exec(yaml);
      if (coMatch === null) return { ok: false, note: '盘上大纲里抠不出第一个章纲条目' };
      const coId = coMatch[1];
      const chapTitle = String(coMatch[2]).trim();
      const blockOf = (text) => {
        const m = new RegExp('- id: ' + coId + '\\n([\\s\\S]*?)(?=\\n[ \\t]*- id: |$)').exec(text);
        return m === null ? '' : m[1];
      };
      const briefHook = (text) => {
        const block = blockOf(text);
        const idx = block.indexOf('brief:');
        if (idx < 0) return '(没有 brief 段)';
        const m = /^[ \t]*hook:[ \t]*(.*)$/m.exec(block.slice(idx + 6));
        return m === null ? '(抠不到 hook)' : String(m[1]).trim().replace(/^"|"$/g, '');
      };
      // 界面：把第 1 章的细纲七项按 values 填一遍并保存大纲（values 里没给的键清空）
      const setBrief = async (values) => {
        await tab('三级大纲');
        const volLi = await waitFor(() => document.querySelector('.volume-list li'), 20000);
        if (!volLi) return '没有卷列表';
        volLi.click();
        await sleep(320);
        const chapLi = await waitFor(() => {
          // 章纲标题渲染在 <input class="chapter-title"> 里（受控输入），**不在 textContent 里**
          // ——v224 实撞：按 textContent 找标题永远找不到（读的是 input 的 value）。
          const hit = [...document.querySelectorAll('.chapter-list li')].find((li) => {
            const input = li.querySelector('input.chapter-title');
            return input !== null && String(input.value) === chapTitle;
          });
          return hit || null;
        }, 20000);
        if (!chapLi) return '列表里找不到章纲：' + chapTitle;
        const toggle = [...chapLi.querySelectorAll('button')].find((b) => {
          const t = String(b.textContent);
          return t.indexOf('细纲') >= 0 || t.indexOf('收起细纲') >= 0;
        });
        if (!toggle) return '章纲没有「细纲」按钮';
        if (String(toggle.textContent).indexOf('收起细纲') < 0) {
          toggle.click();
          await sleep(300);
        }
        const fields = [...chapLi.querySelectorAll('.brief-grid .field')];
        if (fields.length === 0) return '细纲里没有输入框';
        const byLabel = new Map();
        for (const field of fields) {
          const label = String((field.querySelector('span') || {}).textContent || '').trim();
          const input = field.querySelector('input');
          if (label !== '' && input) byLabel.set(label, input);
        }
        for (const label of LABELS) {
          const input = byLabel.get(label);
          if (!input) return '细纲里没有「' + label + '」这一项';
          setV(input, values[label] === undefined ? '' : values[label]);
          await sleep(70);
        }
        await sleep(260);
        const saveBtn = [...document.querySelectorAll('.outline-foot button')].find((b) => String(b.textContent).indexOf('保存大纲') >= 0);
        if (!saveBtn) return '没有「保存大纲」按钮';
        if (saveBtn.disabled) return '「保存大纲」不可点（dirty 判定没接上）';
        saveBtn.click();
        const saved = await waitFor(() => {
          const outs = [...document.querySelectorAll('.outline-foot .muted')].map((el) => String(el.textContent || ''));
          return outs.some((t) => t.indexOf('大纲已保存') >= 0) ? true : null;
        }, 20000);
        if (saved === null) return '保存后没有回执：' + pageText().slice(0, 120);
        return 'ok';
      };
      // 全书体检：点一次重算（manual 时机必重算，不吃缓存），并**等到期待的那一行出现/消失**为止。
      // 连续两次体检的期待状态必须相反，等待才是真的"等到了新表"——否则读到的就是上一次的旧表。
      const audit = async (expectPresent) => {
        await tab('规则');
        const btn = await waitFor(() => document.querySelector('.consistency-manual'), 20000);
        if (!btn) return null;
        btn.click();
        let lastRows = [];
        const hit = await waitFor(() => {
          const rows = [...document.querySelectorAll('.consistency-table tbody tr')].map((tr) => {
            const tds = [...tr.querySelectorAll('td')];
            return {
              severity: String((tds[0] || {}).textContent || '').trim(),
              rule: String((tds[1] || {}).textContent || '').trim(),
              subject: String((tds[2] || {}).textContent || '').trim().split(' ')[0],
              origin: String((tds[5] || {}).textContent || '').trim(),
            };
          });
          lastRows = rows;
          // 空表不算"这条消失了"（空对空）：表还没渲染出来时是空的，那不是判定结果
          if (rows.length === 0) return null;
          const mine = rows.some((r) => r.rule === 'open-brief-incomplete' && r.subject === coId);
          return mine === expectPresent ? { rows } : null;
        }, 60000);
        const summary = [...document.querySelectorAll('.consistency-summary')].map((el) => String(el.textContent || '').replace(/\s+/g, ' ')).join('');
        return { rows: hit === null ? lastRows : hit.rows, summary, timedOut: hit === null };
      };
      const mineOf = (res) => res === null ? null : res.rows.find((r) => r.rule === 'open-brief-incomplete' && r.subject === coId);
      // ① 现状：夹具里第 1 章的章纲七要素是空的 ⇒ 体检表里应有这一条（主体 = 这一条章纲）
      const first = await audit(true);
      if (first === null) return { ok: false, note: '第一次体检没跑出表来' };
      const beforeRows = first.rows.filter((r) => r.rule === 'open-brief-incomplete').length;
      const firstMine = mineOf(first);
      if (firstMine === undefined) {
        return { ok: false, note: '体检表里没有这一章的 open-brief-incomplete（前提不成立：章纲七要素可能已被填满）：' + first.summary };
      }
      const originOk = String(firstMine.origin).indexOf('黄金三章核对') >= 0;
      const severityOk = firstMine.severity === 'info';
      // ② 修好：七项填满 ⇒ 这一条必须消失
      const filled = {};
      for (const label of LABELS) filled[label] = '预演·' + label;
      const fillResult = await setBrief(filled);
      if (fillResult !== 'ok') return { ok: false, note: '填满七项失败：' + fillResult };
      const afterFill = await audit(false);
      if (afterFill === null) return { ok: false, note: '填满后体检没跑出表来' };
      const goneWhenFilled = mineOf(afterFill) === undefined;
      const diskFilled = briefHook(String((await window.yushu.doc.read('outline/outline.yaml')).content));
      // ③ 反向：清掉「钩子」⇒ 这一条必须又回来（只验"少一条"分不清新表与旧表）
      const cleared = {};
      for (const label of LABELS) cleared[label] = '预演·' + label;
      cleared['钩子'] = '';
      const clearResult = await setBrief(cleared);
      if (clearResult !== 'ok') return { ok: false, note: '清空钩子失败：' + clearResult };
      const afterClear = await audit(true);
      if (afterClear === null) return { ok: false, note: '清空后体检没跑出表来' };
      const backWhenCleared = mineOf(afterClear) !== undefined;
      const diskCleared = briefHook(String((await window.yushu.doc.read('outline/outline.yaml')).content));
      // 收尾：把那一行滚进视口（R58 的截图纪律：证据要拍在被断言的那一段）
      const target = [...document.querySelectorAll('.consistency-table tbody tr')].find((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        return String((tds[1] || {}).textContent || '').trim() === 'open-brief-incomplete' &&
          String((tds[2] || {}).textContent || '').trim().split(' ')[0] === coId;
      });
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: originOk && severityOk && goneWhenFilled && backWhenCleared,
        note: '章纲 ' + coId + '（' + chapTitle + '）：体检表 open-brief-incomplete 共 ' + beforeRows +
          ' 条·这一条在场=true；级别=' + firstMine.severity + '；出处=' + (originOk ? firstMine.origin : '(未找到)') +
          '；填满七项→该条消失=' + goneWhenFilled + '（盘上 hook=' + diskFilled + '）' +
          '；清空钩子→该条又回来=' + backWhenCleared + '（盘上 hook=' + diskCleared + '）' +
          '；收尾状态=钩子空着（截图里这一行在场）',
      };
    `,
  },
  {
    step: 66,
    title: '注入门控：门控指向不存在的章 → 全书体检多出该条，改成真实章 → 该条消失（M4/T4-2 第五批·第二段，R104）',
    file: 'step66-gate-check.png',
    body: String.raw`
      // 这一步要证「注入门控」那条链在**全书体检表**里是通的，而且两个方向都动：
      // ① 判据回源 docs/03 §10.1（reveal_gate：早于该章不注入）与 J05/A08（防剧透）：
      //    门控指向一章**大纲里不存在**的章 ⇒ 注入计划按「门控无法解析 ⇒ 保守不注入」处理，
      //    于是这条内容在任何一章都不会进上下文，而记忆页上那行「门控 ch-xxx」看着像已经配好了。
      //    静默失效比报错更难发现 ⇒ 报 gate-chapter-unknown（warn，主体 = 那条事实）。
      // ② 改成大纲里真实存在的章 ⇒ 该条必须消失（证明不是"有门控就报"）。
      //
      // **为什么这一条只能从真源造**（当场查出来的，不是猜的）：
      //    记忆页的门控下拉（.memory-fact-gate）选项来自记忆层的章目标，
      //    而记忆层章目标与「大纲里已回填 chapter_id 的章序」**同源**
      //    （memory-ops.ts 的 targets 与 doc-readers.ts 的 outlineChapterOrder 都取自大纲）
      //    ⇒ 从界面选出来的门控**永远**是一条存在的章，界面上根本造不出悬空门控。
      //    所以本步用产品自己的写通道（window.yushu.doc.write → FileGateway，不是任何测试后门）
      //    造一条事实记录。记录不带 source ⇒ 记忆页会有一条「事实缺少出处」的 warn（如实说明，不藏）。
      const factPath = 'memory/facts/fact-walkthrough-gate.md';
      const factId = 'fact-walkthrough-gate';
      const badGate = 'ch-walkthrough-not-exists';
      const worldText = String((await window.yushu.doc.read('world/world.yaml')).content);
      const pidMatch = /^id:[ \t]*(\S+)/m.exec(worldText);
      if (pidMatch === null) return { ok: false, note: 'world.yaml 里抠不出项目 id' };
      const projectId = pidMatch[1];
      const outlineText = String((await window.yushu.doc.read('outline/outline.yaml')).content);
      const realMatch = /chapter_id:[ \t]*(ch-[a-z0-9]+)/.exec(outlineText);
      if (realMatch === null) return { ok: false, note: '大纲里没有已回填 chapter_id 的章（造不出"真实章"那一侧）' };
      const realChapter = realMatch[1];
      const factText = (gate) => [
        '---',
        'format_version: 1',
        'layer: fact',
        'id: ' + factId,
        'project_id: ' + projectId,
        'keys:',
        '  - 预演门控样本',
        'updated_at: 2026-10-20T00:00:00.000Z',
        'injection:',
        '  mode: trigger',
        '  priority: 50',
        '  position: near_end',
        '  budget_tokens: 400',
        '  reveal_gate: ' + gate,
        '---',
        '',
        '预演用事实：门控指向一章不存在的章，注入计划会保守地不注入它。',
        ''
      ].join('\n');
      // 幂等写：文件已存在（失败重试）时必须带 baseHash，否则写通道按设计拒写
      const writeFact = async (gate) => {
        const existing = await window.yushu.doc.read(factPath).catch(() => null);
        await window.yushu.doc.write(factPath, factText(gate), existing === null ? undefined : existing.hash);
        const back = await window.yushu.doc.read(factPath);
        return String(back.content).indexOf('reveal_gate: ' + gate) >= 0;
      };
      const audit = async (expectPresent) => {
        await tab('规则');
        const btn = await waitFor(() => document.querySelector('.consistency-manual'), 20000);
        if (!btn) return null;
        btn.click();
        let lastRows = [];
        const hit = await waitFor(() => {
          const rows = [...document.querySelectorAll('.consistency-table tbody tr')].map((tr) => {
            const tds = [...tr.querySelectorAll('td')];
            return {
              severity: String((tds[0] || {}).textContent || '').trim(),
              rule: String((tds[1] || {}).textContent || '').trim(),
              subject: String((tds[2] || {}).textContent || '').trim().split(' ')[0],
              origin: String((tds[5] || {}).textContent || '').trim(),
            };
          });
          lastRows = rows;
          // 空表不算"这条消失了"（空对空）：表还没渲染出来时是空的，那不是判定结果
          if (rows.length === 0) return null;
          const mine = rows.some((r) => r.rule === 'gate-chapter-unknown' && r.subject === factId);
          return mine === expectPresent ? { rows } : null;
        }, 60000);
        const summary = [...document.querySelectorAll('.consistency-summary')].map((el) => String(el.textContent || '').replace(/\s+/g, ' ')).join('');
        return { rows: hit === null ? lastRows : hit.rows, summary, timedOut: hit === null };
      };
      const mineOf = (res) => res === null ? null : res.rows.find((r) => r.rule === 'gate-chapter-unknown' && r.subject === factId);
      // ① 制造：门控指向不存在的章 ⇒ 该条必须出现
      const wroteBad = await writeFact(badGate);
      if (!wroteBad) return { ok: false, note: '事实记录没落成（盘上找不到 reveal_gate: ' + badGate + '）' };
      const afterBad = await audit(true);
      if (afterBad === null) return { ok: false, note: '第一次体检没跑出表来' };
      const badMine = mineOf(afterBad);
      if (badMine === undefined) {
        return { ok: false, note: '体检表里没有 gate-chapter-unknown（门控 ' + badGate + ' 应判悬空）：' + afterBad.summary };
      }
      const originOk = String(badMine.origin).indexOf('注入门控核对') >= 0;
      const severityOk = badMine.severity === 'warn';
      // ② 修好：门控改成大纲里真实存在的章 ⇒ 该条必须消失
      const wroteReal = await writeFact(realChapter);
      if (!wroteReal) return { ok: false, note: '事实记录没改成真实章门控' };
      const afterReal = await audit(false);
      if (afterReal === null) return { ok: false, note: '改完后体检没跑出表来' };
      const goneWhenFixed = mineOf(afterReal) === undefined;
      // ③ 收尾：把坏门控写回去，让这一行留在截图里（R58 的截图纪律；收尾状态在回执里写明）
      const wroteBack = await writeFact(badGate);
      if (!wroteBack) return { ok: false, note: '收尾没把坏门控写回去' };
      const afterBack = await audit(true);
      if (afterBack === null) return { ok: false, note: '收尾后体检没跑出表来' };
      const backAtEnd = mineOf(afterBack) !== undefined;
      const target = [...document.querySelectorAll('.consistency-table tbody tr')].find((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        return String((tds[1] || {}).textContent || '').trim() === 'gate-chapter-unknown' &&
          String((tds[2] || {}).textContent || '').trim().split(' ')[0] === factId;
      });
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: originOk && severityOk && goneWhenFixed && backAtEnd,
        note: '事实 ' + factId + ' 的门控 ' + badGate + '（大纲里没有这一章）→ 体检表新增该条=true；级别=' +
          badMine.severity + '；出处=' + (originOk ? badMine.origin : '(未找到)') +
          '；改成真实章 ' + realChapter + ' → 该条消失=' + goneWhenFixed +
          '；收尾写回坏门控后该条在场=' + backAtEnd +
          '（界面下拉只给大纲章序里的章 ⇒ 这条只能从真源造；本步走的是产品自己的 doc:write 通道）',
      };
    `,
  },
  {
    step: 67,
    title: '发布状态机：标记已发布 → 盘上状态变了且台账留痕，退回草稿 → 又变回去；定时到点进提醒队列（M5/T5-6，R105）',
    file: 'step67-publish-state.png',
    body: String.raw`
      // 这一步要证「发布状态机」在界面上是通的，而且**两个方向都动**：
      // ① 写入口：标记已发布 ⇒ **盘上**那章的 frontmatter status 真的变了（盘上核对，不信界面数字），
      //    且台账多了一条留痕（I01 §5「回退记录留痕」）；
      // ② 反向：退回草稿 ⇒ 盘上又变回 draft。只验"能改成已发布"分不清"真写了"与"界面骗人"；
      // ③ **非法迁移（草稿 → 修订中）按钮是禁用的**，理由来自引擎的迁移矩阵
      //    （渲染层不自己抄一份迁移表——抄一份就会漂移，漂出来的按钮点下去只会被引擎拒）；
      // ④ 定时发布：设一个已过的时刻 ⇒ 进提醒队列，且面板上必须写明"只是本地提醒，不代替平台发布"；
      //    清除定时 ⇒ 提醒消失。
      await tab('稿件总览');
      const toggle = await waitFor(() => {
        const t = [...document.querySelectorAll('.disclosure-toggle')].find((x) => String(x.textContent).indexOf('发布状态') >= 0);
        return t || null;
      }, 10000);
      if (toggle === null) return { ok: false, note: '总览页没有「发布状态」折叠区：' + pageText().slice(0, 140) };
      // 折叠区点击要幂等：重试时上一轮可能已经展开了（再点一次会把它关掉）
      if (String(toggle.closest('.disclosure').className).indexOf('open') < 0) {
        toggle.click();
        await sleep(320);
      }
      const panel = await waitFor(() => document.querySelector('.publish-panel'), 20000);
      if (panel === null) return { ok: false, note: '展开后没有发布状态面板' };
      const picker = await waitFor(() => {
        const sel = panel.querySelector('select');
        return sel !== null && sel.options.length > 0 ? sel : null;
      }, 20000);
      if (picker === null) return { ok: false, note: '发布状态面板没有可选的章节' };
      // 挑一章**当前是草稿**的：失败重试时上一轮可能已经把某章标成已发布了（写是真源，重试带得过去），
      // 直接用第一项会撞上"初始状态不是 draft"——那不是产品缺陷，是夹具必须挑对对象。
      const draftOption = [...picker.options].find((o) => String(o.textContent).indexOf('（草稿 · ') >= 0);
      if (draftOption === undefined) return { ok: false, note: '面板里没有处于草稿态的章节可选' };
      const pickSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(picker), 'value').set;
      pickSetter.call(picker, String(draftOption.value));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(320);
      const chapterId = String(picker.value);
      const tree = await window.yushu.project.tree();
      const entry = tree.find((item) => item.type === 'file' && String(item.path).endsWith('/' + chapterId + '.md'));
      if (entry === undefined) return { ok: false, note: '项目树里找不到这一章的文件：' + chapterId };
      const path = String(entry.path);
      const readStatus = async () => {
        const raw = await window.yushu.doc.read(path);
        const m = /^status:\s*(\S+)/m.exec(String(raw.content));
        return { status: m === null ? '(读不到)' : String(m[1]), content: String(raw.content) };
      };
      const chip = (label) => {
        const list = [...panel.querySelectorAll('button')].filter((b) => String(b.textContent).indexOf(label) >= 0);
        return list.length > 0 ? list[0] : null;
      };
      const reminderLine = () => {
        const lines = [...panel.querySelectorAll('div')].filter((d) => String(d.textContent).indexOf('定时提醒') >= 0);
        return lines.length > 0 ? String(lines[0].textContent) : '';
      };
      const reminderCount = () => {
        const m = /(\d+)\s*条/.exec(reminderLine());
        return m === null ? -1 : Number(m[1]);
      };
      const before = await readStatus();
      if (before.status !== 'draft') return { ok: false, note: '这一章的初始状态不是 draft（' + before.status + '），本步无从验证' };

      // ① 标记已发布
      const publishBtn = chip('标记为已发布');
      if (publishBtn === null) return { ok: false, note: '面板里没有「标记为已发布」按钮' };
      if (publishBtn.disabled) return { ok: false, note: '「标记为已发布」按钮不可点' };
      publishBtn.click();
      const published = await waitFor(() => (panel.innerText.indexOf('草稿 → 已发布') >= 0 ? true : null), 20000);
      if (published === null) return { ok: false, note: '点了「标记为已发布」但没有回执：' + panel.innerText.slice(0, 160) };
      const afterPublish = await readStatus();
      const statusOnDisk = afterPublish.status === 'published';
      let ledgerOk = false;
      const ledgerRaw = await window.yushu.doc.read('config/publish.yaml').catch(() => null);
      if (ledgerRaw !== null) {
        ledgerOk = String(ledgerRaw.content).indexOf('to: published') >= 0;
      }

      // ② 反向：退回草稿（回退也要留痕）
      const backBtn = chip('退回草稿');
      if (backBtn === null) return { ok: false, note: '面板里没有「退回草稿」按钮' };
      backBtn.click();
      const backed = await waitFor(() => (panel.innerText.indexOf('已发布 → 草稿') >= 0 ? true : null), 20000);
      if (backed === null) return { ok: false, note: '点了「退回草稿」但没有回执：' + panel.innerText.slice(0, 160) };
      const afterBack = await readStatus();
      const backOnDisk = afterBack.status === 'draft';

      // ③ 非法迁移：草稿 → 修订中 的按钮必须禁用，且理由挂在 title 上
      const reviseBtn = chip('标记为修订中');
      const reviseBlocked = reviseBtn !== null && reviseBtn.disabled === true;
      const reviseReason = reviseBtn === null ? '' : String(reviseBtn.getAttribute('title') || '');
      const reviseWhyOk = reviseReason.indexOf('修订') >= 0;

      // ④ 定时发布：设一个已过的时刻 ⇒ 进提醒队列；清除 ⇒ 提醒消失
      const atBox = await waitFor(() => panel.querySelector('input[type="datetime-local"]'), 10000);
      if (atBox === null) return { ok: false, note: '面板里没有定时发布输入框' };
      const past = new Date(Date.now() - 3600000);
      const pad = (v) => String(v).padStart(2, '0');
      const localValue = String(past.getFullYear()) + '-' + pad(past.getMonth() + 1) + '-' + pad(past.getDate()) +
        'T' + pad(past.getHours()) + ':' + pad(past.getMinutes());
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(atBox), 'value').set;
      setter.call(atBox, localValue);
      atBox.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      const setBtn = chip('设定定时');
      if (setBtn === null) return { ok: false, note: '面板里没有「设定定时」按钮' };
      setBtn.click();
      const scheduled = await waitFor(() => (reminderCount() >= 1 ? true : null), 20000);
      const countWhenDue = reminderCount();
      const reminderText = reminderLine();
      const reminderOk = reminderText.indexOf('只是本地提醒，不代替平台发布') >= 0;
      const scheduledOnDisk = (await readStatus()).content.indexOf('publish_at') >= 0;
      const clearBtn = chip('清除定时');
      if (clearBtn === null) return { ok: false, note: '面板里没有「清除定时」按钮' };
      clearBtn.click();
      const cleared = await waitFor(() => (reminderCount() === 0 ? true : null), 20000);
      const clearedOnDisk = (await readStatus()).content.indexOf('publish_at') < 0;

      const target = [...panel.querySelectorAll('div')].find((d) => String(d.textContent).indexOf('台账留痕') >= 0);
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: statusOnDisk && ledgerOk && backOnDisk && reviseBlocked && reviseWhyOk &&
          scheduled !== null && reminderOk && scheduledOnDisk && cleared !== null && clearedOnDisk,
        note: '章 ' + chapterId + '：初始=' + before.status +
          '；标记已发布→盘上=' + afterPublish.status + '；台账留了痕=' + ledgerOk +
          '；退回草稿→盘上=' + afterBack.status +
          '；非法迁移（草稿→修订中）禁用=' + reviseBlocked + '（理由=' + reviseReason.slice(0, 40) + '）' +
          '；定时到点→提醒条数=' + countWhenDue + '；「只是本地提醒」在屏幕上=' + reminderOk +
          '；盘上写了 publish_at=' + scheduledOnDisk + '；清除定时→提醒清零=' + (cleared !== null) +
          '；盘上 publish_at 已清=' + clearedOnDisk,
      };
    `,
  },
  {
    step: 68,
    title: '批量补摘要：预算预检 → 批量生成候选（盘上没写库）→ 采纳一条 → 摘要文件真的出现（M5/T5-9 第二段，R106）',
    file: 'step68-memory-batch.png',
    body: String.raw`
      // 这一步要证 T5-9 第二段（批量补候选）的三件事：
      // ① **与预算护栏联动**：面板上必须摆出预检结论（要花多少 / 要不要作者点头），
      //    没接护栏的批量就是个"烧钱按钮"；
      // ② **候选化不变**：批量跑出候选后，**盘上不能多出摘要文件**（写库要作者逐条采纳）；
      // ③ 采纳一条 ⇒ 盘上才真的多出摘要文件——**反向的牙**：只验"没写"分不清"没跑"与"跑了没写"。
      await tab('记忆');
      const panel = await waitFor(() => document.querySelector('.memory-coldstart'), 20000);
      if (panel === null) return { ok: false, note: '记忆页没有「冷启动待补」面板：' + pageText().slice(0, 140) };
      const countSummaries = async () => {
        const tree = await window.yushu.project.tree();
        // 卷摘要落在 memory/volumes/、章摘要落在 memory/chapters/ —— 两边都要数：
        // 批次的顺序是**卷摘要在前**，只数 chapters/ 会把"采纳了卷摘要"看成"没采纳"。
        return tree.filter((item) => item.type === 'file' &&
          (item.path.indexOf('memory/chapters/') === 0 || item.path.indexOf('memory/volumes/') === 0)).length;
      };
      const before = await countSummaries();
      const btn = [...panel.querySelectorAll('button')].find((b) => String(b.textContent).trim() === '批量生成候选');
      if (btn === undefined) return { ok: false, note: '面板里没有「批量生成候选」按钮' };
      if (btn.disabled) return { ok: false, note: '「批量生成候选」按钮不可点' };
      btn.click();
      const candidates = await waitFor(() => {
        const list = panel.querySelector('.memory-batch-candidates');
        return list !== null && list.querySelectorAll('li').length > 0 ? list : null;
      }, 90000);
      if (candidates === null) return { ok: false, note: '批量跑完没出现候选：' + panel.innerText.slice(0, 200) };
      const rows = candidates.querySelectorAll('li').length;
      const budgetLine = [...panel.querySelectorAll('div')]
        .map((d) => String(d.textContent || ''))
        .find((text) => text.indexOf('预算预检') >= 0) || '';
      const budgetOk = budgetLine.indexOf('预算预检') >= 0;
      // 候选化：跑完候选，盘上的摘要文件数**一个都没多**
      const afterBatch = await countSummaries();
      const notWritten = afterBatch === before;
      // 反向：采纳一条 ⇒ 盘上才真的多出一个摘要文件
      const adopt = [...candidates.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('采纳这条') >= 0);
      if (adopt === undefined) return { ok: false, note: '候选行里没有「采纳这条」按钮' };
      adopt.click();
      const written = await waitFor(async () => ((await countSummaries()) > before ? true : null), 30000);
      const afterAdopt = await countSummaries();
      // 截图要拍在**被断言的那一段**：预算预检那行与候选列表是同一块的两头，
      // 把预检行滚到画面中间，候选列表正好在它下面（只滚候选列表会把预检行顶到画面外）。
      const budgetEl = [...panel.querySelectorAll('div')].find((d) => String(d.textContent || '').indexOf('预算预检') >= 0);
      if (budgetEl) budgetEl.scrollIntoView({ block: 'center' });
      else {
        const list = panel.querySelector('.memory-batch-candidates');
        if (list) list.scrollIntoView({ block: 'center' });
      }
      await sleep(240);
      return {
        ok: budgetOk && notWritten && written !== null && afterAdopt === before + 1,
        note: '批量候选=' + rows + ' 条；预算预检在屏幕上=' + budgetOk + '（' + budgetLine.slice(0, 70) + '）' +
          '；跑完候选后盘上摘要文件 ' + before + ' → ' + afterBatch + '（一个没多=' + notWritten + '）' +
          '；采纳一条→盘上摘要文件 ' + afterAdopt + '（比跑之前多 1=' + (afterAdopt === before + 1) + '）',
      };
    `,
  },
  {
    step: 69,
    title: '导入第二段：AI 筛一遍切分 → 章数变了；误切清单点名；人工合并后章数再变（M5/T5-7 第二段，R107）',
    file: 'step69-import-split.png',
    fixture: "import-dialog",
    body: String.raw`
      // 这一步要证「存量导入第二段」的两件事在界面上都真的接上了：
      // ① **AI 二次筛选切分**（I09 §3.4）：点「AI 筛一遍切分」⇒ 切分来源变成 AI，
      //    而且**章数真的变了**——只显示"AI 筛过了"不算数（那可能什么都没改）；
      // ② **误切检测 + 人工校正**（I09 §3.5）：误切清单逐条点名，
      //    点「与下一章合并」⇒ 章数再变（作者改的是计划，不是稿子）。
      // 反向的牙：**盘上一个字节都没动**——这一段只改计划，真源写仍是「确认入库」那条通道。
      await tab('稿件总览');
      const toggle = await waitFor(() => {
        const t = [...document.querySelectorAll('.disclosure-toggle')].find((x) => String(x.textContent).indexOf('导入存量稿件') >= 0);
        return t || null;
      }, 10000);
      if (toggle === null) return { ok: false, note: '总览页没有「导入存量稿件」折叠区' };
      // 折叠区点击要幂等（重试时上一轮可能已经展开了，再点一次会把它关掉）
      if (String(toggle.closest('.disclosure').className).indexOf('open') < 0) {
        toggle.click();
        await sleep(320);
      }
      const chapterCount = async () => {
        const el = [...document.querySelectorAll('.import-block-title')].find((d) => String(d.textContent).indexOf('分章预演') >= 0);
        if (el === undefined) return -1;
        const m = /分章预演：(\d+) 章/.exec(String(el.textContent));
        return m === null ? -1 : Number(m[1]);
      };
      const aiSource = () => {
        // 只读「切分来源」那一格：读整块 innerText 会把回退文案（"已回退到正则切分"）一起读进来，
        // "含正则切分"就分不清是"这次是正则切的"还是"AI 筛了但回退了"。
        // 标签「切分来源：」去掉——回执里会自己带上这个标签。
        const el = document.querySelector('.import-source');
        if (el === null) return '';
        return String(el.textContent).replace(/\s+/g, ' ').replace(/^切分来源：/, '').trim();
      };
      const miscutRows = () => document.querySelectorAll('.import-miscut-table tbody tr').length;
      // 选那份"切错了"的稿子（夹具按 window.__yushuPick 给；不靠调用次序）
      window.__yushuPick = 'miscut';
      const pickBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => String(x.textContent).indexOf('选择文件') >= 0);
        return b || null;
      }, 10000);
      if (pickBtn === null) return { ok: false, note: '导入面板里没有「选择文件…」按钮' };
      const treeBefore = await window.yushu.project.tree();
      pickBtn.click();
      // 失败重试时面板还留着上一轮的面板状态（切分来源已经是「AI 筛过」）：
      // 不等「切分来源回到正则切分」就取章数，before 会读到上一轮的旧数字，
      // 于是后面每一步都在跟一个不存在的基线比（R107 第一次跑就撞上了这个）。
      const before = await waitFor(async () => {
        const n = await chapterCount();
        const src = aiSource();
        return n > 0 && src.indexOf('正则切分') >= 0 ? n : null;
      }, 40000);
      if (before === null) return { ok: false, note: '预演没出分章预演表：' + pageText().slice(0, 140) };
      const miscutsBefore = miscutRows();
      const sourceBefore = aiSource();
      // ① AI 筛一遍：切分来源要变成 AI，且章数真的变
      const aiBtn = [...document.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('AI 筛一遍切分') >= 0);
      if (aiBtn === undefined) return { ok: false, note: '面板里没有「AI 筛一遍切分」按钮' };
      aiBtn.click();
      const afterAi = await waitFor(async () => {
        const n = await chapterCount();
        const src = aiSource();
        return n > 0 && n !== before && src.indexOf('AI 筛过') >= 0 ? n : null;
      }, 60000);
      if (afterAi === null) return { ok: false, note: 'AI 筛过之后章数没变（切分来源：' + aiSource() + '）' };
      const sourceAfter = aiSource();
      const aiOk = sourceAfter.indexOf('AI 筛过') >= 0;
      // ② 误切清单 → 人工合并 → 章数再变
      // 合并按钮有两个方向（与上一章 / 与下一章），没邻居的那个是**禁用**态：
      // 找**可用的**那一个（点禁用按钮不会触发任何事，点了等于没点）。
      const mergeButtons = [...document.querySelectorAll('.import-miscut-table button')].filter((b) => String(b.textContent).indexOf('合并') >= 0);
      const mergeBtn = mergeButtons.find((b) => b.disabled !== true);
      if (mergeBtn === undefined) {
        return { ok: false, note: '误切清单里没有可用的「合并」按钮（检出 ' + String(miscutRows()) + ' 条；按钮 ' +
          mergeButtons.map((b) => String(b.textContent).trim() + (b.disabled === true ? '(禁用)' : '')).join(' / ') + '）' };
      }
      const mergeLabel = String(mergeBtn.textContent).trim();
      mergeBtn.click();
      const afterMerge = await waitFor(async () => {
        const n = await chapterCount();
        return n > 0 && n !== afterAi ? n : null;
      }, 40000);
      if (afterMerge === null) return { ok: false, note: '合并之后章数没变（还是 ' + String(afterAi) + ' 章；点的是「' + mergeLabel + '」）' };
      // 反向的牙：盘上一个字节都没动（这一段只改计划）
      const treeAfter = await window.yushu.project.tree();
      const diskUntouched = JSON.stringify(treeBefore) === JSON.stringify(treeAfter);
      const target = [...document.querySelectorAll('.import-block')].find((d) => String(d.textContent).indexOf('切分复核') >= 0);
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: aiOk && miscutsBefore > 0 && afterMerge < afterAi && diskUntouched,
        note: '正则切分=' + before + ' 章（切分来源：' + sourceBefore.slice(0, 30) + '）' +
          '；误切清单=' + miscutsBefore + ' 条' +
          '；AI 筛一遍→' + afterAi + ' 章（切分来源：' + sourceAfter.slice(0, 40) + '）' +
          '；人工合并（' + mergeLabel + '）→' + afterMerge + ' 章' +
          '；盘上真源一个字节没动=' + diskUntouched,
      };
    `,
  },
  {
    step: 70,
    title: '导入可中断续跑：入库途中停下 → 断点落盘 → 重选同一份稿子 → 续跑补齐剩下的（M5/T5-7 第三段，R108）',
    file: 'step70-import-resume.png',
    fixture: "import-dialog",
    body: String.raw`
      // 这一步要证 I09 §2.7 的「可中断 + 断点续跑」在界面上真的走得通：
      // ① **入库途中能停**：点「停下（剩下的可续跑）」⇒ 盘上留下一份任务记录，断点写着最后成功章号；
      // ② **重选同一份稿子 ⇒ 界面摆出「可续跑」**（主进程按源文件指纹核对出来的）；
      // ③ **续跑把剩下的补齐**，已写好的那几章**不动**；
      // ④ **还没入库时的「取消导入」真的作废票据**（面板回到初始态）。
      await tab('稿件总览');
      const toggle = await waitFor(() => {
        const t = [...document.querySelectorAll('.disclosure-toggle')].find((x) => String(x.textContent).indexOf('导入存量稿件') >= 0);
        return t || null;
      }, 10000);
      if (toggle === null) return { ok: false, note: '总览页没有「导入存量稿件」折叠区' };
      if (String(toggle.closest('.disclosure').className).indexOf('open') < 0) {
        toggle.click();
        await sleep(320);
      }
      const panel = await waitFor(() => document.querySelector('.import-panel'), 10000);
      if (panel === null) return { ok: false, note: '没有导入面板：' + pageText().slice(0, 140) };
      const btn = (label) => [...panel.querySelectorAll('button')].find((b) => String(b.textContent).indexOf(label) >= 0);
      // 等**长稿那一份**的预演：面板上可能还留着上一步的旧预演（step69 选的是"切错了"那份），
      // 只等"分章预演"这几个字会立刻返回 ⇒ 后面每一步都在对着一份过期的视图操作。
      const longPreview = async () => {
        for (let i = 0; i < 200; i += 1) {
          const el = [...panel.querySelectorAll('.import-block-title')].find((d) => String(d.textContent).indexOf('分章预演') >= 0);
          if (el !== undefined) {
            const text = String(el.textContent);
            if (text.indexOf('40 章') >= 0) return text;
          }
          await sleep(100);
        }
        return null;
      };
      const draftCount = async () => {
        const tree = await window.yushu.project.tree();
        return tree.filter((item) => item.type === 'file' && item.path.indexOf('chapters/') === 0).length;
      };

      // ① 还没入库时先取消一次：票据作废 ⇒ 面板回到初始态（这一条不依赖任何时序）
      window.__yushuPick = 'long';
      let pickBtn = await waitFor(() => btn('选择文件') || null, 10000);
      if (pickBtn === undefined || pickBtn === null) return { ok: false, note: '面板里没有「选择文件…」按钮' };
      pickBtn.click();
      const previewed = await longPreview();
      if (previewed === null) return { ok: false, note: '预演没出长稿那一份分章预演表：' + pageText().slice(0, 140) };
      // 等按钮**可点**再点：预演渲染完成与 busy 复位不一定同拍，
      // 点一个还禁用的按钮等于没点（这一条曾让本步抖动过一次）。
      const cancelBtn = await waitFor(() => {
        const b = btn('取消导入');
        return b !== undefined && b.disabled !== true ? b : null;
      }, 10000);
      if (cancelBtn === null) return { ok: false, note: '面板里没有可点的「取消导入」按钮' };
      cancelBtn.click();
      const backToStart = await waitFor(() => (btn('选择文件') !== undefined && panel.innerText.indexOf('分章预演') < 0 ? true : null), 15000);
      const cancelOk = backToStart !== null;
      // 取消这一段的诊断：回执原话 + 面板上的错误 + 面板里还剩什么
      const cancelDiag =
        '回执=[' + String(panel.querySelector('.import-note') === null ? '' : String(panel.querySelector('.import-note').textContent || '')).slice(0, 60) + ']' +
        ' 错误=[' + String(panel.querySelector('.error-text') === null ? '' : String(panel.querySelector('.error-text').textContent || '')).slice(0, 80) + ']' +
        ' 面板=[' + panel.innerText.replace(/\s+/g, ' ').slice(0, 120) + ']';

      // ② 入库途中点「停下」：用的是 40 章的长稿（窗口够宽，停下来停在哪一章都行）
      pickBtn = await waitFor(() => btn('选择文件') || null, 10000);
      if (pickBtn === undefined || pickBtn === null) return { ok: false, note: '取消后没有回到可再选文件的状态' };
      pickBtn.click();
      const previewed2 = await longPreview();
      if (previewed2 === null) return { ok: false, note: '第二次预演没出长稿那一份分章预演表' };
      const applyBtn = await waitFor(() => {
        const b = btn('确认入库');
        return b !== undefined && b.disabled !== true ? b : null;
      }, 10000);
      if (applyBtn === null) return { ok: false, note: '面板里没有可点的「确认入库」按钮' };
      // 回执块的内容（用来判"入库这一轮结束了"）：等**内容变了**而不是等某个词
      // ——按钮文案里就有「停下」，等字会立刻返回，入库其实还在跑
      const resultText = () => {
        const el = panel.querySelector('.import-result');
        return el === null ? '' : String(el.textContent || '').replace(/\s+/g, ' ');
      };
      const beforeApply = resultText();
      const beforeDrafts = await draftCount();
      applyBtn.click();
      const stopBtn = await waitFor(() => btn('停下') || null, 20000, 5);
      if (stopBtn === undefined || stopBtn === null) return { ok: false, note: '入库途中没有出现「停下」按钮' };
      stopBtn.click();
      const stopAck = await waitFor(() => (panel.innerText.indexOf('已请求停下') >= 0 ? true : null), 20000, 20);
      const resultShown = await waitFor(() => (resultText() !== beforeApply ? true : null), 60000, 50);
      if (resultShown === null) return { ok: false, note: '点了「停下」但没有入库回执：' + panel.innerText.slice(0, 200) };
      const afterStopDrafts = await draftCount();
      // 断点落盘：有一份可续跑的任务记录，且它记的章数与盘上的章数对得上
      const jobs = await window.yushu.import.jobs();
      const job = jobs.length > 0 ? jobs[0] : null;
      const jobOk = job !== null && job.last_chapter === afterStopDrafts - beforeDrafts && job.total_chapters === 40;
      const partial = afterStopDrafts - beforeDrafts < 40;

      // ③ 重选同一份稿子 ⇒ 界面摆出「可续跑」⇒ 续跑补齐剩下的
      pickBtn = await waitFor(() => btn('选择文件') || null, 10000);
      if (pickBtn === undefined || pickBtn === null) return { ok: false, note: '停下之后没有回到可再选文件的状态' };
      pickBtn.click();
      const banner = await waitFor(() => (panel.innerText.indexOf('这稿子上次没导完') >= 0 ? true : null), 40000, 20);
      if (banner === null) return { ok: false, note: '重选同一份稿子后没有出现「可续跑」提示：' + panel.innerText.slice(0, 200) };
      const resumeBtn = await waitFor(() => {
        const b = btn('续跑并入库');
        return b !== undefined && b.disabled !== true ? b : null;
      }, 10000);
      if (resumeBtn === null) return { ok: false, note: '面板里没有可点的「续跑并入库」按钮' };
      const beforeResume = resultText();
      resumeBtn.click();
      const done = await waitFor(() => (resultText() !== beforeResume ? true : null), 60000, 50);
      if (done === null) return { ok: false, note: '续跑之后没有入库回执：' + panel.innerText.slice(0, 200) };
      const finalDrafts = await draftCount();
      const jobsAfter = await window.yushu.import.jobs();
      const allWritten = finalDrafts - beforeDrafts === 40;
      const noResumableLeft = jobsAfter.length === 0;

      const target = [...panel.querySelectorAll('.import-block')].find((d) => String(d.textContent).indexOf('没导完') >= 0);
      if (target) target.scrollIntoView({ block: 'center' });
      else {
        const res = [...panel.querySelectorAll('div')].find((d) => String(d.textContent).indexOf('已入库') >= 0);
        if (res) res.scrollIntoView({ block: 'center' });
      }
      await sleep(240);
      return {
        ok: cancelOk && jobOk && partial && allWritten && noResumableLeft,
        note: '取消导入后回到初始态=' + cancelOk + (cancelOk ? '' : '（' + cancelDiag + '）') +
          '；停下回执=' + String(stopAck !== null) +
          '；停下时已落盘 ' + String(afterStopDrafts - beforeDrafts) + '/40 章' +
          '；断点记录（已写 ' + String(job === null ? -1 : job.last_chapter) + ' / 共 ' + String(job === null ? -1 : job.total_chapters) + ' 章）=' + jobOk +
          '；续跑后盘上共 ' + String(finalDrafts - beforeDrafts) + ' 章=' + allWritten +
          '；没有可续跑的任务残留=' + noResumableLeft,
      };
    `,
  },
  {
    step: 71,
    title: 'UI 重构第一轮：品牌标记在屏上 + 界面密度档真的改变行高（切回默认值不改画面）',
    file: 'step71-ui-brand-density.png',
    body: String.raw`
      // 这一步要证两件**看得见**的事（R109 UI 重构第一轮）：
      // ① **品牌标记**在屏上（顶栏的标记 + 字标），而且它不是一张图、是一段**本项目自绘**的矢量；
      // ② **界面密度档**是**真的开关**：切到「紧凑」⇒ 表格单元格的行内距真的变小（行更密），
      //    切回「标准」⇒ **逐字恢复**（默认档的取值 = 改版前的样子，一个像素都不许差）。
      //    只验"选择器存在"是自欺欺人：密度档的全部价值就在"行真的变密了"。
      // 页面选「规则」：它的结论表是**真表格**（.slot-table）。
      // 稿件总览的章节列表是**虚拟列表**（没有 table）⇒ 在那儿量不到行高。
      await tab('规则');
      const topbar = await waitFor(() => document.querySelector('.topbar'), 10000);
      if (topbar === null) return { ok: false, note: '没有顶栏：' + pageText().slice(0, 120) };
      // ① 品牌标记
      const mark = topbar.querySelector('.brand-mark');
      const markBox = mark === null ? null : mark.getBoundingClientRect();
      const markOk = mark !== null && markBox !== null && markBox.width > 0 && markBox.height > 0;
      const wordmark = String(topbar.querySelector('.brand')?.textContent ?? '');
      const wordmarkOk = wordmark.indexOf('御书') >= 0;
      // 标记是**矢量**（能缩放、不糊）⇒ 它是 <svg>，不是位图
      const isVector = mark !== null && String(mark.tagName).toLowerCase() === 'svg';

      // ② 密度档：改前后量同一个单元格的 computed padding
      const cell = await waitFor(() => {
        const td = document.querySelector('.slot-table tbody td');
        return td === null ? null : td;
      }, 10000);
      if (cell === null) return { ok: false, note: '稿件总览里没有表格，量不到行高：' + pageText().slice(0, 120) };
      const padOf = (el) => {
        const cs = getComputedStyle(el);
        return { top: cs.paddingTop, left: cs.paddingLeft };
      };
      const padCozy = padOf(cell);
      const picker = topbar.querySelector('.density-picker select');
      if (picker === null) return { ok: false, note: '顶栏里没有密度档选择器' };
      const setDensity = async (value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(picker, value);
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(180);
      };
      await setDensity('compact');
      const padCompact = padOf(document.querySelector('.slot-table tbody td') ?? cell);
      const compactOk = parseFloat(padCompact.top) < parseFloat(padCozy.top) && parseFloat(padCompact.left) < parseFloat(padCozy.left);
      // 切回默认档：必须**逐字恢复**（默认档 = 改版前的取值）
      await setDensity('cozy');
      const padBack = padOf(document.querySelector('.slot-table tbody td') ?? cell);
      const restored = padBack.top === padCozy.top && padBack.left === padCozy.left;

      const target = topbar.querySelector('.brand-lockup');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: markOk && wordmarkOk && isVector && compactOk && restored,
        note: '品牌标记在屏上=' + markOk + '（' + (markBox === null ? 0 : Math.round(markBox.width)) + 'px，矢量=' + isVector + '）' +
          '；字标="' + wordmark + '"=' + wordmarkOk +
          '；密度档：标准 ' + padCozy.top + '/' + padCozy.left + ' → 紧凑 ' + padCompact.top + '/' + padCompact.left +
          '（真的更密=' + compactOk + '）→ 切回 ' + padBack.top + '/' + padBack.left + '（逐字恢复=' + restored + '）',
      };
    `,
  },
  {
    step: 72,
    title: 'UI 重构第二批：清单行键盘可达 + 数字列右对齐 + 阅读行长收窄（写作版面不动）',
    file: 'step72-ui-typography-keyboard.png',
    fixture: "import-dialog",
    body: String.raw`
      // 这一步量四件**量得到**的事（这一批动的都是画面 ⇒ 判据必须能被观察）：
      // ① **数字列右对齐**：导入面板「字数」列右对齐（能竖着比），
      //    且它走的是统一的 .num（不是导入面板自己那套）；
      // ② **键盘可达**：设定卡清单行是**真按钮**（能聚焦），
      //    关系图的 SVG 节点是**可聚焦的图形按钮**（tabindex=0 + role=button + 有可读名）；
      // ③ **阅读行长**：面板里的说明段落一行不超过约 34 字；
      // ④ **写作版面不动**：编辑器的行长还是 44em（≈44 字/行，R64 刻意的）——
      //    **写作是"扫"、阅读是"读"**，两种版面两个上限，不能一起收窄。
      // 数字列要先在导入面板里看（那是唯一常驻的带数字列的表）⇒ 用夹具选一份稿子。
      window.__yushuPick = 'utf8';
      await tab('稿件总览');
      const pickBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => String(x.textContent).indexOf('选择文件') >= 0);
        return b === undefined ? null : b;
      }, 10000);
      if (pickBtn === null) return { ok: false, note: '导入面板里没有「选择文件…」按钮' };
      pickBtn.click();
      const chapterTable = await waitFor(() => {
        const t = document.querySelector('.import-table');
        return t === null ? null : t;
      }, 40000);
      if (chapterTable === null) return { ok: false, note: '预演没出分章表：' + pageText().slice(0, 140) };
      const numCells = [...document.querySelectorAll('.import-panel .num')];
      const rightAligned = numCells.filter((c) => getComputedStyle(c).textAlign === 'right').length;
      const numericOk = numCells.length > 0 && rightAligned === numCells.length;

      // ② 键盘可达：设定卡清单行是真按钮（能聚焦）
      await tab('世界观档案');
      const cardButtons = [...document.querySelectorAll('.card-list li > button')];
      let focusable = 0;
      for (const b of cardButtons) {
        b.focus();
        if (document.activeElement === b) focusable += 1;
      }
      const graphNodes = [...document.querySelectorAll('g.graph-node')];
      const nodeOk = graphNodes.filter((n) =>
        n.getAttribute('tabindex') === '0' &&
        n.getAttribute('role') === 'button' &&
        String(n.getAttribute('aria-label') || '').length > 0).length;
      const keyboardOk = cardButtons.length > 0 && focusable === cardButtons.length && nodeOk === graphNodes.length;

      // ③ 阅读行长：当前页最长的一段说明文字，一行不超过约 34 字
      await tab('规则');
      const prose = [...document.querySelectorAll('.panel p')]
        .filter((p) => String(p.textContent || '').trim().length > 40)
        .map((p) => {
          const cs = getComputedStyle(p);
          const size = parseFloat(cs.fontSize) || 13;
          return { chars: Math.round(p.getBoundingClientRect().width / size), size };
        })
        .sort((a, b) => b.chars - a.chars);
      const worst = prose[0];
      const measureOk = worst !== undefined && worst.chars <= 36;

      // ④ 写作版面不动：还是 44em（R64 的定论）
      await tab('编辑器');
      const host = await waitFor(() => document.querySelector('.cm-host') || null, 5000);
      const writingMax = host === null ? 0 : Math.round(parseFloat(getComputedStyle(host).maxWidth || '0'));
      const writingOk = writingMax >= 560 && writingMax <= 720;

      const target = document.querySelector('.cm-host');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: numericOk && keyboardOk && measureOk && writingOk,
        note: '数字列：' + numCells.length + ' 格，右对齐 ' + rightAligned + ' 格=' + numericOk +
          '；键盘可达：设定卡按钮 ' + cardButtons.length + ' 个（可聚焦 ' + focusable + '）、图节点 ' + graphNodes.length + ' 个（可聚焦 ' + nodeOk + '）=' + keyboardOk +
          '；阅读行长：最长一段约 ' + (worst === undefined ? -1 : worst.chars) + ' 字/行（上限 36）=' + measureOk +
          '；写作版面：' + writingMax + 'px（44em，不动）=' + writingOk,
      };
    `,
  },
  {
    step: 73,
    title: '开屏：欢迎屏有品牌标记，入场是**一次过渡**（中间态可测，reduced-motion 口径在契约里）',
    file: 'step73-ui-splash.png',
    body: String.raw`
      // 这一步证「开屏」这件事：欢迎屏（作者真正看到的第一屏）有品牌标记，
      // 而且它的入场是**一次过渡**——不是每个元素都在表演（契约 §5 的反参照）。
      // 判据三件：① 标记在屏上；② 入场**有中间态**（逐帧采样，量到 opacity 在 0 与 1 之间），
      // ③ 终值是**完全可见**（opacity = 1，不是停在半透明）。
      // 走到欢迎屏的路：顶栏「新建项目」⇒ 向导 ⇒「取消」⇒ 回到欢迎屏（真实交互，不是改状态）。
      // **先装采样器再触发导航**：380ms 的过渡一眨眼就过去了，
      // 等我们开始采样时它已经结束（v252 采到 9 帧、v253 采到 0 帧，就是这个竞态）。
      window.__opacSamples = [];
      window.__opacOn = true;
      (function sampleLoop() {
        if (!window.__opacOn) return;
        const el = document.querySelector('.welcome h1');
        if (el !== null) window.__opacSamples.push(Number(getComputedStyle(el).opacity));
        requestAnimationFrame(sampleLoop);
      })();
      const topbar = await waitFor(() => document.querySelector('.topbar'), 10000);
      if (topbar === null) return { ok: false, note: '没有顶栏：' + pageText().slice(0, 120) };
      const newBtn = [...topbar.querySelectorAll('button')].find((b) => String(b.textContent).indexOf('新建项目') >= 0);
      if (newBtn === undefined) return { ok: false, note: '顶栏里没有「新建项目」按钮' };
      newBtn.click();
      const cancelBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => String(x.textContent).trim() === '取消');
        return b === undefined ? null : b;
      }, 10000);
      if (cancelBtn === null) return { ok: false, note: '向导里没有「取消」按钮' };
      cancelBtn.click();
      const welcome = await waitFor(() => document.querySelector('.welcome'), 10000);
      if (welcome === null) return { ok: false, note: '没有回到欢迎屏：' + pageText().slice(0, 120) };
      // 等过渡跑完（终值必须完全可见）
      await sleep(600);
      window.__opacOn = false;
      const mark = welcome.querySelector('.welcome-mark');
      const markBox = mark === null ? null : mark.getBoundingClientRect();
      const markOk = mark !== null && markBox !== null && markBox.width > 0;
      const samples = Array.isArray(window.__opacSamples) ? window.__opacSamples : [];
      const midStates = samples.filter((v) => v > 0.02 && v < 0.98).length;
      const finalOpacity = Number(getComputedStyle(document.querySelector('.welcome h1')).opacity);
      const transitionOn = getComputedStyle(document.querySelector('.welcome h1')).transitionDuration;
      const target = welcome.querySelector('.welcome-mark');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(240);
      return {
        ok: markOk && midStates > 0 && finalOpacity > 0.98,
        note: '欢迎屏的品牌标记在屏上=' + markOk + '（' + (markBox === null ? 0 : Math.round(markBox.width)) + 'px）' +
          '；入场中间态帧数=' + midStates + '/' + String(samples.length) + '（transition=' + transitionOn + '）' +
          '；终值 opacity=' + finalOpacity,
      };
    `,
  },
  {
    step: 74,
    title: 'UI 重构第三批：浮层真的有进退场（进场 240ms / 退场 140ms——退场比进场快）',
    file: 'step74-ui-motion-overlay.png',
    reloadBefore: true,
    body: String.raw`
      // 这一步量的是**动效本身**：御书唯一的浮层（@ 候选菜单）真的有进退场吗？
      // 判据五件：
      // ① 进场的时长与曲线 = 进场族（240ms / ease-enter）；
      // ② **退场比进场快**（退场 140ms / ease-premium）——docs/11 §3.2 第 1 条；
      // ③ 进场与退场**都真的播了**（逐帧采到中间态，不许只有终值）；
      // ④ 退场结束后浮层**真的从 DOM 里消失**（退场不是"停在半透明"）；
      // ⑤ 候选行的微反馈走状态族（hover 底色有过渡，不是硬切）。
      //
      // 为什么这一步要 reloadBefore：上一步（step73 开屏）走的是「新建项目 → 取消」，
      // 把界面留在**欢迎屏**，而欢迎屏没有「返回项目」的入口（「打开已有项目」走系统对话框，
      // 没法自动化）。主进程重载渲染进程后，App 挂载时会读 project.current() 自动回到项目页。
      const tabBar = await waitFor(() => document.querySelector('.tab'), 15000);
      if (tabBar === null) return { ok: false, note: '没有标签栏（界面不在项目页）：' + pageText().slice(0, 120) };
      await tab('编辑器');
      const richBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('富文本'));
        return b === undefined ? null : b;
      }, 15000);
      if (richBtn === null) return { ok: false, note: '编辑器里找不到富文本切换按钮：' + pageText().slice(0, 120) };
      richBtn.click();
      const tiptap = await waitFor(() => document.querySelector('.tiptap-host .tiptap'), 15000);
      if (!tiptap) return { ok: false, note: '富文本编辑器未挂载：' + pageText().slice(0, 120) };
      await sleep(400);
      const typeText = (text) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return;
        el.focus();
        const last = el.lastElementChild || el;
        const range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      };
      const press = (key) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return false;
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        return true;
      };
      // 采样器**先装好再触发**：进场只有 240ms，等我们开始看它已经结束了（R109 栽过这个竞态）
      const samples = [];
      let sampling = true;
      const sampler = () => {
        if (!sampling) return;
        const el = document.querySelector('.mention-menu');
        if (el !== null) {
          const cs = getComputedStyle(el);
          samples.push({ o: Number(cs.opacity), d: cs.transitionDuration, f: cs.transitionTimingFunction });
        }
        requestAnimationFrame(sampler);
      };
      requestAnimationFrame(sampler);
      typeText('@');
      const menu = await waitFor(() => document.querySelector('.mention-menu'), 4000);
      if (!menu) return { ok: false, note: '输入 @ 后未出现候选菜单：' + pageText().slice(0, 120) };
      await sleep(400);
      sampling = false;
      const enterDur = getComputedStyle(menu).transitionDuration;
      const enterFn = getComputedStyle(menu).transitionTimingFunction;
      const enterOpacity = Number(getComputedStyle(menu).opacity);
      const enterMid = samples.filter((s) => s.o > 0.02 && s.o < 0.98).length;
      // ⑤ 候选行微反馈：hover 底色走状态族（有过渡）
      const li = document.querySelector('.mention-menu li');
      const liTransition = li === null ? '' : getComputedStyle(li).transitionDuration;
      // 触发退场：Esc。退场采样器也先装好再触发
      const leaveSamples = [];
      let leaveSampling = true;
      const leaveSampler = () => {
        if (!leaveSampling) return;
        const el = document.querySelector('.mention-menu');
        if (el !== null) leaveSamples.push(Number(getComputedStyle(el).opacity));
        requestAnimationFrame(leaveSampler);
      };
      requestAnimationFrame(leaveSampler);
      press('Escape');
      await sleep(50);
      const leaveDur = getComputedStyle(menu).transitionDuration;
      const leaveFn = getComputedStyle(menu).transitionTimingFunction;
      const leaveMidOpacity = Number(getComputedStyle(menu).opacity);
      const removed = await waitFor(() => (document.querySelector('.mention-menu') === null ? true : null), 3000);
      leaveSampling = false;
      const leaveMid = leaveSamples.filter((o) => o > 0.02 && o < 0.98).length;
      const target = document.querySelector('.tiptap-host');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(200);
      const toMs = (d) => Math.round(parseFloat(d) * (String(d).indexOf('ms') >= 0 ? 1 : 1000));
      const enterMs = toMs(enterDur);
      const leaveMs = toMs(leaveDur);
      const enterOk = enterMs === 240 && enterFn.indexOf('0.05') >= 0;
      const leaveOk = leaveMs === 140 && leaveFn.indexOf('0.4') >= 0;
      const fasterOk = leaveMs < enterMs;
      return {
        ok: enterOk && leaveOk && fasterOk && enterMid > 0 && leaveMid > 0 && removed === true && enterOpacity > 0.98,
        note: '进场 ' + enterDur + ' / ' + enterFn + '（中间态 ' + enterMid + ' 帧，终值 opacity=' + enterOpacity + '）' +
          '；退场 ' + leaveDur + ' / ' + leaveFn + '（中间态 ' + leaveMid + ' 帧，退场中 opacity=' + leaveMidOpacity + '）' +
          '；退场比进场快=' + fasterOk + '；退场后从 DOM 消失=' + removed +
          '；候选行微反馈 transition=' + liTransition,
      };
    `,
  },
  {
    step: 75,
    title: 'UI 重构第三批：系统要求减少动效时动效确实为 0（浮层直接到位，退场不拖泥带水）',
    file: 'step75-ui-motion-reduced.png',
    emulateReducedMotion: true,
    body: String.raw`
      // 这一步在「系统要求减少动效」下跑（主进程已用 CDP 模拟该系统设置）。
      // 判据四件：
      // ① 媒体环境真的切过来了（matchMedia 对得上，且主进程如实报了"已模拟"）；
      // ② 浮层的过渡**为 0**（不是 0.24s）——契约 §5 第 3 条；
      // ③ 浮层**直接可见**（作者要求的是少动效，不是少内容：动效不得成为理解的前提）；
      // ④ 退场**立即**完成（不播那 140ms 的退场动画）。
      const emulated = window.__yushuReducedMotion === true;
      const mediaMatches = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const tabBar = await waitFor(() => document.querySelector('.tab'), 15000);
      if (tabBar === null) return { ok: false, note: '没有标签栏（界面不在项目页）：' + pageText().slice(0, 120) };
      await tab('编辑器');
      const richBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('.mode-switch button')].find((x) => x.textContent.includes('富文本'));
        return b === undefined ? null : b;
      }, 15000);
      if (richBtn === null) return { ok: false, note: '编辑器里找不到富文本切换按钮：' + pageText().slice(0, 120) };
      richBtn.click();
      const tiptap = await waitFor(() => document.querySelector('.tiptap-host .tiptap'), 15000);
      if (!tiptap) return { ok: false, note: '富文本编辑器未挂载：' + pageText().slice(0, 120) };
      await sleep(400);
      const typeText = (text) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return;
        el.focus();
        const last = el.lastElementChild || el;
        const range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      };
      const press = (key) => {
        const el = document.querySelector('.tiptap-host .tiptap');
        if (!el) return false;
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        return true;
      };
      typeText('@');
      const menu = await waitFor(() => document.querySelector('.mention-menu'), 4000);
      if (!menu) return { ok: false, note: '输入 @ 后未出现候选菜单：' + pageText() };
      await sleep(150);
      const dur = getComputedStyle(menu).transitionDuration;
      const opacity = Number(getComputedStyle(menu).opacity);
      const durMs = Math.round(parseFloat(dur) * (String(dur).indexOf('ms') >= 0 ? 1 : 1000));
      // 退场：reduce 下必须**立即**消失（细粒度轮询量真实耗时，不用 waitFor 的 100ms 粗粒度）
      const t0 = Date.now();
      press('Escape');
      let elapsed = -1;
      for (let i = 0; i < 200; i += 1) {
        if (document.querySelector('.mention-menu') === null) { elapsed = Date.now() - t0; break; }
        await sleep(5);
      }
      const immediate = elapsed >= 0 && elapsed < 80;
      const target = document.querySelector('.tiptap-host');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: emulated && mediaMatches && durMs === 0 && opacity > 0.98 && immediate,
        note: '模拟已生效=' + emulated + '；媒体查询对得上=' + mediaMatches +
          '；浮层过渡=' + dur + '（0 才算对）' +
          '；浮层直接可见 opacity=' + opacity +
          '；退场耗时=' + String(elapsed) + 'ms（reduce 下必须立刻消失，不等 140ms）=' + immediate,
      };
    `,
  },
  {
    step: 76,
    title: 'UI 重构第四批：标题层级在运行时真的分三级（面板标题条与块内区块标题同档）',
    file: 'step76-ui-title-hierarchy.png',
    body: String.raw`
      // 这一步量的是**标题层级在运行时是不是真的按新口径渲染**：
      // ① 面板标题条（.panel-title）与块内区块标题（h3）**同档**——
      //    改版前是标题条 12.5px、块内 h3 14px，**层级是反的**，而且同一个视觉位置
      //    （面板标题条）有时放 h3、有时放纯文字 ⇒ 同一层级两种字号；
      // ② 这几页出现的**标题字号档数 ≤ 3**（docs/11 §2「一屏字号档数 ≤ 4」的口径，
      //    标题这一族自己再收紧一档：页面 / 区块 / 次级）。
      const sizeOf = (el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10;
      const tiers = new Set();
      let panelSize = -1;
      let blockH3Size = -1;
      let blockH3Seen = 0;
      for (const label of ['世界观档案', '记忆', '规则', 'AI 副驾', '稿件总览']) {
        await tab(label);
        const pt = document.querySelector('.panel-title');
        if (pt !== null) { panelSize = sizeOf(pt); tiers.add(panelSize); }
        for (const el of document.querySelectorAll('h2, h3, h4')) tiers.add(sizeOf(el));
        // 只看**不在面板标题条里**的 h3：条内的 h3 是继承条本身的呈现（那正是本轮的修复）
        const plain = [...document.querySelectorAll('h3')].find((el) => el.closest('.panel-title') === null);
        if (plain !== null && plain !== undefined) { blockH3Size = sizeOf(plain); blockH3Seen += 1; }
      }
      const sameTier = panelSize > 0 && blockH3Size > 0 && panelSize === blockH3Size;
      const tierCount = tiers.size;
      const target = document.querySelector('.panel-title');
      if (target) target.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: sameTier && blockH3Seen > 0 && tierCount > 0 && tierCount <= 3,
        note: '面板标题条=' + panelSize + 'px；块内区块标题(h3，不在标题条里)=' + blockH3Size +
          'px（见到 ' + blockH3Seen + ' 处；同档=' + sameTier + '）' +
          '；这几页出现的标题字号档数=' + tierCount + '（≤3）',
      };
    `,
  },


  {
    step: 78,
    title: 'UI 重构：密度档持久化（切档写进用户级偏好，重开应用仍是这一档）',
    file: 'step78-ui-density-persist.png',
    body: String.raw`
      // 这一步证 R117：密度档**跨会话保留**。
      // 它是**用户级偏好**（存 localStorage，**不进项目真源**）——作者在 A 机器选的密度，
      // 关掉应用再打开还在；而导出 / 迁移时，界面偏好不会被混进作者的作品里。
      const key = 'yushu.ui.density';
      const before = window.localStorage.getItem(key);
      const picker = document.querySelector('.density-picker select');
      if (picker === null) return { ok: false, note: '顶栏里没有密度档选择器' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(picker, 'compact');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      const stored = window.localStorage.getItem(key);
      const applied = document.documentElement.dataset['density'];
      const label = String(picker.options[picker.selectedIndex] ? picker.options[picker.selectedIndex].textContent : '');
      return {
        ok: stored === 'compact' && applied === 'compact',
        note: '切到紧凑：偏好里存的是=' + String(stored) + '；界面生效的是=' + String(applied) +
          '（下拉显示「' + label + '」）；本步之前偏好里是=' + String(before),
      };
    `,
  },


  {
    step: 79,
    title: 'UI 重构第四批余下：空状态的插画真的画在屏上（自绘线稿：24 画布 / 2px 描边 / 不填色）',
    file: 'step79-ui-state-art.png',
    body: String.raw`
      // 这一步证 R118：**空状态的插画真的画出来了**，而且画法守住了口径。
      // 落点选「新建项目 → 融合预演」：还没选派系包时那里就是空态，
      // 而这一步**不需要系统对话框**（选目录是最后一步才要的）⇒ 预演能自动化。
      const newBtn = await waitFor(() => {
        const b = [...document.querySelectorAll('.topbar button')].find((x) => String(x.textContent).indexOf('新建项目') >= 0);
        return b || null;
      }, 10000);
      if (newBtn === null) return { ok: false, note: '顶栏里没有「新建项目」按钮' };
      newBtn.click();
      const art = await waitFor(() => document.querySelector('.state-art'), 15000);
      if (art === null) return { ok: false, note: '进到向导后没看到 .state-art（空态插画）：' + pageText().slice(0, 120) };
      const box = art.closest('.state-note');
      const titleEl = box === null ? null : box.querySelector('.state-note-title');
      const textEl = box === null ? null : box.querySelector('.state-note-text');
      const titleText = titleEl === null ? '' : String(titleEl.textContent || '').trim();
      const noteText = textEl === null ? '' : String(textEl.textContent || '').trim();
      const vb = art.getAttribute('viewBox') || '';
      const sw = art.getAttribute('stroke-width') || '';
      const fill = art.getAttribute('fill') || '';
      const stroke = art.getAttribute('stroke') || '';
      const ok = vb === '0 0 24 24' && sw === '2' && fill === 'none' && stroke === 'currentColor' &&
        titleText.length > 0 && noteText.length > 0;
      const target = box === null ? art : box;
      target.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: ok,
        note: '空态插画在屏上：viewBox=' + vb + ' / 描边=' + sw + ' / 填色=' + fill + ' / 颜色=' + stroke +
          '；标题=「' + titleText + '」；说明=' + noteText.slice(0, 30),
      };
    `,
  },

  {
    step: 80,
    title: 'UI 重构五批总复核：空态插画与文案并排且顶端对齐（不再是孤悬一行）',
    file: 'step80-ui-state-layout.png',
    body: String.raw`
      // 这一步证 R119 的**版式**：插画与文案**并排**、**顶端对齐**。
      // 判据量的是**几何**，不是"有没有插画"——有插画不等于摆对了。
      // 改版前：40px 的插画独占一行（孤悬），文案在下面另起一行 ⇒ 视线要跳两次。
      const art = document.querySelector('.state-art');
      if (art === null) return { ok: false, note: '屏上没有 .state-art（空态插画）' };
      const note = art.closest('.state-note');
      const body = note === null ? null : note.querySelector('.state-note-body');
      if (body === null) return { ok: false, note: '插画不在 .state-note 里，或文案块 .state-note-body 不见了' };
      const a = art.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const dy = Math.abs(a.top - b.top);
      const sideBySide = a.right <= b.left + 1;
      const bigEnough = a.width >= 56;
      const ok = sideBySide && bigEnough && dy <= 4;
      note.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: ok,
        note: '空态版式：插画 ' + Math.round(a.width) + '×' + Math.round(a.height) +
          'px（≥56=' + String(bigEnough) + '）；与文案并排=' + String(sideBySide) +
          '；顶端错位=' + Math.round(dy) + 'px（≤4）；文案在插画右侧=' + String(b.left >= a.right - 1),
      };
    `,
  },

  {
    step: 81,
    title: '世界观档案：世界地图（坐标空间 + 标注 + 图层独立显隐 + 点标注查地点卡）（M5/T5-1，R120）',
    file: 'step81-map.png',
    body: String.raw`
      // 这一步证 R120 的四件事：**坐标空间**（标注落点 = 归一化坐标 × 画布）、
      // **标注**（投影成功才画）、**图层独立显隐**（关一层不影响别的层）、
      // **点标注查地点卡**（K08 §3.7 标注即地点卡）。
      // 另有一条反面证据：指向不存在实体的**孤儿标注不画**，但体检结论要点名它。
      //
      // 先退回项目页：上一步（R119 的 step80）停在「新建项目」向导里，
      // 那里没有标签栏 ⇒ 直接找标签页会抛"找不到标签页"。
      // 取消后落在**欢迎屏**（项目还开着）⇒ R120 给欢迎屏加了「继续当前项目」，点它回去。
      const cancelBtn = [...document.querySelectorAll('button')]
        .find((b) => String(b.textContent || '').trim() === '取消');
      if (cancelBtn) { cancelBtn.click(); await sleep(700); }
      let tabBar = await waitFor(() => (document.querySelector('.tab') ? true : null), 2500);
      if (!tabBar) {
        const contBtn = [...document.querySelectorAll('button')]
          .find((b) => String(b.textContent || '').trim() === '继续当前项目');
        if (contBtn) { contBtn.click(); await sleep(700); }
        tabBar = await waitFor(() => (document.querySelector('.tab') ? true : null), 8000);
      }
      if (!tabBar) return { ok: false, note: '退回项目页后仍找不到标签栏（页面：' + pageText().slice(0, 80) + '）' };
      const cardId = 'loc-map-probe';
      const cardPath = 'world/cards/location/' + cardId + '.md';
      const card = { id: cardId, type: 'location', name: '天启_probe', layer: 'geography' };
      const cardBody = '临时地点卡：只为让世界地图有一个可点的标注。';
      const existingCard = await window.yushu.card.read(cardPath).catch(() => null);
      if (existingCard === null) await window.yushu.card.write({ path: cardPath, card: card, body: cardBody });
      else await window.yushu.card.write({ path: cardPath, card: card, body: cardBody, baseHash: existingCard.hash });

      const yaml = [
        'apiVersion: map-v1',
        'id: map-world',
        'crs: simple',
        'bounds: [[0, 0], [1000, 700]]',
        'base_size: {width: 1000, height: 700}',
        'layers: [place, event]',
        'markers:',
        '  - {id: m-place, layer: place, entity_ref: ' + cardId + ', x: 250, y: 175}',
        '  - {id: m-event, layer: event, entity_ref: ' + cardId + ', x: 750, y: 525}',
        '  - {id: m-orphan, layer: place, entity_ref: loc-does-not-exist, x: 100, y: 100}',
        '',
      ].join('\n');
      const currentMap = await window.yushu.doc.read('world/map.yaml').catch(() => null);
      await window.yushu.doc.write('world/map.yaml', yaml, currentMap === null ? undefined : currentMap.hash);
      const hashBefore = (await window.yushu.doc.read('world/map.yaml')).hash;

      // 面板只在挂载时取数 ⇒ 先去别的页再回来，强制重挂载（R68 的教训）
      await tab('规则');
      await tab('世界观档案');
      const svg = await waitFor(() => document.querySelector('.map-panel .map-svg') || null, 8000);
      if (!svg) return { ok: false, note: '地图 SVG 没渲染（通道未通或没有标注）' };

      const drawn = [...document.querySelectorAll('.map-panel .map-marker')];
      const placeEl = document.querySelector('.map-panel .map-marker[data-marker="m-place"]');
      const eventEl = document.querySelector('.map-panel .map-marker[data-marker="m-event"]');
      const orphanDrawn = document.querySelector('.map-panel .map-marker[data-marker="m-orphan"]') !== null;
      // 位置按 getBBox 的中心量：不同图层的形状不同（地名=圆 / 事件=三角）⇒ 不能只认 circle
      const centerOf = (el) => {
        if (el === null) return { x: -1, y: -1 };
        const box = el.getBBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const placePos = centerOf(placeEl);
      const eventPos = centerOf(eventEl);
      const cx = placePos.x;
      const cy = placePos.y;
      const ecx = eventPos.x;
      const ecy = eventPos.y;
      // 坐标空间：x=250/1000 ⇒ 250；y=175/700 ⇒ 175（归一化 × 画布，正面证据）
      const coordOk = Math.abs(cx - 250) <= 1 && Math.abs(cy - 175) <= 1 && Math.abs(ecx - 750) <= 1 && Math.abs(ecy - 525) <= 1;
      const codes = [...document.querySelectorAll('.map-panel .map-finding-code')].map((el) => String(el.textContent || ''));
      const orphanNamed = codes.indexOf('map-marker-orphan') >= 0;

      // 点标注 ⇒ 地点卡摘要
      if (placeEl) placeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const cardName = await waitFor(() => {
        const el = document.querySelector('.map-panel .map-card-name');
        return el ? String(el.textContent || '').trim() : null;
      }, 3000);

      // 图层独立显隐：关掉「地名」层 ⇒ 只少这一层的标注
      const placeToggle = [...document.querySelectorAll('.map-layer-toggle')]
        .find((b) => String(b.textContent || '').indexOf('地名') >= 0);
      if (placeToggle) placeToggle.click();
      await sleep(400);
      const afterHide = [...document.querySelectorAll('.map-panel .map-marker')].map((el) => String(el.getAttribute('data-marker')));
      const hiddenOk = afterHide.indexOf('m-place') < 0 && afterHide.indexOf('m-event') >= 0;
      const hashAfter = (await window.yushu.doc.read('world/map.yaml')).hash;
      const readonlyOk = hashBefore === hashAfter;
      const panel = document.querySelector('.map-panel');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: drawn.length === 2 && coordOk && orphanDrawn === false && orphanNamed && cardName !== null && cardName.indexOf('天启') >= 0 && hiddenOk && readonlyOk,
        note: '标注数=' + drawn.length + '（孤儿不画=' + String(orphanDrawn === false) + '）' +
          '；坐标：地名=(' + cx + ',' + cy + ') 事件=(' + ecx + ',' + ecy + '）符合归一化×画布=' + String(coordOk) +
          '；体检点名孤儿=' + String(orphanNamed) + '（结论码=' + codes.join('/') + '）' +
          '；点标注出卡=' + String(cardName) +
          '；关掉地名层后剩=' + afterHide.join(',') + '（独立显隐=' + String(hiddenOk) + '）' +
          '；盘上未改=' + String(readonlyOk),
      };
    `,
  },

  {
    step: 82,
    title: '暗色主题：取值实测（正文对比度 ≥ 4.5）+ 开关只改 primitive + 主题是用户级偏好（M5 暗色色板，R121）',
    file: 'step82-dark.png',
    body: String.raw`
      // 这一步证 R121 的三件事：
      // ① **取值实测**（正文对比度从 computed style 现算，不是抄文档里的数字）；
      // ② **切回浅色逐字恢复**（默认色板一个像素都没动）；
      // ③ **主题是用户级偏好**（存 localStorage，**项目真源一个字节都没动**）。
      const themeSelect = document.querySelector('.theme-picker select');
      if (themeSelect === null) return { ok: false, note: '顶栏里没有「主题」下拉' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      // 先把主题**归零为浅色**再取『改前』的底色：主题偏好是用户级的（跨轮留在 localStorage），
      // 不归零的话『改前』本来就是暗的 ⇒ 『逐字恢复』量的其实是两件事。
      setter.call(themeSelect, 'light');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      const body = document.body;
      const beforeBg = getComputedStyle(body).backgroundColor;
      const beforeFg = getComputedStyle(body).color;
      // 盘上取一个真源文件做对照（主题是用户级偏好 ⇒ 真源不该有任何变化）
      const diskFile = await window.yushu.doc.read('world/map.yaml').catch(() => null)
        || await window.yushu.doc.read('world/world.yaml').catch(() => null);
      const hashBefore = diskFile === null ? '' : String(diskFile.hash || '');

      const lum = (rgb) => {
        const m = String(rgb).match(/(\d+(?:\.\d+)?)/g);
        if (!m) return 0;
        const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return 0.2126 * f(Number(m[0]) / 255) + 0.7152 * f(Number(m[1]) / 255) + 0.0722 * f(Number(m[2]) / 255);
      };
      const ratio = (a, b) => {
        const la = lum(a); const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };

      setter.call(themeSelect, 'dark');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      const afterBg = getComputedStyle(body).backgroundColor;
      const afterFg = getComputedStyle(body).color;
      const textRatio = ratio(afterFg, afterBg);
      const dataset = String(document.documentElement.dataset.theme || '');
      const stored = String(window.localStorage.getItem('yushu.ui.theme') || '');
      const changed = afterBg !== beforeBg;

      // 切回浅色：默认色板必须**逐字**恢复
      setter.call(themeSelect, 'light');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      const backBg = getComputedStyle(body).backgroundColor;
      const backFg = getComputedStyle(body).color;
      const restored = backBg === beforeBg && backFg === beforeFg;
      const backStored = String(window.localStorage.getItem('yushu.ui.theme') || '');
      const diskAfter = diskFile === null ? null : await window.yushu.doc.read(diskFile.path).catch(() => null);
      const hashAfter = diskAfter === null ? '' : String(diskAfter.hash || '');
      const diskUntouched = diskFile === null ? true : hashBefore === hashAfter;

      // 回到深色留一张暗色下的截图（证据）
      setter.call(themeSelect, 'dark');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      const panel = document.querySelector('.app');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: changed && textRatio >= 4.5 && dataset === 'dark' && stored === 'dark' && restored && backStored === 'light' && diskUntouched,
        note: '浅色底=' + beforeBg + ' → 深色底=' + afterBg + '（变了=' + String(changed) + '）' +
          '；正文对比度=' + textRatio.toFixed(2) + '（底线 4.5）' +
          '；data-theme=' + dataset + '；偏好存的是=' + stored +
          '；切回浅色逐字恢复=' + String(restored) + '（底=' + backBg + ' 偏好=' + backStored + '）' +
          '；项目真源未动=' + String(diskUntouched) + (diskFile === null ? '（项目里没有可比对的真源文件）' : '（' + diskFile.path + '）'),
      };
    `,
  },

  {
    step: 83,
    title: '明暗对照·浅色基准：世界观档案同一屏（地图面板 + 图谱 + 爽点看板）（R122）',
    file: 'step83-compare-light.png',
    body: String.raw`
      // 这一步与 **step84 成对**：同一屏、同一滚动位置，一个浅色一个深色。
      // 这是 docs/13 §5 明写要的「逐页截图对照」——暗色色板落地后必须拿来看，
      // 不能只靠对比度数字自证。
      const sel = document.querySelector('.theme-picker select');
      if (sel === null) return { ok: false, note: '顶栏里没有「主题」下拉' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'light');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      const theme = String(document.documentElement.dataset.theme || '');
      if (theme !== 'light') return { ok: false, note: '切不到浅色（主题=' + theme + '）' };
      await tab('世界观档案');
      const panel = document.querySelector('.map-panel');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(300);
      return {
        ok: true,
        note: '浅色基准：主题=' + theme + '，底色=' + getComputedStyle(document.body).backgroundColor +
          '，世界观档案同一屏已就位（与 step84 成对）',
      };
    `,
  },
  {
    step: 84,
    title: '明暗对照·深色：同一屏的深色版（R122）',
    file: 'step84-compare-dark.png',
    body: String.raw`
      const sel = document.querySelector('.theme-picker select');
      if (sel === null) return { ok: false, note: '顶栏里没有「主题」下拉' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'dark');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      const theme = String(document.documentElement.dataset.theme || '');
      const bg = getComputedStyle(document.body).backgroundColor;
      const panel = document.querySelector('.map-panel');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(300);
      // 错峰落位：标注应当**已经**全部可见（进场结束后 opacity = 1）
      const markers = [...document.querySelectorAll('.map-panel .map-marker-in')];
      const visible = markers.filter((m) => Number(getComputedStyle(m).opacity) > 0.99).length;
      return {
        ok: theme === 'dark' && markers.length > 0 && visible === markers.length,
        note: '深色对照：主题=' + theme + '，底色=' + bg + '，同一屏已就位（与 step83 成对）' +
          '；标注=' + markers.length + '，全部可见（错峰落位已结束）=' + visible,
      };
    `,
  },

  {
    step: 85,
    title: '世界观档案：世界地图的底图铺在坐标空间上（图片底图 + bounds，K08 §3.6）（M5/T5-1，R123）',
    file: 'step85-map-base.png',
    body: String.raw`
      // 这一步证 R123：**底图**真的被铺在坐标空间上（K08 §3.6：地图 = 图片底图 + bounds）。
      // 底图是作者自己放进项目的一张图（预演替作者放了一张 1×1 的 PNG），
      // 真源 world/map.yaml 用 base_image 记它的相对路径。
      const yaml = [
        'apiVersion: map-v1',
        'id: map-world',
        'crs: simple',
        'bounds: [[0, 0], [1000, 700]]',
        'base_image: world/assets/map/base.png',
        'layers: [place]',
        'markers:',
        '  - {id: m-base, layer: place, entity_ref: loc-map-probe, x: 250, y: 175}',
        '',
      ].join('\n');
      const current = await window.yushu.doc.read('world/map.yaml').catch(() => null);
      await window.yushu.doc.write('world/map.yaml', yaml, current === null ? undefined : current.hash);
      // 面板只在挂载时取数 ⇒ 先去别的页再回来，强制重挂载（R68 的教训）
      await tab('规则');
      await tab('世界观档案');
      const panel = await waitFor(() => document.querySelector('.map-panel') || null, 8000);
      if (panel === null) return { ok: false, note: '地图面板没渲染出来' };
      const img = await waitFor(() => document.querySelector('.map-panel .map-base') || null, 8000);
      if (img === null) return { ok: false, note: '底图没被铺出来（.map-base 不在）' };
      const scrim = document.querySelector('.map-panel .map-scrim');
      const href = String(img.getAttribute('href') || '');
      const w = Number(img.getAttribute('width'));
      const h = Number(img.getAttribute('height'));
      const caption = String((document.querySelector('.map-panel .map-caption') || {}).textContent || '');
      const isDataUrl = href.indexOf('data:image/png') === 0;
      const sized = w === 1000 && h === 700;
      const mentioned = caption.indexOf('world/assets/map/base.png') >= 0;
      panel.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: isDataUrl && sized && scrim !== null && mentioned,
        note: '底图=' + (isDataUrl ? 'data URL（png）' : '（不是 data URL：' + href.slice(0, 24) + '）') +
          '；铺的尺寸=' + w + '×' + h + '（按 bounds 铺满=' + String(sized) + '）' +
          '；压暗层=' + String(scrim !== null) +
          '；caption 点名了底图路径=' + String(mentioned),
      };
    `,
  },

  {
    step: 86,
    title: '世界观档案：地图面板的排版不堆叠（摘要分行、侧栏不挤成窄柱）+ 页面不横向溢出（R124）',
    file: 'step86-map-layout.png',
    body: String.raw`
      // 这一步证 R124 的**排版**：① 摘要按行渲染（不堆成一长串）；② 侧栏没被挤成窄柱
      // （面板在档案页是两栏栅格里的一格 ⇒ 用容器查询换布局）；③ 页面不横向溢出。
      const panel = await waitFor(() => document.querySelector('.map-panel') || null, 8000);
      if (panel === null) return { ok: false, note: '地图面板没渲染出来' };
      const rows = [...document.querySelectorAll('.map-panel .summary-rows .summary-row')];
      // 判**标签列**不被挤歪（值那一列本来就允许折行 ⇒ 整行高度不是判据）
      const tall = rows.filter((r) => {
        const dt = r.querySelector('dt');
        return dt !== null && dt.getBoundingClientRect().height > 28;
      });
      const svg = document.querySelector('.map-panel .map-svg');
      const card = document.querySelector('.map-panel .map-card') || document.querySelector('.map-side');
      const svgW = svg === null ? 0 : svg.getBoundingClientRect().width;
      const sideW = card === null ? 0 : card.getBoundingClientRect().width;
      // 侧栏要么与画布同宽（上下排列），要么本身够宽（左右排列）⇒ 不许是窄柱
      const notAColumn = sideW <= 0 || sideW >= svgW * 0.6 || sideW >= 220;
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const noOverflow = overflow <= 1;
      const panel2 = document.querySelector('.map-panel');
      if (panel2) panel2.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        // 摘要行数**会随功能增长**（R131 加了「事件锚点」那一行）⇒ 断言"至少这么多行"，
        // 不写死个数（写死个数会让"多加一行摘要"这种正经改动反过来把门禁搞红）
        ok: rows.length >= 4 && tall.length === 0 && notAColumn && noOverflow,
        note: '摘要行=' + rows.length + '（每行一行高，换行的=' + tall.length + '）' +
          '；画布宽=' + Math.round(svgW) + 'px，侧栏宽=' + Math.round(sideW) + 'px（不是窄柱=' + String(notAColumn) + '）' +
          '；页面横向溢出=' + overflow + 'px（不溢出=' + String(noOverflow) + '）',
      };
    `,
  },

  {
    step: 87,
    title: '记忆页：卡片不许互相重叠、不许压住文字（用户截图那一片乱的根因，R124）',
    file: 'step87-memory-layout.png',
    body: String.raw`
      // 这一步证 R124 的重点修复：**页面列的容器选择器不能写成后代**。
      // 症状（用户截图）：卡片互相压住、按钮浮在正文上、几段文字叠成一团。
      // 断言：记忆页右列里**任意两张面板的矩形不许相交**，且页面不许横向溢出。
      await tab('记忆');
      await sleep(500);
      const panels = [...document.querySelectorAll('.memory > section > .panel')];
      const boxes = panels
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter((item) => item.box.width > 0 && item.box.height > 0);
      // **内容有没有溢出面板**：面板被压扁时，它自己的矩形仍不相交（只量矩形会漏）
      // ⇒ 内容会探出卡片、压住下一个 ⇒ 要量 scrollHeight 与 clientHeight 的差。
      const spilling = panels.filter((el) => {
        const pb = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const padTop = parseFloat(cs.paddingTop) || 0;
        const padBottom = parseFloat(cs.paddingBottom) || 0;
        const top = pb.top + padTop - 2;
        const bottom = pb.bottom - padBottom + 2;
        return [...el.children].some((ch) => {
          const cb = ch.getBoundingClientRect();
          if (cb.height <= 0) return false;
          return cb.bottom > bottom || cb.top < top;
        });
      });
      const overlaps = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i].box;
          const b = boxes[j].box;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 2 && h > 2) {
            overlaps.push(
              String(boxes[i].el.querySelector('h3')?.textContent || '#' + i).slice(0, 14) +
              ' × ' + String(boxes[j].el.querySelector('h3')?.textContent || '#' + j).slice(0, 14) +
              '（相交 ' + Math.round(w) + '×' + Math.round(h) + 'px）'
            );
          }
        }
      }
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const noOverflow = overflow <= 1;
      const root = document.querySelector('.memory');
      if (root) root.scrollIntoView({ block: 'start' });
      await sleep(250);
      return {
        ok: panels.length > 0 && overlaps.length === 0 && spilling.length === 0 && noOverflow,
        note: '记忆页右列面板=' + panels.length + ' 个，互相重叠=' + overlaps.length +
          '（' + overlaps.join(' | ') + '）' +
          '；内容溢出面板=' + spilling.length + ' 个（' +
          spilling.map((el) => String(el.querySelector('h3')?.textContent || '').slice(0, 12)).join(' | ') + '）' +
          '；页面横向溢出=' + overflow + 'px（不溢出=' + String(noOverflow) + '）',
      };
    `,
  },

  {
    step: 88,
    title: '全应用排版巡检：逐页量面板不相交、内容不溢出、页面不横向溢出（R125）',
    file: 'step88-layout-audit.png',
    body: String.raw`
      // 这一步把"排版不许堆叠"从地图推广到**每一个页面**：逐个标签页量三件事。
      // ① 面板两两不相交；② 面板的**直接子元素**不越出它的内容盒；
      // ③ 页面不横向溢出。
      const TABS = ['起源工作台', '三级大纲', '编辑器', '稿件总览', 'AI 副驾', '记忆', '规则', '导出与自查', '世界观档案', '码字统计', '项目文件'];
      const problems = [];
      const seen = [];
      for (const name of TABS) {
        await tab(name);
        await sleep(450);
        const panels = [...document.querySelectorAll('.panel')].filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        });
        // ① 面板两两不相交
        for (let i = 0; i < panels.length; i += 1) {
          for (let j = i + 1; j < panels.length; j += 1) {
            const a = panels[i].getBoundingClientRect();
            const b = panels[j].getBoundingClientRect();
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 2 && h > 2) {
              problems.push(name + '：面板「' + String(panels[i].querySelector('h3')?.textContent || i).slice(0, 10) +
                '」与「' + String(panels[j].querySelector('h3')?.textContent || j).slice(0, 10) + '」重叠');
            }
          }
        }
        // ② 直接子元素不越出面板的内容盒（面板自带滚动区不算溢出 ⇒ 不看 scrollHeight）
        for (const panel of panels) {
          const pb = panel.getBoundingClientRect();
          const cs = getComputedStyle(panel);
          const padTop = parseFloat(cs.paddingTop) || 0;
          const padBottom = parseFloat(cs.paddingBottom) || 0;
          const top = pb.top + padTop - 2;
          const bottom = pb.bottom - padBottom + 2;
          for (const child of panel.children) {
            const cb = child.getBoundingClientRect();
            if (cb.height <= 0) continue;
            if (cb.bottom > bottom || cb.top < top) {
              problems.push(name + '：面板「' + String(panel.querySelector('h3')?.textContent || '').slice(0, 10) +
                '」的内容越出边界 ' + Math.round(Math.max(bottom - cb.bottom, cb.top - top)) + 'px');
              break;
            }
          }
        }
        // ③ 页面不横向溢出
        const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        if (overflow > 1) problems.push(name + '：页面横向溢出 ' + overflow + 'px');
        seen.push(name + '(' + panels.length + ' 面板)');
      }
      await tab('世界观档案');
      await sleep(300);
      return {
        ok: problems.length === 0,
        note: '巡检 ' + seen.length + ' 个页面：' + seen.join('、') +
          '；问题=' + problems.length + '（' + problems.slice(0, 6).join(' | ') + '）',
      };
    `,
  },

  {
    step: 89,
    title: '世界观档案：面板汇总结构化（标签列共享一行高、值列对齐）+ 孤立节点名单可展开且列全（R126）',
    file: 'step89-summary-rows.png',
    body: String.raw`
      // 这一步证 R126：① 汇总**逐行渲染**，标签列是**共享的一列**（标签永远一行高、值列左边界对齐）；
      // ② 孤立节点名单**可展开且列全**（原先只给前 8 个 + 一个省略号 ⇒ 作者看不到到底哪些没有关系）。
      //
      // 为什么判「标签」而不是整行：值那一列本来就允许折行（值可以很长），整行高度不是判据；
      // 真正会坏的是**标签列被挤歪**（标签折成两行）或者**每行各自定列宽**（值左边界参差）。
      await tab('世界观档案');
      const panel = await waitFor(() => document.querySelector('.graph-panel') || null, 8000);
      if (panel === null) return { ok: false, note: '关系图谱面板没渲染出来' };
      const rows = [...document.querySelectorAll('.graph-panel .summary-row')];
      // ① 标签一行高（不许被挤成两行）
      const tallLabels = rows.filter((r) => {
        const dt = r.querySelector('dt');
        return dt !== null && dt.getBoundingClientRect().height > 28;
      });
      // ② 值列左边界对齐（证明标签列是共享的一列，而不是每行各自定宽）
      const lefts = rows
        .map((r) => {
          const dd = r.querySelector('dd');
          return dd === null ? null : dd.getBoundingClientRect().left;
        })
        .filter((v) => v !== null);
      const aligned = lefts.length > 0 && lefts.every((v) => Math.abs((v ?? 0) - (lefts[0] ?? 0)) <= 1);
      // ③ 值不许越出它那一列（不横向溢出面板）
      const spilling = rows.filter((r) => {
        const dd = r.querySelector('dd');
        if (dd === null) return false;
        return dd.getBoundingClientRect().right > r.getBoundingClientRect().right + 1;
      });
      // ④ 值必须在标签的**右边**（不许上下叠成两行 —— 那种退化的布局，
      //    左边界反而全齐 ⇒ 上面那两条会误绿，得单独堵）
      const stacked = rows.filter((r) => {
        const dt = r.querySelector('dt');
        const dd = r.querySelector('dd');
        if (dt === null || dd === null) return false;
        return dd.getBoundingClientRect().left < dt.getBoundingClientRect().right;
      });
      const disclosure = [...document.querySelectorAll('.graph-panel .disclosure')]
        .find((d) => String(d.textContent || '').indexOf('孤立节点') >= 0) || null;
      const label = disclosure === null ? '' : String(disclosure.textContent || '');
      const m = /孤立节点 (\d+) 个/.exec(label);
      const count = m === null ? -1 : Number(m[1]);
      const btn = disclosure === null ? null : disclosure.querySelector('button');
      if (btn !== null) btn.click();
      await sleep(500);
      const items = [...document.querySelectorAll('.graph-panel .graph-isolated-list li')];
      // 截图要拍到**正在量的那块面板** ⇒ 先把它滚进视口（step86 同款做法）
      panel.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: rows.length >= 4 && tallLabels.length === 0 && aligned &&
          spilling.length === 0 && count > 0 && items.length === count,
        note: '汇总行=' + rows.length + '（标签折行的=' + tallLabels.length + '）' +
          '；值列左边界=' + (lefts.length > 0 ? Math.round(lefts[0] ?? 0) + 'px（对齐=' + String(aligned) + '）' : '无') +
          '；值越列=' + spilling.length +
          '；孤立节点=' + count + ' 个，展开后列出=' + items.length + ' 个（列全=' + String(items.length === count) + '）',
      };
    `,
  },
  {
    step: 90,
    title: '世界观档案：爽点 / 编年史 / 伏笔三个面板的汇总也逐行渲染（标签一行高、值列对齐）（R127）',
    file: 'step90-summary-panels.png',
    body: String.raw`
      // 这一步证 R127：三个面板的汇总**也**换成结构化行（共享组件 SummaryRows）。
      // 量法与 step89 同一套：标签**一行高**、值列**左边界对齐**、值在标签右边、值不越列。
      // 判据落在**运行时**（这三个面板有没有行、标签有没有被挤歪），不是看源码里有没有某个字符串。
      await tab('世界观档案');
      await sleep(600);
      const targets = [
        { name: '爽点', sel: '.satisfaction-panel' },
        { name: '编年史', sel: '.chronology-panel' },
        { name: '伏笔', sel: '.foreshadow-board' },
      ];
      const notes = [];
      let bad = 0;
      for (const target of targets) {
        const panel = document.querySelector(target.sel);
        if (panel === null) {
          notes.push(target.name + '：面板没渲染');
          bad += 1;
          continue;
        }
        const rows = [...panel.querySelectorAll('.summary-row')];
        const tallLabels = rows.filter((r) => {
          const dt = r.querySelector('dt');
          return dt !== null && dt.getBoundingClientRect().height > 28;
        }).length;
        const lefts = rows
          .map((r) => {
            const dd = r.querySelector('dd');
            return dd === null ? null : dd.getBoundingClientRect().left;
          })
          .filter((v) => v !== null);
        const aligned = lefts.length > 0 && lefts.every((v) => Math.abs((v ?? 0) - (lefts[0] ?? 0)) <= 1);
        const stacked = rows.filter((r) => {
          const dt = r.querySelector('dt');
          const dd = r.querySelector('dd');
          if (dt === null || dd === null) return false;
          return dd.getBoundingClientRect().left < dt.getBoundingClientRect().right;
        }).length;
        const spilling = rows.filter((r) => {
          const dd = r.querySelector('dd');
          if (dd === null) return false;
          return dd.getBoundingClientRect().right > r.getBoundingClientRect().right + 1;
        }).length;
        if (rows.length < 3 || tallLabels > 0 || !aligned || stacked > 0 || spilling > 0) bad += 1;
        notes.push(target.name + '：行=' + rows.length + '（标签折行=' + tallLabels +
          '，值列对齐=' + String(aligned) + '，上下叠=' + stacked + '，越列=' + spilling + '）');
      }
      // 截图要拍到正在量的那块面板 ⇒ 滚到第一个有汇总的面板
      const first = document.querySelector('.satisfaction-panel .summary-rows');
      if (first !== null) first.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: bad === 0,
        note: notes.join('；') + '；不合格的面板=' + bad + ' 个',
      };
    `,
  },
  {
    step: 91,
    title: '世界观档案：时间线面板的汇总也逐行渲染（标签一行高、值列对齐）——最后一个自由文本汇总（R128）',
    file: 'step91-timeline-summary.png',
    body: String.raw`
      // 这一步证 R128：时间线面板的汇总也换成结构化行（共享组件 SummaryRows）。
      // 量法与 step89/step90 同一套：标签**一行高**、值列**左边界对齐**、值在标签右边、值不越列。
      await tab('世界观档案');
      await sleep(600);
      const panel = document.querySelector('.timeline-view');
      if (panel === null) return { ok: false, note: '时间线面板没渲染出来' };
      const rows = [...panel.querySelectorAll('.summary-row')];
      const tallLabels = rows.filter((r) => {
        const dt = r.querySelector('dt');
        return dt !== null && dt.getBoundingClientRect().height > 28;
      }).length;
      const lefts = rows
        .map((r) => {
          const dd = r.querySelector('dd');
          return dd === null ? null : dd.getBoundingClientRect().left;
        })
        .filter((v) => v !== null);
      const aligned = lefts.length > 0 && lefts.every((v) => Math.abs((v ?? 0) - (lefts[0] ?? 0)) <= 1);
      const stacked = rows.filter((r) => {
        const dt = r.querySelector('dt');
        const dd = r.querySelector('dd');
        if (dt === null || dd === null) return false;
        return dd.getBoundingClientRect().left < dt.getBoundingClientRect().right;
      }).length;
      const spilling = rows.filter((r) => {
        const dd = r.querySelector('dd');
        if (dd === null) return false;
        return dd.getBoundingClientRect().right > r.getBoundingClientRect().right + 1;
      }).length;
      const text = rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim()).join(' ');
      // 锚定事件与历法套数必须**看得见**（原先藏在那句自由文本里）
      const anchored = /锚定/.test(text) && /Year 0/.test(text);
      const calendars = /历法/.test(text);
      panel.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: rows.length >= 3 && tallLabels === 0 && aligned && stacked === 0 && spilling === 0 && anchored && calendars,
        note: '时间线：行=' + rows.length + '（标签折行=' + tallLabels + '，值列对齐=' + String(aligned) +
          '，上下叠=' + stacked + '，越列=' + spilling + '）；锚定事件看得见=' + String(anchored) +
          '；历法套数看得见=' + String(calendars) + '；汇总="' + text.slice(0, 80) + '"',
      };
    `,
  },
  {
    step: 92,
    title: '深色·柔和高对比：按纸墨底调的一档（底不是纯黑、字不是纯白、描边更明显、对比度现算）（R129）',
    file: 'step92-dark-soft.png',
    body: String.raw`
      // 这一步证 R129（docs/13 §6 明写没做的那条）：深色档下的**柔和高对比**。
      // 系统「高对比度」在深色下是**纯黑底 + 纯白字**（把对比拉到两头），夜里看久了晃眼；
      // 这一档**按纸墨底调**：底还是那张暗纸、字是暖白、描边加重 ⇒ 依然是高对比，但不刺眼。
      //
      // 判据全是**现算**的（computed style + 现算对比度），不是抄文档里的数字：
      // ① 底色**不是纯黑**、字色**不是纯白**（⇒ 柔）；
      // ② 正文对比度仍然很高（⇒ 依然是高对比，不能"柔和"成低对比）；
      // ③ 描边比**默认暗色档**更明显（⇒ 高对比体现在描边上，比的是相对值）；
      // ④ 偏好存的是这一档、切回浅色逐字恢复（⇒ 用户级偏好；默认色板一个像素没动）。
      const themeSelect = document.querySelector('.theme-picker select');
      if (themeSelect === null) return { ok: false, note: '顶栏里没有「主题」下拉' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      const lum = (rgb) => {
        const m = String(rgb).match(/(\d+(?:\.\d+)?)/g);
        if (!m) return 0;
        const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return 0.2126 * f(Number(m[0]) / 255) + 0.7152 * f(Number(m[1]) / 255) + 0.0722 * f(Number(m[2]) / 255);
      };
      const ratio = (a, b) => {
        const la = lum(a); const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      const body = document.body;
      const topbar = document.querySelector('.topbar');
      const lineOf = () => (topbar === null ? '' : getComputedStyle(topbar).borderBottomColor);
      // ① 先量**默认暗色档**的描边（后面要跟柔和高对比那档比）
      setter.call(themeSelect, 'light');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      const lightBg = getComputedStyle(body).backgroundColor;
      setter.call(themeSelect, 'dark');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(350);
      const darkBg = getComputedStyle(body).backgroundColor;
      const darkLine = lineOf();
      const darkLineRatio = ratio(darkLine, darkBg);
      // ② 切到柔和高对比那一档
      setter.call(themeSelect, 'dark-soft');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      const softBg = getComputedStyle(body).backgroundColor;
      const softFg = getComputedStyle(body).color;
      const softLine = lineOf();
      const softLineRatio = ratio(softLine, softBg);
      const textRatio = ratio(softFg, softBg);
      const dataset = String(document.documentElement.dataset.theme || '');
      const stored = String(window.localStorage.getItem('yushu.ui.theme') || '');
      const pureBlack = /^rgb\(0,\s*0,\s*0\)$/.test(String(softBg).trim());
      const pureWhite = /^rgb\(255,\s*255,\s*255\)$/.test(String(softFg).trim());
      // ③ 切回浅色：默认色板必须**逐字**恢复
      setter.call(themeSelect, 'light');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(350);
      const backBg = getComputedStyle(body).backgroundColor;
      const restored = backBg === lightBg;
      const backStored = String(window.localStorage.getItem('yushu.ui.theme') || '');
      // 回到柔和高对比留一张证据截图
      setter.call(themeSelect, 'dark-soft');
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      const panel = document.querySelector('.app');
      if (panel) panel.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: dataset === 'dark-soft' && stored === 'dark-soft' && !pureBlack && !pureWhite &&
          textRatio >= 7 && softLineRatio > darkLineRatio && restored && backStored === 'light',
        note: '底色=' + softBg + '（纯黑=' + String(pureBlack) + '）；字色=' + softFg +
          '（纯白=' + String(pureWhite) + '）；正文对比度=' + textRatio.toFixed(2) + '（底线 7）' +
          '；描边对比度：默认暗色档=' + darkLineRatio.toFixed(2) + ' → 柔和高对比=' + softLineRatio.toFixed(2) +
          '（更明显=' + String(softLineRatio > darkLineRatio) + '）；data-theme=' + dataset +
          '；偏好存的是=' + stored + '；切回浅色逐字恢复=' + String(restored),
      };
    `,
  },
  {
    step: 93,
    title: '世界观档案：事件锚点画在地图上（K08 §3.8 事件挂坐标）+ 锚点挂的是真事件（R131）',
    file: 'step93-map-anchors.png',
    body: String.raw`
      // 这一步证 R131：**事件锚点**（K08 §3.8：事件挂坐标 ⇒ 时空联动）。
      // 判据是**运行时**的：锚点画出来了（.map-anchor）、锚点名单列出来了（.map-anchors li）、
      // 摘要里「事件锚点」那一行数得对，而且**它挂的是真事件**（时间线里能看到同一个 event id）。
      const current = await window.yushu.doc.read('world/map.yaml');
      const anchorBlock = [
        'event_anchors:',
        '  - {id: anchor-war, event_ref: ev-war, x: 500, y: 350}',
        '',
      ].join('\n');
      const next = current.content.indexOf('event_anchors:') >= 0
        ? current.content.replace(/event_anchors:[\s\S]*$/, anchorBlock)
        : current.content.replace(/\n*$/, '\n') + anchorBlock;
      await window.yushu.doc.write('world/map.yaml', next, current.hash);
      // 面板只在挂载时取数 ⇒ 先去别的页再回来，强制重挂载（R68 的教训）
      await tab('规则');
      await tab('世界观档案');
      const panel = await waitFor(() => document.querySelector('.map-panel .map-anchor') || null, 8000);
      if (panel === null) return { ok: false, note: '地图面板里没有画出事件锚点' };
      const drawn = [...document.querySelectorAll('.map-panel .map-anchor')];
      const listed = [...document.querySelectorAll('.map-panel .map-anchors li')];
      const eventRef = drawn[0] === undefined ? '' : String(drawn[0].getAttribute('data-event') || '');
      const rows = [...document.querySelectorAll('.map-panel .summary-row')];
      const anchorRow = rows.find((r) => String((r.querySelector('dt') || {}).textContent || '') === '事件锚点');
      const anchorCount = anchorRow === undefined ? '' : String((anchorRow.querySelector('dd') || {}).textContent || '');
      // 锚点挂的是**真事件**：时间线里能看到同一个 event id
      const timelineText = (document.querySelector('.timeline-view') || {}).textContent || '';
      const onTimeline = timelineText.indexOf(eventRef) >= 0;
      const svg = document.querySelector('.map-panel .map-svg');
      if (svg !== null) svg.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: drawn.length === 1 && listed.length === 1 && anchorCount === '1' && eventRef === 'ev-war' && onTimeline,
        note: '画出的锚点=' + drawn.length + '；名单条目=' + listed.length +
          '；摘要「事件锚点」=' + anchorCount + '；锚点挂的事件=' + eventRef +
          '；时间线里能看到同一个事件=' + String(onTimeline),
      };
    `,
  },
  {
    step: 94,
    title: '世界观档案：时空联动（点锚点跳到事件 / 选事件定位到锚点，K08 §3.8 后半句）（R132）',
    file: 'step94-time-map-link.png',
    body: String.raw`
      // 这一步证 R132 的**双向**联动：
      // ① 地图那边点锚点 ⇒ 时间线里那一行**高亮**（同一件事在两处都看得见）；
      // ② 时间线那边点「地图上有锚点」⇒ 地图**滚到眼前**（作者不用自己找）。
      //
      // 关键：两个方向靠**同一个事件 id**串起来 ⇒ 时间线那行的高亮与地图那锚点的高亮
      // 必须指向**同一个事件**（两套状态会对不上 ⇒ 联动看起来像坏了）。
      await tab('世界观档案');
      await sleep(700);
      // **先把联动状态归零**（R132 补）：失败步骤会自动重试一次，而**上一轮的状态还在**
      // （第一次尝试的最后一步已经点亮了联动）⇒ 第二次尝试会"因为残留状态"而通过
      // ⇒ 变异的点击失效就被盖住了，判据看起来是绿的（实测：这样跑，变异抓不到）。
      // 切走再切回 ⇒ 页面组件重挂载 ⇒ 联动状态回到"还没选"。
      await tab('规则');
      await tab('世界观档案');
      await sleep(700);
      const anchor = await waitFor(() => document.querySelector('.map-panel .map-anchor[data-event]') || null, 8000);
      if (anchor === null) return { ok: false, note: '地图上没有事件锚点（先跑 step93）' };
      const eventRef = String(anchor.getAttribute('data-event') || '');
      // 时间线那一行必须**自带**「地图上有锚点」的入口（父组件知道这个事件在地图上）
      const row = document.querySelector('.timeline-table tr[data-event="' + eventRef + '"]');
      const linkBtn = row === null ? null : row.querySelector('.timeline-map-link');
      if (row === null || linkBtn === null) {
        return { ok: false, note: '时间线里没有事件 ' + eventRef + ' 这一行（或它没有「地图上有锚点」入口）' };
      }
      // ① 点锚点 ⇒ 时间线那一行高亮
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(400);
      const rowLinked = String(row.className || '').indexOf('is-linked') >= 0;
      const anchorLinked = String(anchor.getAttribute('class') || '').indexOf('is-linked') >= 0;
      // ② 点时间线里的入口 ⇒ 地图滚到眼前（作者不用自己找）
      const mapPanel = document.querySelector('.map-panel');
      linkBtn.click();
      await sleep(600);
      const inView = (() => {
        if (mapPanel === null) return false;
        const r = mapPanel.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      })();
      const anchorLinkedAfter = String(anchor.getAttribute('class') || '').indexOf('is-linked') >= 0;
      const svg = document.querySelector('.map-panel .map-svg');
      if (svg !== null) svg.scrollIntoView({ block: 'center' });
      await sleep(200);
      return {
        ok: rowLinked && anchorLinked && inView && anchorLinkedAfter && eventRef !== '',
        note: '事件=' + eventRef +
          '；点锚点后时间线那行高亮=' + String(rowLinked) +
          '；锚点自身高亮=' + String(anchorLinked) +
          '；点时间线入口后地图在视野内=' + String(inView) +
          '；锚点仍高亮（同一件事）=' + String(anchorLinkedAfter),
      };
    `,
  },
  {
    step: 95,
    title: '世界观档案：地点方向的联动（点标注 ⇒ 这个地点在时间线上有哪几条；反过来也跳得过去）（R133）',
    file: 'step95-place-link.png',
    body: String.raw`
      // 这一步证 R133 的**地点**方向（K08 §3.8「点 marker 跳到时间轴对应事件」）：
      // ① 点地图上的标注 ⇒ 面板**旁边**说清「这个地点在时间线上有 N 条事件」（地点卡还开着，不滚走）；
      // ② 时间线那一行给「这个地点在地图上」的入口 ⇒ 点它能跳到地图、那个标注高亮。
      await tab('世界观档案');
      await sleep(700);
      // 先把联动状态归零（R132 的教训：重试路径必须从干净状态起跑）
      await tab('规则');
      await tab('世界观档案');
      await sleep(700);
      // **等时间线的行真的到齐**（不靠固定 sleep）：时间线视图要多扫一遍实体表（R134 的体检）⇒ 到得比以前慢
      await waitFor(() => document.querySelector('.timeline-table tr[data-event]') || null, 8000);
      const marker = await waitFor(() => document.querySelector('.map-panel .map-marker[data-marker]') || null, 8000);
      if (marker === null) return { ok: false, note: '地图上没有标注（先跑 step81）' };
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      const block = document.querySelector('.map-place-events');
      const placeText = block === null ? '' : String(block.textContent || '');
      const eventsOnPlace = /在时间线上有 (\d+) 条事件/.exec(placeText);
      // 点标注 ⇒ 时间线里那一地点的行应当被高亮（两个方向一眼对得上）
      const placeRows = [...document.querySelectorAll('.timeline-table tr.is-linked')];
      const placeLinkBtn = [...document.querySelectorAll('.timeline-table .timeline-map-link')]
        .find((b) => String(b.textContent || '').indexOf('这个地点在地图上') >= 0) || null;
      // 反方向：点时间线里的「这个地点在地图上」⇒ 地图进视野、那个标注高亮
      let mapInView = false;
      let markerLinked = false;
      if (placeLinkBtn !== null) {
        placeLinkBtn.click();
        await sleep(600);
        const mapPanel = document.querySelector('.map-panel');
        mapInView = mapPanel !== null && (() => {
          const r = mapPanel.getBoundingClientRect();
          return r.bottom > 0 && r.top < window.innerHeight;
        })();
        markerLinked = [...document.querySelectorAll('.map-panel .map-marker.is-linked')].length > 0;
      }
      const svg = document.querySelector('.map-panel .map-svg');
      if (svg !== null) svg.scrollIntoView({ block: 'center' });
      await sleep(200);
      // 诊断量：把"到底哪儿没对上"写进证据行（不然只能猜）
      const tlRows = [...document.querySelectorAll('.timeline-table tbody tr')];
      const firstRow = tlRows[0] === undefined ? '' : String(tlRows[0].textContent || '').replace(/\s+/g, ' ').slice(0, 60);
      const markers = [...document.querySelectorAll('.map-panel .map-marker')];
      const markerText = markers[0] === undefined ? '' : String(markers[0].getAttribute('aria-label') || '');
      return {
        ok: block !== null && eventsOnPlace !== null && Number(eventsOnPlace[1]) > 0 &&
          placeRows.length > 0 && placeLinkBtn !== null && mapInView && markerLinked,
        note: '点标注后地图旁说「' + placeText.slice(0, 44) + '」；时间线里高亮的行=' + String(placeRows.length) +
          '；时间线的「这个地点在地图上」入口=' + String(placeLinkBtn !== null) +
          '；点它后地图在视野内=' + String(mapInView) + '；标注高亮=' + String(markerLinked) +
          '｜诊断：时间线行数=' + tlRows.length + '（首行「' + firstRow + '」）' +
          '；标注数=' + markers.length + '（首个「' + markerText + '」）',
      };
    `,
  },
  {
    step: 96,
    title: '世界观档案：place_ref 写错了 id ⇒ 体检结论当场点名（tl-place-orphan）（R134）',
    file: 'step96-place-orphan.png',
    body: String.raw`
      // 这一步证 R134：**引用**了不存在的地点实体，要有一条**体检结论**点名，
      // 而不是只让界面说"地图上没这个地点"（那让人自己猜是不是写错了）。
      //
      // 做法：给另一个事件挂一个**不存在的**地点 id ⇒ 结论里应当出现 tl-place-orphan（error）。
      await tab('世界观档案');
      await sleep(600);
      const current = await window.yushu.doc.read('world/timeline.yaml');
      const next = current.content.indexOf('loc-does-not-exist') >= 0
        ? current.content
        : current.content.replace('  - id: ev-treaty', '  - id: ev-treaty\n    place_ref: loc-does-not-exist');
      await window.yushu.doc.write('world/timeline.yaml', next, current.hash);
      // 面板只在挂载时取数 ⇒ 先去别的页再回来，强制重挂载
      await tab('规则');
      await tab('世界观档案');
      // **等结论真的到齐**（不靠固定 sleep）：时间线视图要多扫一遍实体表 ⇒ 到得比以前慢
      await waitFor(() => document.querySelector('.timeline-view .timeline-finding') || null, 8000);
      await sleep(400);
      const findings = [...document.querySelectorAll('.timeline-view .timeline-finding')];
      const orphan = findings.find((f) => String(f.textContent || '').indexOf('tl-place-orphan') >= 0) || null;
      const isError = orphan !== null && String(orphan.className || '').indexOf('error') >= 0;
      const named = orphan === null ? '' : String(orphan.textContent || '');
      const panel = document.querySelector('.timeline-view');
      if (panel !== null) panel.scrollIntoView({ block: 'center' });
      await sleep(250);
      return {
        ok: orphan !== null && isError && named.indexOf('ev-treaty') >= 0 && named.indexOf('loc-does-not-exist') >= 0,
        note: '结论条数=' + findings.length + '；tl-place-orphan=' + String(orphan !== null) +
          '；是 error=' + String(isError) + '；点名了事件与地点=' + String(named.indexOf('ev-treaty') >= 0 && named.indexOf('loc-does-not-exist') >= 0),
      };
    `,
  },
  {
    step: 97,
    title: '世界观档案：底图登记（挑图 ⇒ 拷进项目 ⇒ 边界按量出来的尺寸自动填）（R135）',
    file: 'step97-map-upload.png',
    fixture: "map-base-dialog",
    body: String.raw`
      // 这一步证 R135 的**作者侧入口**：世界地图面板上有个「登记底图」，
      // 挑一张图 ⇒ 工具把它**拷进项目** ⇒ 并把 base_image / base_size / bounds 写进 map.yaml，
      // **bounds 按量出来的像素尺寸填**（作者手填边界填不对是常态 ⇒ 让工具量）。
      // 原生对话框在主进程被**桩**掉了（预演替作者挑那张 1×1 的 PNG）——桩是工装，**断言断的是盘上的字节**。
      await tab('规则');
      await tab('世界观档案');
      await sleep(700);
      // 先把之前登记的底图三行**去掉**（这一轮验的是"第一次登记"）
      const current = await window.yushu.doc.read('world/map.yaml');
      const stripped = current.content
        .split('\n')
        .filter((line) => !/^base_image:/.test(line) && !/^base_size:/.test(line) && !/^bounds:/.test(line))
        .join('\n');
      await window.yushu.doc.write('world/map.yaml', stripped, current.hash);
      await tab('规则');
      await tab('世界观档案');
      await sleep(800);
      const btn = [...document.querySelectorAll('.map-panel .map-upload-btn')]
        .find((b) => String(b.textContent || '').indexOf('登记底图') >= 0) || null;
      if (btn === null) return { ok: false, note: '地图面板上没有「登记底图」的按钮' };
      btn.click();
      await sleep(1500);
      const note = String((document.querySelector('.map-panel .map-upload-note') || {}).textContent || '');
      const after = await window.yushu.doc.read('world/map.yaml');
      const hasBase = after.content.indexOf('base_image:') >= 0;
      const hasSize = after.content.indexOf('base_size:') >= 0;
      const hasBounds = after.content.indexOf('bounds: [[0, 0], [1, 1]]') >= 0;
      const keptMarkers = after.content.indexOf('entity_ref: loc-map-probe') >= 0;
      // 把地图恢复成"正常"的样子（这张 1×1 的底图只是验登记用的）⇒ 免得后面的截图是一张塌掉的图
      await window.yushu.doc.write('world/map.yaml', current.content, after.hash);
      await tab('规则');
      await tab('世界观档案');
      await sleep(700);
      return {
        ok: hasBase && hasSize && hasBounds && keptMarkers && note.indexOf('底图已登记') >= 0,
        note: '回执「' + note.slice(0, 56) + '」；盘上：base_image=' + String(hasBase) +
          '，base_size=' + String(hasSize) + '，bounds=量出来的 1×1=' + String(hasBounds) +
          '；作者的标注原样留着=' + String(keptMarkers),
      };
    `,
  },
  {
    step: 98,
    title: '世界观档案：换底图（替换那三行、旧图留着、换之前的三行给作者看）（R136）',
    file: 'step98-map-replace.png',
    fixture: "map-base-dialog",
    body: String.raw`
      // 这一步证 R136：**换底图**。R135 只做"第一次登记"（已有登记 ⇒ 拒绝并把该改的三行给作者看）；
      // 这一轮让作者能**一键换**：挑一张新图 ⇒ 那三行被替换 ⇒ **旧的图片文件还在项目里**，
      // 而且**换之前的三行显示在面板上**（他要换回去，把它们贴回去即可）。
      await tab('规则');
      await tab('世界观档案');
      await sleep(700);
      const before = await window.yushu.doc.read('world/map.yaml');
      const beforeLine = (before.content.split('\n').find((l) => l.indexOf('base_image:') === 0) || '');
      const beforePath = beforeLine.replace('base_image: ', '').trim();
      const btn = [...document.querySelectorAll('.map-panel .map-upload-btn')]
        .find((b) => String(b.textContent || '').indexOf('换底图') >= 0) || null;
      if (btn === null) return { ok: false, note: '地图面板上没有「换底图」的按钮' };
      btn.click();
      await sleep(1500);
      const note = String((document.querySelector('.map-panel .map-upload-note') || {}).textContent || '');
      const after = await window.yushu.doc.read('world/map.yaml');
      const afterLine = (after.content.split('\n').find((l) => l.indexOf('base_image:') === 0) || '');
      const afterPath = afterLine.replace('base_image: ', '').trim();
      const changed = afterPath !== '' && afterPath !== beforePath;
      // 旧图**还在项目里**（换错了能改回去）
      let oldKept = false;
      try {
        await window.yushu.doc.read(beforePath);
        oldKept = true;
      } catch (err) {
        oldKept = false;
      }
      // 换之前的三行给作者看
      const snippetShown = document.querySelectorAll('.map-panel .map-upload-snippet').length > 0;
      // 标注原样留着
      const keptMarkers = after.content.indexOf('entity_ref: loc-map-probe') >= 0;
      return {
        ok: changed && oldKept && snippetShown && keptMarkers && note.indexOf('底图已换成') >= 0,
        note: '换之前=' + beforePath + ' → 换之后=' + afterPath + '（换了=' + String(changed) +
          '）；旧图还在=' + String(oldKept) + '；换之前的三行给作者看=' + String(snippetShown) +
          '；标注原样留着=' + String(keptMarkers),
      };
    `,
  },
];

/**
 * 步骤截图（验收证据，复核修复 2026-09-29）：
 * 高负载或窗口被遮挡时（Windows 原生遮挡检测会暂停合成），capturePage 可能抛 UnknownVizError
 * 或**连续返回上一帧**，让"证据"失真（曾出现相邻步骤 PNG 完全相同、step1 缺图沿用旧图）。
 * 加固：每轮先 moveTop 解除遮挡 + 等连续两帧（rAF×2，setTimeout 兜底）确保已绘制，再取样；
 * 与上一张相同则间隔重取，最多 3 轮；3 轮仍相同则如实标注"证据存疑"，不冒充最新画面。
 */
async function captureStep(
  win: BrowserWindow,
  previous: Buffer | null,
): Promise<{ png: Buffer | null; note: string }> {
  const notes: string[] = [];
  let lastPng: Buffer | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (win.isMinimized()) win.restore();
    // **R130**：原先这里是 `win.moveTop();`（注释写的是"被遮挡窗口的合成会被系统暂停 ⇒ 把窗口提到最前"）——
    // 那是在**动作者桌面的窗口层级**（把预演窗口顶到最前）⇒ 作者反馈：预演每次都压住桌面、抢焦点。
    // 现在机器跑法走**离屏渲染**：没有可见窗口 ⇒ **不存在遮挡**，也就没有"提顶层"这一说 ⇒ 这句删掉。
    await win.webContents
      .executeJavaScript(
        "new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(true), 500); })",
      )
      .catch(() => undefined);
    try {
      const png = (await win.capturePage()).toPNG();
      lastPng = png;
      if (!previous || !png.equals(previous)) {
        if (attempt > 1) notes.push(`第 ${attempt} 轮取得新画面`);
        return { png, note: notes.join("；") };
      }
      notes.push(`第 ${attempt} 轮与上一张相同`);
    } catch (err) {
      notes.push(`第 ${attempt} 轮失败（${err instanceof Error ? err.message : String(err)}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!lastPng) return { png: null, note: `失败：${notes.join("；")}` };
  return { png: lastPng, note: `滞后帧（${notes.join("；")}）：已写入但证据存疑` };
}

/**
 * 截图落盘（带重试）：Windows 下刚生成的 PNG 可能被杀软 / 缩略图预览短暂占用，
 * 单次 `writeFile` 会抛 `UNKNOWN: unknown error`。预演跑到一半因证据写入而崩掉是最糟的失败方式，
 * 所以重试 3 轮；仍失败则把「哪一步缺证据」如实上报（缺证据 = 本轮不算通过，不冒充已完成）。
 */
async function writeScreenshot(png: Buffer, rel: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await fs.writeFile(join(repoRoot, rel), png);
      return "";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return `重试 3 轮仍失败（${lastErr}）`;
}

/** 逐步执行：记录 {step,title,ok,detail,screenshot,ms}；失败不中断（前置失败时后续步骤自行报错并说明） */
export async function runWalkthrough(win: BrowserWindow, options: WalkthroughContext): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results: StepResult[] = [];
  const screenshotFailures: string[] = [];
  let lastPng: Buffer | null = null;

  // 暴露编辑器调试句柄（window.__yushuCmView），供 step12 以真实 CodeMirror 事务模拟键入
  await win.webContents.executeJavaScript("window.__yushuDebug = true;");

  console.log(`[walkthrough] 开始：项目目录 ${options.dir}；mock ${options.mock.baseUrl}`);
  for (const def of STEPS) {
    const stepStart = Date.now();
    // 窗口被遮挡时浏览器会**暂停 rAF**、**不插值 CSS 过渡** ⇒ 预演的逐帧采样器采不到中间态
    // （v266 / v267 / v268 实撞：step74「终值对、中间态 0 帧」；同一步的截图还报 UnknownVizError）。
    //
    // **R130 改口径**：原先这里是 `win.setAlwaysOnTop(true); win.moveTop();`——
    // 理由是"预演期间窗口本来就该是屏幕上唯一被看的东西"⇒ 后果是**每次预演都把窗口压在
    // 作者的桌面上、强制置顶、抢焦点**（作者反馈：打游戏时会被顶掉、游戏直接退出）。
    // ⇒ 现在**窗口建在可见桌面之外、且不激活**（见 main.ts 的 `createWindow({ automation: true })`）：
    // 窗口照样在渲染（过渡照插值、截图照取证），但**用户看不到、也拿不到焦点**。
    // 判据没有放松，是环境不对 ⇒ 换环境，不动判据。
    // R111：有的步骤要在「系统要求减少动效」下跑（主进程侧 CDP 模拟——渲染进程改不了自己的媒体查询）。
    // 放在 attempt 循环**外面**：重试时仍在同一个媒体环境里，不会第二次 attempt 换了环境。
    const media = def.emulateReducedMotion === true ? await applyReducedMotion(win, true) : null;
    // R111：有的步骤开跑前要把渲染进程**整个重新载入**（step73 把界面留在欢迎屏，
    // 而欢迎屏没有「返回项目」的入口）。重载后要补设调试标志——它随页面一起没了。
    if (def.reloadBefore === true) {
      const loaded = new Promise<void>((resolve) => {
        win.webContents.once("did-finish-load", () => resolve());
      });
      win.webContents.reload();
      await loaded;
      await win.webContents.executeJavaScript("window.__yushuDebug = true;").catch(() => undefined);
    }
    // 失败步骤最多重试一次（R55，docs/06 §七：step17 / step21 偶发抖动根因未定）。
    // 重试不是为了"跑绿"，而是把抖动变成可审计的记录：flaky 进报告、第一次的失败说明进 detail，
    // 两次都失败仍算失败。真正一次过的步骤 attempts=1、flaky=false，不会被误标。
    const attempts: StepAttempt[] = [];
    while (attempts.length < MAX_STEP_ATTEMPTS) {
      // 需要夹具的步骤：每次 attempt 起一份新的（对话框桩的调用计数复位），跑完立刻还原并删文件
      const fixture =
        def.fixture === "import-dialog"
          ? await openImportDialogFixture(win)
          : def.fixture === "export-dir"
            ? await openExportDirFixture()
            : def.fixture === "map-base-dialog"
              ? await openMapBaseDialogFixture(win, options.dir)
              : null;
      if (fixture) {
        await win.webContents.executeJavaScript(
          `window.__yushuImportFixture = ${JSON.stringify(JSON.stringify({ dir: fixture.dir }))};`,
        );
      }
      try {
        const res = (await win.webContents.executeJavaScript(buildScript(def.body))) as
          | { ok?: boolean; note?: string }
          | null;
        let ok = Boolean(res && res.ok);
        let detail = String(res && res.note ? res.note : "(脚本无返回)");
        // 有盘上核对的步骤：界面上的数字必须被磁盘上的事实二次确认，否则"回执漂亮"不算通过
        if (fixture && "check" in fixture && typeof fixture.check === "function") {
          const checked = await fixture.check();
          ok = ok && checked.ok;
          detail = detail + "；盘上核对=" + checked.detail;
        }
        attempts.push({ ok, detail });
      } catch (err) {
        attempts.push({ ok: false, detail: `执行失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        if (fixture) {
          await fixture.restore();
          await win.webContents.executeJavaScript("delete window.__yushuImportFixture;").catch(() => undefined);
        }
      }
      const last = attempts.at(-1) ?? { ok: false, detail: "(无执行记录)" };
      if (last.ok || attempts.length >= MAX_STEP_ATTEMPTS) break;
      console.log(`[walkthrough] step${def.step} 第 ${attempts.length} 次未过，重试一次：${last.detail.slice(0, 200)}`);
    }
    const outcome = summarizeAttempts(attempts);
    const ok = outcome.ok;
    let detail = outcome.detail;
    const screenshotRel = `${SCREENSHOT_REL_DIR}/${def.file}`;
    const shot = await captureStep(win, lastPng);
    if (shot.png) {
      const writeErr = await writeScreenshot(shot.png, screenshotRel);
      if (writeErr) {
        screenshotFailures.push(`step${def.step}（${def.file}）：${writeErr}`);
        detail += ` ｜截图未落盘：${writeErr}`;
      } else {
        lastPng = shot.png;
      }
    }
    if (shot.note) detail += ` ｜截图：${shot.note}`;
    const ms = Date.now() - stepStart;
    results.push({
      step: def.step,
      title: def.title,
      ok,
      detail,
      screenshot: screenshotRel,
      ms,
      attempts: attempts.length,
      flaky: outcome.flaky,
    });
    console.log(
      `[walkthrough] step${def.step} ${ok ? (outcome.flaky ? "FLAKY" : "OK  ") : "FAIL"} ${ms}ms ` +
        `（执行 ${attempts.length} 次）— ${def.title} :: ${detail}`,
    );
    // 还原媒体环境（放在截图之后：截图要反映这一步真实的运行条件）
    if (media !== null) await media.restore();
  }

  const finishedAt = new Date().toISOString();
  const failures = results.filter((item) => !item.ok);
  const report = {
    mode: "--ui-walkthrough",
    scene: "docs/06-M1验收与自查清单.md §二（9 步）+ M2 编辑器与索引 / M3 AI 与记忆扩展（步骤 10-56）",
    startedAt,
    finishedAt,
    totalMs: Date.now() - t0,
    projectDir: options.dir,
    mockBaseUrl: options.mock.baseUrl,
    screenshotsDir: SCREENSHOT_REL_DIR,
    okCount: results.length - failures.length,
    failCount: failures.length,
    // 抖动如实列出（R55）：第一次未过、重试后才过的步骤。有 flaky 时不得声称"一次通过"。
    flakySteps: results.filter((item) => item.flaky).map((item) => item.step),
    retryPolicy: `失败步骤最多重试 ${MAX_STEP_ATTEMPTS - 1} 次；重试后通过记入 flakySteps（退出码仍为 0，但报告必须留痕）`,
    bypasses: [
      "步骤 1：UI 的存放目录为 readOnly 输入 + 系统对话框，无法自动化；改由主进程等价执行 createProject（与 project:create 同一函数）",
      "步骤 8：该步骤排在编辑器页步骤之前；经 window.yushu.ai.adopt 追加一次含敏感词正文后再走 UI 的「重新核对」",
      "步骤 12 / 16：经 __yushuDebug 暴露的编辑器调试句柄 await reload()（等价于点击已选中章节的强制重载）作为同步点；其后全部经真实 CodeMirror 事务输入与产品 IPC 断言落盘（step16 进一步断言保存后索引自动刷新，全程未点重建按钮）",
      "步骤 22：外部改动经 window.yushu.chapter.write 模拟（等价于外部工具改文件）；三方合并本身走编辑器自动保存的真实冲突管线（无人工干预）",
      "步骤 42：前置数据（带悬空引用的卡）经 window.yushu.card.write 造出——被验的对象是「点真实按钮采纳之后副驾自己长出的轻校验面板」，造数不走 UI 不影响该断言",
      "步骤 55 / 56：原生「选文件」对话框无法自动化——只在主进程把 dialog.showOpenDialog 换成返回固定夹具路径的桩（每次 attempt 重起、跑完还原并删文件；" +
        "选哪份由渲染层 window.__yushuPick 指定，不靠点击次序，重试不串台）。" +
        "产品代码里没有测试分支：面板点击 → import:pick → 闸门登记 → import:preview → 引擎探测/清洗/分章 → 面板渲染全程真实执行；" +
        "被绕过的只有『用户点击对话框』这一层，它由 test/import-ops.test.ts 用注入的假对话框覆盖",
    ],
    notes: [
      "步骤 9 的「林渊」在本预演项目中不存在（第 2 步卡名为占位「测试设定N」），故追加「测试设定」关键词证明检索链路有命中",
    ],
    env: {
      platform: process.platform,
      electron: process.versions["electron"] ?? "",
      chrome: process.versions["chrome"] ?? "",
      node: process.versions["node"] ?? "",
    },
    steps: results,
    failures: failures.map((item) => ({ step: item.step, title: item.title, detail: item.detail })),
    // 缺哪一步的截图证据就写出来：证据不齐全时本轮不得声称通过（不冒充已完成）
    screenshotFailures,
  };
  await fs
    .writeFile(join(repoRoot, SCREENSHOT_REL_DIR, "walkthrough-report.json"), JSON.stringify(report, null, 2), "utf8")
    .catch((err: unknown) => console.error("[walkthrough] 报告写入失败:", err));

  console.log(
    `[walkthrough] 汇总：ok=${report.okCount} fail=${report.failCount} 抖动=${report.flakySteps.length}${
      report.flakySteps.length > 0 ? `[${report.flakySteps.join(",")}]` : ""
    } 总耗时 ${report.totalMs}ms；报告 ${SCREENSHOT_REL_DIR}/walkthrough-report.json`,
  );
  for (const item of failures) console.log(`[walkthrough] 失败 step${item.step}：${item.detail}`);

  options.mock.server.close();
  const evidenceMissing = screenshotFailures.length;
  for (const item of screenshotFailures) console.log(`[walkthrough] 证据缺失 ${item}`);
  console.log(
    `[walkthrough] DONE ok=${report.okCount} fail=${report.failCount} 证据缺失=${evidenceMissing} 抖动=${report.flakySteps.length}`,
  );
  app.exit(failures.length === 0 && evidenceMissing === 0 ? 0 : 1);
}