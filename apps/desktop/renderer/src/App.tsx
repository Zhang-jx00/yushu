import { useEffect, useState } from "react";
import type { ProjectSnapshot } from "../../src/shared/ipc";
import { api } from "./api";
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