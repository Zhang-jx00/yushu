import { app, session, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AxisValues } from "../shared/ipc.js";
import { repoRoot } from "./paths.js";
import {
  buildScript,
  prepareProjectForDir,
  startMockOpenAI,
  type MockOpenAI,
} from "./walkthrough.js";

/**
 * A0 验收的机器替代：`--ui-trial[=<baseDir>]`。
 *
 * 用 3 组「虚拟用户画像」（新人 / 连载中 / 老作者）各自独立走完 M1 验收场景的 8 步 + 索引加分项，
 * 逐步截图（docs/assets/m1-preview/trial/），并做网络审计证明「除 AI（本地 mock）外零外网请求」：
 * 对 win.webContents.session.webRequest.onBeforeRequest 挂监听，收集全部请求并分类
 * （rendererExternal = host 非 127.0.0.1/localhost），期望 rendererExternal === 0。
 *
 * 允许的两处绕过（与 --ui-walkthrough 同源，必须在报告 bypasses 中注明）：
 * ① 存放目录为 readOnly + 系统对话框 → 主进程 createProject；② 第 8 步追加敏感词正文。
 * 其余步骤全部经真实 UI 操作（executeJavaScript 驱动 DOM + capturePage 截图），绝不直接调业务 API 冒充。
 */

const TRIAL_SCREENSHOT_REL_DIR = "docs/assets/m1-preview/trial";
const TRIAL_PACK_ID = "xuanhuan-xitong";
const TRIAL_AXES: AxisValues = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};
/** mock 分块间隔：留出窗口以便 U3 的「停止生成」能截到中途 */
const MOCK_CHUNK_DELAY_MS = 120;
const STEP_COUNT = 9;

interface TrialUserSpec {
  id: string;
  profile: string;
  title: string;
  /** 起源工作台前 5 步「名称」字段填写的卡名（第 4 个为主角名，索引检索用） */
  cardNames: string[];
  volumeCount: number;
  chaptersPerVolume: number;
  adoptMode: "replace" | "append";
  /** 第 4 步的差异化前置：none / 填细纲 / 改章标题 */
  outlinePreAction: "none" | "brief" | "rename";
  /** 第 5 步：是否在首个增量后立即停止生成 */
  stopMidStream: boolean;
  includeToc: boolean;
  clipboard: "none" | "ai" | "both";
}

const USERS: TrialUserSpec[] = [
  {
    id: "U1",
    profile: "新人",
    title: "天启界",
    cardNames: ["天启大陆", "灵气法则", "青云山脉", "林渊", "天启编年"],
    volumeCount: 3,
    chaptersPerVolume: 10,
    adoptMode: "replace",
    outlinePreAction: "none",
    stopMidStream: false,
    includeToc: true,
    clipboard: "none",
  },
  {
    id: "U2",
    profile: "连载中",
    title: "赤霄界",
    cardNames: ["赤霄界", "归墟法则", "落霞关", "顾长歌", "大衍纪"],
    volumeCount: 4,
    chaptersPerVolume: 6,
    adoptMode: "append",
    outlinePreAction: "brief",
    stopMidStream: false,
    includeToc: true,
    clipboard: "ai",
  },
  {
    id: "U3",
    profile: "老作者",
    title: "九幽界",
    cardNames: ["九幽界", "噬灵诀要", "寒鸦渡", "谢无咎", "烬余录"],
    volumeCount: 2,
    chaptersPerVolume: 8,
    adoptMode: "replace",
    outlinePreAction: "rename",
    stopMidStream: true,
    includeToc: false,
    clipboard: "both",
  },
];

interface TrialStepResult {
  step: number;
  title: string;
  ok: boolean;
  detail: string;
  screenshot: string;
  ms: number;
}

interface TrialUserReport {
  id: string;
  profile: string;
  projectDir: string;
  steps: TrialStepResult[];
  okCount: number;
  failCount: number;
}

interface NetworkAudit {
  rendererTotal: number;
  rendererLocal: number;
  rendererExternal: number;
  externalUrls: string[];
}

interface StepDef {
  step: number;
  title: string;
  slug: string;
  body: string;
}

const q = (value: unknown): string => JSON.stringify(value);

