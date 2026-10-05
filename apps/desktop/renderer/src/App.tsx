import { useEffect, useState } from "react";
import type { AppFlushDonePayload, ProjectSnapshot } from "../../src/shared/ipc";
import { api } from "./api";
import { flushEditorIfAny } from "./editor-flush";
import { ProjectScreen } from "./views/ProjectScreen";
import { WizardView } from "./views/WizardView";

type Screen =
  | { kind: "welcome" }
  | { kind: "wizard" }
  | { kind: "project"; snapshot: ProjectSnapshot };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const [error, setError] = useState<string | null>(null);

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
        <strong className="brand">御书</strong>
        <span className="sub">M1 世界基座</span>
        <span className="spacer" />
        {screen.kind === "project" && <span className="muted path">{screen.snapshot.root}</span>}
        <button onClick={() => setScreen({ kind: "wizard" })}>新建项目</button>
        <button onClick={openExisting}>打开项目</button>
      </header>

      {error && <div className="error-bar">{error}</div>}

      {screen.kind === "welcome" && (
        <div className="welcome">
          <h1>从起源构建世界</h1>
          <p className="muted">
            每一部小说都不单单是一篇文字，而是要创作出另一个世界——文化完整，有历史，有生态，有人文，有地理的完整世界。
          </p>
          <div className="welcome-actions">
            <button className="primary" onClick={() => setScreen({ kind: "wizard" })}>
              新建项目
            </button>
            <button onClick={openExisting}>打开已有项目</button>
          </div>
          <div className="welcome-hint muted">
            新建项目向导：选择派系包（四维多选）→ 查看融合预演 → 确认创建世界
          </div>
        </div>
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