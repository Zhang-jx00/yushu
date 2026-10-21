/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import type { AppFlushDonePayload, ProjectSnapshot } from "../../src/shared/ipc";
import { api } from "./api";
import { BrandMark, BrandWordmark } from "./brand";
import { DENSITIES, loadDensityPref, saveDensityPref, type DensityId } from "./density-prefs";
import { YushuIcon } from "./icons";
import { StateArt } from "./components/StateArt";
import { flushEditorIfAny } from "./editor-flush";
import { ProjectScreen } from "./views/ProjectScreen";
import { WizardView } from "./views/WizardView";

type Screen =
  | { kind: "welcome" }
  | { kind: "wizard" }
  | { kind: "project"; snapshot: ProjectSnapshot };

/**
 * 界面密度档（R109 UI 重构第一轮）。
 *
 * 为什么有这一档：御书是作者**每天坐八小时**的工作台，表格与列表的行高决定了
 * 一屏能看到多少条线索。密度不能只有一种：笔记本小屏要紧凑，大屏要舒展。
 *
 * 三档的**默认档 `cozy` 的取值就是今天的样子**——所以开这个开关**一个像素都不改**，
 * 改版要与"改版前"的截图逐字可比（契约 §2 的纪律）。紧凑/宽松是**给作者的选择**，
 * 不是我们替作者定的默认值。
 *
 * **本轮只做会话内**（不落盘）：写进项目真源要新增一条 IPC 与一份配置，
 * 而"界面偏好"算不算项目内容还没定论——先把三档做对、看得见，再决定要不要持久化。
 */

/**
 * 欢迎屏 = **开屏**（R109 UI 重构第一轮）。
 *
 * 单独拆成一个组件，是为了"入场状态"**每次挂载都是新的**：
 * 写在 App 里的话，从向导退回欢迎屏时那个状态还留着（`entered` 已是 true），
 * 类名一上来就是 `is-entered` ⇒ **过渡根本没跑**（预演 step72 抓到的就是这条）。
 *
 * 入场用**过渡**而不是 @keyframes（契约 §5 把 @keyframes 锁在 1——"不做全站入场表演"）：
 * 下一帧再切到"已入场"，浏览器才认得出这是一次**状态变化**，过渡才会跑。
 */
function WelcomeScreen(props: { onNewProject: () => void; onOpenExisting: () => void }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={`welcome ${entered ? "is-entered" : ""}`.trim()}>
      <div className="welcome-mark">
        <BrandMark size={56} className="welcome-mark-svg" />
      </div>
      <h1>从起源构建世界</h1>
      <p className="muted">
        每一部小说都不单单是一篇文字，而是要创作出另一个世界——文化完整，有历史，有生态，有人文，有地理的完整世界。
      </p>
      <div className="welcome-actions">
        <button className="primary" onClick={props.onNewProject}>
          新建项目
        </button>
        <button onClick={props.onOpenExisting}>打开已有项目</button>
      </div>
      <div className="welcome-hint muted">
        新建项目向导：选择派系包（四维多选）→ 查看融合预演 → 确认创建世界
      </div>
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState<DensityId>(() => loadDensityPref(window.localStorage));

  useEffect(() => {
    document.documentElement.dataset["density"] = density;
    // 持久化（R117）：密度档是**用户级偏好**，存 localStorage（不进项目真源，
    // 导出/迁移时不会把界面偏好混进作者的作品里）
    saveDensityPref(window.localStorage, density);
  }, [density]);

  // 挂载时同步主进程已挂载的项目（正常启动返回 null；UI 预演模式直接进入项目页）
  useEffect(() => {
    let alive = true;
    api()
      .project.current()
      .then((snapshot) => {
        if (alive && snapshot) setScreen({ kind: "project", snapshot });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 关闭窗口前 flush（T2-6 完整版）：主进程拦截窗口 close 后请求落盘；
  // 无论成败都必须回执（失败 = 冻结等场景由超时兜底，不阻塞用户关闭）。
  useEffect(() => {
    const off = api().app.onBeforeClose(() => {
      void (async () => {
        let payload: AppFlushDonePayload = { editorFlushed: false };
        try {
          const outcome = await flushEditorIfAny();
          payload = {
            editorFlushed: outcome.hadEditor,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          };
        } catch (err) {
          payload = { editorFlushed: false, error: err instanceof Error ? err.message : String(err) };
          console.error("关闭前 flush 失败（不阻塞关闭，内容保持现状）:", err);
        } finally {
          try {
            api().app.flushDone(payload);
          } catch {
            /* 窗口可能已在销毁：回执失败等价于由超时兜底 */
          }
        }
      })();
    });
    return off;
  }, []);

  const openExisting = async () => {
    try {
      setError(null);
      const snapshot = await api().project.open();
      if (snapshot) setScreen({ kind: "project", snapshot });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <BrandWordmark size={20} />
        <span className="sub">M1 世界基座</span>
        <span className="spacer" />
        {screen.kind === "project" && <span className="muted path">{screen.snapshot.root}</span>}
        <label className="density-picker">
          <span className="density-label">界面密度</span>
          <select
            value={density}
            aria-label="界面密度"
            onChange={(event) => setDensity(event.target.value as DensityId)}
          >
            {DENSITIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setScreen({ kind: "wizard" })}>新建项目</button>
        <button onClick={openExisting}>打开项目</button>
      </header>

      {error && (
        <div className="error-bar">
          <StateArt kind="error" size={16} />
          <YushuIcon name="circle-x" size={14} />
          <span>{error}</span>
        </div>
      )}

      {screen.kind === "welcome" && (
        <WelcomeScreen
          onNewProject={() => setScreen({ kind: "wizard" })}
          onOpenExisting={openExisting}
        />
      )}

      {screen.kind === "wizard" && (
        <WizardView
          onCancel={() => setScreen({ kind: "welcome" })}
          onCreated={(snapshot) => setScreen({ kind: "project", snapshot })}
        />
      )}

      {screen.kind === "project" && <ProjectScreen snapshot={screen.snapshot} />}
    </div>
  );
}