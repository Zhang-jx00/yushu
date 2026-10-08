import { BrowserWindow, app } from "electron";
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
}

interface StepDef {
  step: number;
  title: string;
  file: string;
  body: string;
}

const SCREENSHOT_REL_DIR = "docs/assets/m1-preview";

/** T3-10 设定抽取 mock：抽取请求（系统提示含任务契约 id）返回固定候选——示例覆盖新增 / 补充 / 冲突三类 */
const EXTRACT_MOCK_CANDIDATES = {
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

const STEPS: StepDef[] = [
  {
    step: 1,
    title: "进入项目页（App 自动加载已挂载项目）",
    file: "step1-project.png",
    body: String.raw`
      const el = await waitFor(() => document.querySelector('.tabs'), 20000);
      if (!el) return { ok: false, note: '未自动进入项目页：' + pageText() };
      const path = document.querySelector('.topbar .path');
      return { ok: true, note: '项目页已就绪，标签 ' + document.querySelectorAll('.tab').length + ' 个；root=' + (path ? path.textContent : '(未显示)') };
    `,
  },
  {
    step: 2,
    title: "起源工作台逐步建档 5 张设定卡",
    file: "step2-genesis.png",
    body: String.raw`
      for (let i = 1; i <= 5; i += 1) {
        const form = await waitFor(() => document.querySelector('.step-form'), 10000);
        if (!form) return { ok: false, note: '第 ' + i + ' 张卡：找不到 .step-form ｜ ' + pageText() };
        const field = form.querySelector('input, textarea');
        if (!field) return { ok: false, note: '第 ' + i + ' 张卡：表单无输入框' };
        setV(field, '测试设定' + i);
        const btn = [...form.querySelectorAll('button')].find((b) => b.textContent.includes('保存并继续'));
        if (!btn) return { ok: false, note: '第 ' + i + ' 张卡：找不到「保存并继续」按钮' };
        btn.click();
        const done = await waitFor(
          () => (document.querySelectorAll('.step-item.done').length >= i ? document.querySelectorAll('.step-item.done').length : null),
          12000,
        );
        if (done === null) {
          const foot = document.querySelector('.wizard-foot');
          return { ok: false, note: '第 ' + i + ' 张卡保存未生效（已完成 ' + document.querySelectorAll('.step-item.done').length + '）：' + lines(foot) };
        }
        await sleep(120);
      }
      const counter = document.querySelector('.genesis aside .panel-title');
      return {
        ok: document.querySelectorAll('.step-item.done').length >= 5,
        note: '已完成步骤 ' + document.querySelectorAll('.step-item.done').length + ' / 5；计数文本：' + lines(counter),
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
    title: "导出与自查：确认导出 TXT + 字数对账",
    file: "step7-export.png",
    body: String.raw`
      await tab('导出与自查');
      const chk = await waitFor(() => document.querySelector('.confirm-check input[type=checkbox]'), 15000);
      if (!chk) return { ok: false, note: '找不到防手滑确认复选框：' + pageText() };
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
      item.click();
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
      const press = (key) => tiptap.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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
      press('ArrowDown');
      await sleep(150);
      const activeIdx = [...document.querySelectorAll('.mention-menu li')].findIndex((li) => li.className.includes('on'));
      press('Enter');
      const keyboardInserted = await waitFor(
        () => (fullCount() === fullBefore + 1 && atCount() === fullCount() && document.querySelector('.mention-menu') === null ? true : null),
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
          allCount >= 5 && escClosed === true && cleaned && fiveItems !== null && activeIdx === 1 &&
          keyboardInserted === true && clickInserted === true && cmHasNew && panelSynced && decorated >= 2 && menuShot,
        note:
          '空查询候选=' + allCount + '；Esc 关闭=' + escClosed + '；键盘路径（↓ 高亮第 ' + (activeIdx + 1) + ' 项后回车）插入=' + (keyboardInserted === true) +
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
      target.click();
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
        const list = document.querySelector('.assembly-drop');
        return list && list.innerText.includes('budget') ? list.innerText : null;
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
      asmBtn.click();
      const previewLine = await waitFor(() => document.querySelector('.assembly-preview'), 12000);
      if (!previewLine) return { ok: false, note: '组装预演未返回：' + pageText() };
      await sleep(150);
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
        note: '预览器条目=' + rows.length + '（表头五列=' + headerOk + '；命中键含「天启界」=' + matchedKeys + '）' +
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
    // 被遮挡窗口的合成会被系统暂停：把窗口提到最前，迫使渲染进程继续出帧
    win.moveTop();
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
    let ok = false;
    let detail = "";
    try {
      const res = (await win.webContents.executeJavaScript(buildScript(def.body))) as
        | { ok?: boolean; note?: string }
        | null;
      ok = Boolean(res && res.ok);
      detail = String(res && res.note ? res.note : "(脚本无返回)");
    } catch (err) {
      detail = `执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
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
    results.push({ step: def.step, title: def.title, ok, detail, screenshot: screenshotRel, ms });
    console.log(`[walkthrough] step${def.step} ${ok ? "OK  " : "FAIL"} ${ms}ms — ${def.title} :: ${detail}`);
  }

  const finishedAt = new Date().toISOString();
  const failures = results.filter((item) => !item.ok);
  const report = {
    mode: "--ui-walkthrough",
    scene: "docs/06-M1验收与自查清单.md §二（9 步）+ M2 编辑器与索引 / M3 AI 与记忆扩展（步骤 10-39）",
    startedAt,
    finishedAt,
    totalMs: Date.now() - t0,
    projectDir: options.dir,
    mockBaseUrl: options.mock.baseUrl,
    screenshotsDir: SCREENSHOT_REL_DIR,
    okCount: results.length - failures.length,
    failCount: failures.length,
    bypasses: [
      "步骤 1：UI 的存放目录为 readOnly 输入 + 系统对话框，无法自动化；改由主进程等价执行 createProject（与 project:create 同一函数）",
      "步骤 8：该步骤排在编辑器页步骤之前；经 window.yushu.ai.adopt 追加一次含敏感词正文后再走 UI 的「重新核对」",
      "步骤 12 / 16：经 __yushuDebug 暴露的编辑器调试句柄 await reload()（等价于点击已选中章节的强制重载）作为同步点；其后全部经真实 CodeMirror 事务输入与产品 IPC 断言落盘（step16 进一步断言保存后索引自动刷新，全程未点重建按钮）",
      "步骤 22：外部改动经 window.yushu.chapter.write 模拟（等价于外部工具改文件）；三方合并本身走编辑器自动保存的真实冲突管线（无人工干预）",
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
    `[walkthrough] 汇总：ok=${report.okCount} fail=${report.failCount} 总耗时 ${report.totalMs}ms；报告 ${SCREENSHOT_REL_DIR}/walkthrough-report.json`,
  );
  for (const item of failures) console.log(`[walkthrough] 失败 step${item.step}：${item.detail}`);

  options.mock.server.close();
  const evidenceMissing = screenshotFailures.length;
  for (const item of screenshotFailures) console.log(`[walkthrough] 证据缺失 ${item}`);
  console.log(
    `[walkthrough] DONE ok=${report.okCount} fail=${report.failCount} 证据缺失=${evidenceMissing}`,
  );
  app.exit(failures.length === 0 && evidenceMissing === 0 ? 0 : 1);
}