/** 解析 `--ui-trial[=<baseDir>]`；缺省 baseDir = D:\Temp\yushu-trial */
export function parseTrialDir(arg: string): string {
  const eq = arg.indexOf("=");
  const value = eq >= 0 ? arg.slice(eq + 1).trim() : "";
  return value === "" ? "D:\\Temp\\yushu-trial" : value;
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** 请求分类：本机（含 file/data/blob/devtools）计 local，其余 host 计 external */
function auditNetwork(urls: string[]): NetworkAudit {
  let local = 0;
  const externalUrls: string[] = [];
  for (const url of urls) {
    let external = false;
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol;
      if (
        scheme === "file:" ||
        scheme === "data:" ||
        scheme === "blob:" ||
        scheme === "devtools:" ||
        scheme === "chrome-extension:"
      ) {
        external = false;
      } else {
        external = !isLocalHost(parsed.hostname);
      }
    } catch {
      external = false;
    }
    if (external) externalUrls.push(url);
    else local += 1;
  }
  return {
    rendererTotal: urls.length,
    rendererLocal: local,
    rendererExternal: externalUrls.length,
    externalUrls,
  };
}

function outlinePreActionBody(mode: TrialUserSpec["outlinePreAction"]): string {
  if (mode === "brief") {
    return `
      const li = document.querySelector('.chapter-list li:first-child');
      if (!li) return { ok: false, note: '找不到第 1 章纲条目：' + pageText() };
      const toggle = [...li.querySelectorAll('button')].find((b) => b.textContent.includes('细纲'));
      if (!toggle) return { ok: false, note: '找不到「细纲」按钮：' + lines(li) };
      toggle.click();
      const briefBox = await waitFor(() => li.querySelector('.brief-grid'), 8000);
      if (!briefBox) return { ok: false, note: '细纲未展开：' + lines(li) };
      const briefInputs = briefBox.querySelectorAll('label.field input');
      if (briefInputs.length < 3) return { ok: false, note: '细纲字段不足（期望 ≥3）：' + briefInputs.length };
      setV(briefInputs[0], '顾长歌');
      setV(briefInputs[2], '夺回落霞关');
      await sleep(200);`;
  }
  if (mode === "rename") {
    return `
      const li = document.querySelector('.chapter-list li:first-child');
      const titleInput = li ? li.querySelector('input.chapter-title') : null;
      if (!titleInput) return { ok: false, note: '找不到第 1 章标题输入框：' + pageText() };
      setV(titleInput, '第一章 烬余');
      await sleep(200);`;
  }
  return `/* 无差异化前置 */`;
}

/** 第 5 步：普通流式生成 / 首个增量后立即停止 */
function aiStreamBody(user: TrialUserSpec): string {
  const head = `
      await tab('AI 副驾');
      const label = await waitFor(() => [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('启用 AI 调用')), 15000);
      if (!label) return { ok: false, note: '找不到「启用 AI 调用」复选框：' + pageText() };
      const cb = label.querySelector('input');
      if (cb && !cb.checked) { cb.click(); await sleep(200); }
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始生成');
        return b && !b.disabled ? b : null;
      }, 20000);
      if (!btn) return { ok: false, note: '「开始生成」不可用（provider 未就绪 / 无目标）：' + pageText() };
      btn.click();`;

  if (!user.stopMidStream) {
    return `${head}
      const done = await waitFor(() => {
        const c = document.querySelector('.candidate');
        return c && c.textContent.trim() !== '' && document.body.innerText.includes('生成完成') ? true : null;
      }, 25000);
      const cand = document.querySelector('.candidate');
      const text = cand ? cand.textContent : '';
      return { ok: done === true && text.trim() !== '', note: '候选文本=' + JSON.stringify(text.slice(0, 60)) + '（长度 ' + text.length + '，含「生成完成」=' + (done === true) + '）' };`;
  }

  return `${head}
      const first = await waitFor(() => {
        const c = document.querySelector('.candidate');
        const t = c ? c.textContent : '';
        return t && t !== '（等待首个增量…）' && t !== '（尚无候选内容）' ? true : null;
      }, 20000, 20);
      const stopBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '停止生成');
      const stopClicked = Boolean(stopBtn);
      if (stopBtn) { stopBtn.click(); await sleep(30); }
      const finished = await waitFor(() => {
        const t = document.body.innerText;
        return t.includes('已停止（保留已生成部分）') || t.includes('生成完成') ? true : null;
      }, 25000);
      const cand = document.querySelector('.candidate');
      const text = cand ? cand.textContent : '';
      const aborted = document.body.innerText.includes('已停止（保留已生成部分）');
      const mid = stopClicked && aborted;
      return {
        ok: finished === true && text.trim() !== '',
        note: '首个增量后停止（点击=' + stopClicked + '，中途停止=' + aborted + '）' + (mid ? '' : '｜停止未截到中途（流已结束）') + '；候选=' + JSON.stringify(text.slice(0, 60)) + '（长度 ' + text.length + '）',
      };`;
}

