import { useCallback, useEffect, useState } from "react";
import type { CardSummary, WorldSummary } from "../../../src/shared/ipc";
import { api } from "../api";
import { GENESIS_STEPS, buildCardBody } from "../genesis-steps";

/** 起源工作台（T1-6）：引导式问卷脚手架——逐步建档、可跳过、可稍后补充 */
export function GenesisView() {
  const [world, setWorld] = useState<WorldSummary | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [doneSteps, setDoneSteps] = useState<string[]>([]);
  const [skippedSteps, setSkippedSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [worldSummary, cardList] = await Promise.all([
      api().project.world(),
      api().card.list(),
    ]);
    setWorld(worldSummary);
    setCards(cardList);
  }, []);

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  const step = GENESIS_STEPS[stepIndex];
  if (!step) return null;

  const values = answers[step.key] ?? {};
  const layerClosed = world ? world.layers[step.layer] === false : false;
  const nameFieldLabel = step.fields.find((f) => f.key === step.nameField)?.label ?? "名称";

  const setValue = (key: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [step.key]: { ...(prev[step.key] ?? {}), [key]: value } }));

  const saveStep = async () => {
    const name = (values[step.nameField] ?? "").trim();
    if (!name) {
      setError(`请填写「${nameFieldLabel}」后再保存`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().card.write({
        card: {
          type: step.type,
          name: name.slice(0, 30),
          layer: step.layer,
          visibility: "hidden",
          extensions: { answers: values },
        },
        body: buildCardBody(step, values),
      });
      setDoneSteps((prev) => [...new Set([...prev, step.key])]);
      setSkippedSteps((prev) => prev.filter((k) => k !== step.key));
      setNotice(
        `已创建设定卡 → ${result.path}${
          result.warnings.length > 0 ? `（告警：${result.warnings.join("；")}）` : ""
        }`,
      );
      await refresh();
      setStepIndex((index) => Math.min(index + 1, GENESIS_STEPS.length - 1));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const skipStep = () => {
    setSkippedSteps((prev) => [...new Set([...prev, step.key])]);
    setNotice(`已跳过「${step.title}」，可在「世界观档案」中随时补充`);
    setStepIndex((index) => Math.min(index + 1, GENESIS_STEPS.length - 1));
  };

  return (
    <div className="genesis">
      <aside>
        <div className="panel-title">
          <span className="muted">世界构建层级</span>
          <span className="muted">已建卡 {cards.length} 张</span>
        </div>
        <ol className="stepper">
          {GENESIS_STEPS.map((item, index) => {
            const closed = world ? world.layers[item.layer] === false : false;
            const state = doneSteps.includes(item.key)
              ? "done"
              : skippedSteps.includes(item.key)
                ? "skipped"
                : "";
            return (
              <li
                key={item.key}
                className={[
                  "step-item",
                  index === stepIndex ? "on" : "",
                  state,
                  closed ? "closed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setStepIndex(index)}
              >
                <span className="dot">{state === "done" ? "✓" : index + 1}</span>
                <span>{item.title}</span>
                {closed && <span className="muted">（本层已关闭）</span>}
                {state === "skipped" && <span className="muted">已跳过</span>}
              </li>
            );
          })}
        </ol>
        <div className="muted pad">目标：≥5 张设定卡（M1 验收基线）</div>
      </aside>

      <section>
        <div className="wizard-head">
          <h2>{step.title}</h2>
          <span className="muted">{step.intro}</span>
        </div>

        {layerClosed ? (
          <div className="panel">
            <p className="muted">
              该层在当前世界配置中已关闭（world.yaml 的 layers.{step.layer} = false）。
              可在项目文件中开启后回来补充，或直接跳过本步。
            </p>
            <button type="button" onClick={skipStep}>
              跳过本步
            </button>
          </div>
        ) : (
          <div className="panel step-form">
            {step.fields.map((field) => (
              <label className="field" key={field.key}>
                <span>
                  {field.label}
                  {field.required ? "（必填）" : "（可留空，稍后补充）"}
                </span>
                {field.multiline ? (
                  <textarea
                    rows={3}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                ) : (
                  <input
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                )}
              </label>
            ))}
            <div className="wizard-foot">
              <button type="button" className="primary" onClick={saveStep} disabled={busy}>
                {busy ? "保存中…" : "保存并继续 →"}
              </button>
              <button type="button" onClick={skipStep} disabled={busy}>
                跳过（稍后补充）
              </button>
              {notice && <span className="muted">{notice}</span>}
              {error && <span className="error-text">{error}</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}