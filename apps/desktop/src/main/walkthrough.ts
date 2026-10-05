import { BrowserWindow, app } from "electron";
import { existsSync, promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLM_API_VERSION, LLM_FORMAT_VERSION, serializeLlmConfig } from "@yushu/llm";
import { LLM_CONFIG_PATH } from "@yushu/world-engine";
import type { AxisValues } from "../shared/ipc.js";
import { attachProject } from "./ipc.js";
import { repoRoot } from "./paths.js";
import { createProject } from "./project-ops.js";

/**
 * M1 验收场景（docs/06 §二）的 UI 自动化预演（`--ui-walkthrough[=<目录>]`）。
 *
 * 目的：用应用自身的 Electron 能力（executeJavaScript 驱动 DOM + capturePage 截图）走完场景，
 * 为真人 30 分钟试跑打磨流程并产出截图证据（docs/assets/m1-preview/）；
 * 步骤 10-18 为 M2 扩展（双形态 / 实体提及 / 自动保存 / 写作视图 / 索引增量与保存即增量 / 本地快照 / 码字统计）。
 *
 * 明确的两处绕过（其余步骤全部经真实 UI 操作）：
 * 1. 第 1 步「新建项目」的存放目录在 UI 中是 readOnly 输入 + 系统对话框（无法自动化）——
 *    改由主进程等价执行 createProject（与 project:create 同一函数），预演从「项目已创建」开始；
 * 2. 第 8 步需要正文中出现敏感词，而该步骤排在编辑器页步骤之前——经 window.yushu.ai.adopt 追加一次正文。
 */

export interface MockOpenAI {
  server: Server;
  baseUrl: string;
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

/** 本地 mock OpenAI（Chat Completions + SSE）：预演不依赖外网与真实 key（与 e2e 同款） */
export async function startMockOpenAI(delayMs = 2): Promise<MockOpenAI> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = ["天启", "界的", "夜色"];
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
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
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
        kind: "openai-compatible",
        base_url: mock.baseUrl,
        model: "mock-model",
      },
    ],
  });
  await fs.mkdir(join(dir, "config"), { recursive: true });
  await fs.writeFile(join(dir, LLM_CONFIG_PATH), llmYaml, "utf8");

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
        try { r = fn(); } catch (e) { r = null; }
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
        ok: built === true && panel !== null && hits !== null,
        note: '索引状态含「已构建」=' + (built === true) + '；「林渊」结果：' + first + '；「测试设定」命中行数=' + (hits === null ? 0 : hits),
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
      const m = text.match(/增量：复用 (\d+) · 更新 (\d+) · 移除 (\d+) 个文件/);
      const reused = m ? Number(m[1]) : -1;
      const updated = m ? Number(m[2]) : -1;
      return {
        ok: reused > 0 && updated >= 0,
        note: '增量回执=' + (m ? m[0] : '(未匹配)') + '；复用>0=' + (reused > 0) + '；更新=' + updated,
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

/** 逐步执行：记录 {step,title,ok,detail,screenshot,ms}；失败不中断（前置失败时后续步骤自行报错并说明） */
export async function runWalkthrough(win: BrowserWindow, options: WalkthroughContext): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results: StepResult[] = [];
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
      await fs.writeFile(join(repoRoot, screenshotRel), shot.png);
      lastPng = shot.png;
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
    scene: "docs/06-M1验收与自查清单.md §二（9 步）+ M2 编辑器与索引扩展（步骤 10-18）",
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
  };
  await fs
    .writeFile(join(repoRoot, SCREENSHOT_REL_DIR, "walkthrough-report.json"), JSON.stringify(report, null, 2), "utf8")
    .catch((err: unknown) => console.error("[walkthrough] 报告写入失败:", err));

  console.log(
    `[walkthrough] 汇总：ok=${report.okCount} fail=${report.failCount} 总耗时 ${report.totalMs}ms；报告 ${SCREENSHOT_REL_DIR}/walkthrough-report.json`,
  );
  for (const item of failures) console.log(`[walkthrough] 失败 step${item.step}：${item.detail}`);

  options.mock.server.close();
  console.log(`[walkthrough] DONE ok=${report.okCount} fail=${report.failCount}`);
  app.exit(failures.length === 0 ? 0 : 1);
}