function buildSteps(user: TrialUserSpec): StepDef[] {
  const adoptModeLabel = user.adoptMode === "replace" ? "整段采纳（替换正文）" : "追加到正文";
  const adoptNotice = user.adoptMode === "replace" ? "已替换采纳" : "已追加采纳";
  const searchEntity = user.cardNames[3] ?? "";

  return [
    {
      step: 1,
      title: "进入项目页（project:current 自动）",
      slug: "project",
      body: `
      const el = await waitFor(() => document.querySelector('.tabs'), 25000);
      if (!el) return { ok: false, note: '未自动进入项目页：' + pageText() };
      const path = document.querySelector('.topbar .path');
      return { ok: true, note: '项目页已就绪，标签 ' + document.querySelectorAll('.tab').length + ' 个；root=' + (path ? path.textContent : '(未显示)') };`,
    },
    {
      step: 2,
      title: "起源工作台逐步建档 5 张设定卡",
      slug: "genesis",
      body: `
      const names = ${q(user.cardNames)};
      for (let i = 0; i < names.length; i += 1) {
        const form = await waitFor(() => document.querySelector('.step-form'), 10000);
        if (!form) return { ok: false, note: '第 ' + (i + 1) + ' 张卡：找不到 .step-form ｜ ' + pageText() };
        const field = form.querySelector('input, textarea');
        if (!field) return { ok: false, note: '第 ' + (i + 1) + ' 张卡：表单无输入框' };
        setV(field, names[i]);
        const btn = [...form.querySelectorAll('button')].find((b) => b.textContent.includes('保存并继续'));
        if (!btn) return { ok: false, note: '第 ' + (i + 1) + ' 张卡：找不到「保存并继续」按钮' };
        btn.click();
        const done = await waitFor(
          () => (document.querySelectorAll('.step-item.done').length >= i + 1 ? document.querySelectorAll('.step-item.done').length : null),
          15000,
        );
        if (done === null) {
          return { ok: false, note: '第 ' + (i + 1) + ' 张卡保存未生效（已完成 ' + document.querySelectorAll('.step-item.done').length + '）：' + lines(document.querySelector('.wizard-foot')) };
        }
        await sleep(120);
      }
      const counter = document.querySelector('.genesis aside .panel-title');
      const counterText = lines(counter);
      const doneCount = document.querySelectorAll('.step-item.done').length;
      return { ok: doneCount >= 5 && counterText.includes('已建卡 5 张'), note: '已完成步骤 ' + doneCount + ' / 5；计数文本：' + counterText };`,
    },
    {
      step: 3,
      title: "三级大纲一键生成骨架",
      slug: "outline",
      body: `
      await tab('三级大纲');
      const vc = ${user.volumeCount};
      const cpc = ${user.chaptersPerVolume};
      const scale = await waitFor(() => document.querySelectorAll('.outline-scale input[type=number]'), 15000);
      if (!scale || scale.length < 2) return { ok: false, note: '找不到卷数/每卷章数输入框：' + pageText() };
      setV(scale[0], String(vc));
      await sleep(150);
      setV(scale[1], String(cpc));
      await sleep(150);
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('.outline button')].find((x) => x.textContent.includes('一键生成骨架'));
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!btn) return { ok: false, note: '「一键生成骨架」不可用（模板可能未加载）：' + pageText() };
      btn.click();
      const count = await waitFor(
        () => (document.querySelectorAll('.volume-list li').length > 0 ? document.querySelectorAll('.volume-list li').length : null),
        20000,
      );
      if (count === null) return { ok: false, note: '未出现卷纲列表：' + pageText() };
      return { ok: count === vc, note: '卷纲 ' + count + ' 条（期望 ' + vc + ' 卷 × ' + cpc + ' 章）；当前卷章纲 ' + document.querySelectorAll('.chapter-list li').length + ' 条' };`,
    },
    {
      step: 4,
      title: "章纲一键创建草稿章节（回填 chapter_id）",
      slug: "chapter",
      body: `
      await tab('三级大纲');
      const first = await waitFor(() => document.querySelector('.volume-list li'), 12000);
      if (!first) return { ok: false, note: '找不到卷纲条目：' + pageText() };
      first.click();
      await sleep(300);
      ${outlinePreActionBody(user.outlinePreAction)}
      const saveBtn = [...document.querySelectorAll('.outline-foot button')].find((b) => b.textContent.includes('保存大纲'));
      if (saveBtn && !saveBtn.disabled) { saveBtn.click(); await sleep(900); }
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
      return { ok: true, note: '草稿章节已创建，章纲显示「草稿章节已建」（chapter_id 已回填）' };`,
    },
    {
      step: 5,
      title: "AI 副驾开启开关并流式生成候选",
      slug: "ai",
      body: aiStreamBody(user),
    },
    {
      step: 6,
      title: `采纳候选（${user.adoptMode === "replace" ? "替换正文" : "追加到正文"}）并留痕`,
      slug: "adopt",
      body: `
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${q(adoptModeLabel)}));
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!btn) return { ok: false, note: '采纳按钮「${adoptModeLabel}」不可用：' + pageText() };
      btn.click();
      const expect = ${q(adoptNotice)};
      const ok = await waitFor(() => {
        const t = document.body.innerText;
        const u = document.querySelector('.usage-list');
        const ut = u ? u.innerText : '';
        return t.includes(expect) && ut.includes('生成') && ut.includes('采纳') ? true : null;
      }, 15000);
      const usageText = lines(document.querySelector('.usage-list'));
      return { ok: ok === true, note: '采纳回执含「' + expect + '」=' + (ok === true) + '；使用记录：' + usageText.slice(0, 160) };`,
    },
    {
      step: 7,
      title: "导出与自查：确认导出 TXT + 字数对账",
      slug: "export",
      body: `
      await tab('导出与自查');
      const wantToc = ${user.includeToc};
      const tocLabel = await waitFor(() => [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('包含目录页')), 15000);
      if (!tocLabel) return { ok: false, note: '找不到「包含目录页」复选框：' + pageText() };
      const tocCb = tocLabel.querySelector('input');
      if (tocCb && tocCb.checked !== wantToc) { tocCb.click(); await sleep(200); }
      const chk = await waitFor(() => document.querySelector('.confirm-check input[type=checkbox]'), 15000);
      if (!chk) return { ok: false, note: '找不到防手滑确认复选框：' + pageText() };
      if (!chk.checked) { chk.click(); await sleep(200); }
      const btn = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('确认导出 TXT'));
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!btn) return { ok: false, note: '「确认导出 TXT」不可用：' + pageText() };
      btn.click();
      const done = await waitFor(() => (document.body.innerText.includes('已导出') ? true : null), 25000);
      const text = document.body.innerText;
      const matched = text.includes('✓ 一致');
      const mismatch = text.includes('✗ 失配');
      const clipMode = ${q(user.clipboard)};
      let clipOk = true;
      let clipNote = '未执行复制';
      if (clipMode !== 'none') {
        const aiLabel = [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('去除 AI 标识'));
        const comLabel = [...document.querySelectorAll('label.checkbox')].find((l) => l.textContent.includes('去除注释'));
        if (clipMode === 'both' && comLabel) { const c = comLabel.querySelector('input'); if (c && !c.checked) { c.click(); await sleep(150); } }
        if (aiLabel) { const a = aiLabel.querySelector('input'); if (a && !a.checked) { a.click(); await sleep(150); } }
        const copyBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('复制干净正文'));
        if (copyBtn && !copyBtn.disabled) {
          copyBtn.click();
          const prev = await waitFor(() => document.querySelector('.clip-preview'), 20000);
          clipOk = prev !== null;
          clipNote = '剪贴板预览=' + (prev !== null) + '（'+clipMode+'）';
        } else {
          clipOk = false;
          clipNote = '「复制干净正文」不可用';
        }
      }
      return {
        ok: done === true && matched && !mismatch && clipOk,
        note: '导出回执=' + (done === true) + '；对账全一致=' + matched + '；失配=' + mismatch + '；目录页勾选=' + wantToc + '；' + clipNote,
      };`,
    },
    {
      step: 8,
      title: "敏感词自查（追加含敏感词正文 → 重新核对 → 命中定位）",
      slug: "sensitive",
      body: `
      await tab('导出与自查');
      const st = await window.yushu.outline.read();
      const vol = st.doc.volumes[0];
      const chap = vol.chapters.find((c) => c.chapter_id) || vol.chapters[0];
      await window.yushu.ai.adopt({
        usageId: 'trial',
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
      };`,
    },
    {
      step: 9,
      title: "项目文件：重建索引 + 实体检索（加分项）",
      slug: "index",
      body: `
      await tab('项目文件');
      const rebuild = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重建索引'));
        return b && !b.disabled ? b : null;
      }, 15000);
      if (!rebuild) return { ok: false, note: '找不到「重建索引」按钮：' + pageText() };
      rebuild.click();
      const built = await waitFor(() => (document.body.innerText.includes('已构建') ? true : null), 30000);
      const input = await waitFor(() => document.querySelector('.dir-row input'), 12000);
      if (!input) return { ok: false, note: '找不到检索输入框：' + pageText() };
      const searchBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '检索');
      if (!searchBtn) return { ok: false, note: '找不到「检索」按钮' };
      setV(input, ${q(searchEntity)});
      await sleep(250);
      searchBtn.click();
      const panel = await waitFor(() => document.querySelector('.search-results'), 20000);
      const entityHits = document.querySelectorAll('.search-results li strong').length;
      const header = panel ? lines(panel).slice(0, 80) : '无结果面板';
      return {
        ok: built === true && panel !== null && entityHits >= 1,
        note: '索引状态含「已构建」=' + (built === true) + '；检索「' + ${q(searchEntity)} + '」实体命中 ' + entityHits + '；' + header,
      };`,
    },
  ];
}

async function capture(win: BrowserWindow, rel: string): Promise<void> {
  const image = await win.capturePage();
  await fs.writeFile(join(repoRoot, rel), image.toPNG());
}

export interface RunTrialOptions {
  baseDir: string;
  /** 复用 main.ts 的建窗函数（加载构建产物 / dev server） */
  createWindow: () => BrowserWindow;
}

export async function runTrial(options: RunTrialOptions): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const mock: MockOpenAI = await startMockOpenAI(MOCK_CHUNK_DELAY_MS);

  // 网络审计：窗口创建前挂监听（defaultSession，与 createWindow 同会话），收集全部请求
  const requestedUrls: string[] = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    requestedUrls.push(details.url);
    callback({});
  });

  await fs.mkdir(join(repoRoot, TRIAL_SCREENSHOT_REL_DIR), { recursive: true });

  const users: TrialUserReport[] = [];

  for (const spec of USERS) {
    const dir = join(options.baseDir, spec.id);
    const userReport: TrialUserReport = {
      id: spec.id,
      profile: spec.profile,
      projectDir: dir,
      steps: [],
      okCount: 0,
      failCount: 0,
    };
    let win: BrowserWindow | null = null;
    try {
      await prepareProjectForDir({
        dir,
        title: spec.title,
        packIds: [TRIAL_PACK_ID],
        axes: TRIAL_AXES,
        mock,
        logPrefix: `[trial:${spec.id}]`,
      });
      const created = options.createWindow();
      win = created;
      await new Promise<void>((resolve, reject) => {
        created.webContents.once("did-finish-load", () => resolve());
        created.webContents.once("did-fail-load", (_event, code, desc) =>
          reject(new Error(`renderer 加载失败：${code} ${desc}`)),
        );
      });
      console.log(`[trial:${spec.id}] 窗口已加载，开始 ${STEP_COUNT} 步（profile=${spec.profile}）`);

      for (const def of buildSteps(spec)) {
        const stepStart = Date.now();
        let ok = false;
        let detail = "";
        try {
          const res = (await created.webContents.executeJavaScript(buildScript(def.body))) as
            | { ok?: boolean; note?: string }
            | null;
          ok = Boolean(res && res.ok);
          detail = String(res && res.note ? res.note : "(脚本无返回)");
        } catch (err) {
          detail = `执行失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const rel = `${TRIAL_SCREENSHOT_REL_DIR}/${spec.id}-step${def.step}-${def.slug}.png`;
        try {
          await capture(created, rel);
        } catch (err) {
          detail += ` ｜截图失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const ms = Date.now() - stepStart;
        userReport.steps.push({ step: def.step, title: def.title, ok, detail, screenshot: rel, ms });
        console.log(
          `[trial:${spec.id}] step${def.step} ${ok ? "OK  " : "FAIL"} ${ms}ms — ${def.title} :: ${detail}`,
        );
      }
    } catch (err) {
      const detail = `窗口/前置失败：${err instanceof Error ? err.message : String(err)}`;
      console.error(`[trial:${spec.id}] ${detail}`);
      const rel = `${TRIAL_SCREENSHOT_REL_DIR}/${spec.id}-load-failure.png`;
      if (win && !win.isDestroyed()) {
        await capture(win, rel).catch(() => undefined);
      }
      for (const def of buildSteps(spec)) {
        if (userReport.steps.some((item) => item.step === def.step)) continue;
        userReport.steps.push({ step: def.step, title: def.title, ok: false, detail, screenshot: rel, ms: 0 });
      }
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }

    userReport.okCount = userReport.steps.filter((item) => item.ok).length;
    userReport.failCount = userReport.steps.length - userReport.okCount;
    users.push(userReport);
    console.log(`[trial:${spec.id}] 汇总 ok=${userReport.okCount} fail=${userReport.failCount}`);
  }

  const networkAudit = auditNetwork(requestedUrls);
  const failedSteps = users.flatMap((user) =>
    user.steps.filter((item) => !item.ok).map((item) => `${user.id}-step${item.step}：${item.detail}`),
  );
  const allComplete = users.every((user) => user.failCount === 0 && user.steps.length === STEP_COUNT);
  const finishedAt = new Date().toISOString();

  const bypasses = [
    "步骤 1（各组）：UI 的存放目录为 readOnly 输入 + 系统对话框，无法自动化；改由主进程等价执行 createProject（与 project:create 同一函数）",
    "步骤 8（各组）：M1 尚无正文编辑器；经 window.yushu.ai.adopt 追加一次含敏感词正文后再走 UI 的「重新核对」",
  ];
  const notes = [
    "三组共用同一本地 mock（仅覆盖 Chat Completions/SSE，base_url 见 mockBaseUrl）；分块间隔 120ms 便于 U3 截到中途停止",
    "第 2 步卡名按验收表顺序写入起源工作台前 5 步的「名称」字段（第 4 步落在生态层）；第 9 步实体检索依据卡名（与字段语义无关）",
    "U3 第 5 步在首个增量出现后立即点「停止生成」；若流已结束则在 detail 中如实记录「停止未截到中途」",
    "renderer 全部经 IPC，零外网；唯一联网为 AI 生成——由主进程 fetch 指向本次 mock 的 127.0.0.1 地址，不经过 renderer session",
  ];

  const report = {
    mode: "--ui-trial",
    startedAt,
    finishedAt,
    totalMs: Date.now() - t0,
    mockBaseUrl: mock.baseUrl,
    screenshotsDir: TRIAL_SCREENSHOT_REL_DIR,
    users,
    summary: { users: USERS.length, allComplete, failedSteps },
    networkAudit,
    bypasses,
    notes,
    env: {
      platform: process.platform,
      electron: process.versions["electron"] ?? "",
      chrome: process.versions["chrome"] ?? "",
      node: process.versions["node"] ?? "",
    },
  };

  await fs
    .writeFile(
      join(repoRoot, TRIAL_SCREENSHOT_REL_DIR, "trial-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    )
    .catch((err: unknown) => console.error("[trial] 报告写入失败:", err));

  const okTotal = users.reduce((sum, user) => sum + user.okCount, 0);
  const failTotal = users.reduce((sum, user) => sum + user.failCount, 0);
  console.log(
    `[trial] 汇总：users=${USERS.length} allComplete=${allComplete} ok=${okTotal} fail=${failTotal} 总耗时 ${report.totalMs}ms`,
  );
  console.log(
    `[trial] 网络审计：rendererTotal=${networkAudit.rendererTotal} local=${networkAudit.rendererLocal} external=${networkAudit.rendererExternal} externalUrls=${JSON.stringify(networkAudit.externalUrls)}`,
  );
  console.log(`[trial] mock base_url=${mock.baseUrl}（主进程 fetch 仅指向该 127.0.0.1 地址）`);
  for (const line of failedSteps) console.log(`[trial] 失败 ${line}`);
  console.log(`[trial] 报告 ${TRIAL_SCREENSHOT_REL_DIR}/trial-report.json`);

  mock.server.close();
  const exitCode = allComplete && networkAudit.rendererExternal === 0 ? 0 : 1;
  console.log(`[trial] DONE users=${USERS.length} allComplete=${allComplete} external=${networkAudit.rendererExternal}`);
  app.exit(exitCode);
}