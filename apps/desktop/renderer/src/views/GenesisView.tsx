/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState } from "react";
import type { CardSummary, LibraryViewPayload, WorldSummary } from "../../../src/shared/ipc";
import { api } from "../api";
import { GENESIS_STEPS, buildCardBody } from "../genesis-steps";

/** 设定卡目标张数（M1 验收基线：≥5 张） */
const GOAL_CARDS = 5;

/**
 * **快捷起点**（R146）：作者最卡的不是"填表"，是"从哪开始"。
 * 四个起点各给一句**能直接改**的样板文字 ⇒ 点一下落到那句话的输入框里，
 * 由作者改完再填进表单（**不自动保存**——真源只接受作者确认过的东西）。
 */
const KICKOFF_STARTERS: Array<{ label: string; text: string }> = [
  { label: "起一个事件", text: "混沌中第一缕灵光开天，天柱断裂，碎片坠为人间九城" },
  { label: "起一个人物", text: "守着一盏不肯灭的旧灯的少年，把自己的名字押进了天柱裂缝" },
  { label: "起一场冲突", text: "两族立约百年，盟书却被换成了同一枚血印" },
  { label: "起一座城", text: "潮水每天退到城外三百步，退潮时能看见沉在海底的旧钟" },
];

/** 起源工作台（T1-6）：引导式问卷脚手架——逐步建档、可跳过、可稍后补充 */
export function GenesisView(props: { onNavigate?: (tab: string) => void }) {
  const [world, setWorld] = useState<WorldSummary | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  /** R147：稿件总览（算"接下来做什么"要用：哪些章写完了、这本书多大了） */
  const [library, setLibrary] = useState<LibraryViewPayload | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [doneSteps, setDoneSteps] = useState<string[]>([]);
  const [skippedSteps, setSkippedSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** R146：一句话开局（作者还没想好怎么开局的草稿） */
  const [kickoff, setKickoff] = useState("");

  const refresh = useCallback(async () => {
    const [worldSummary, cardList, libraryView] = await Promise.all([
      api().project.world(),
      api().card.list(),
      // 稿件总览取不到（还没建大纲等）**不许把整屏拖垮** ⇒ 降级成 null，其余照常
      api().library.list().catch(() => null),
    ]);
    setWorld(worldSummary);
    setCards(cardList);
    setLibrary(libraryView);
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

  /**
   * R146：把那句话填进**当前步的必填字段**。
   * **不自动保存** —— 真源只接受作者确认过的东西（与 AI 候选化的口径一致）。
   */
  const fillKickoff = () => {
    const text = kickoff.trim();
    if (text === "") return;
    const target = step.fields.find((field) => field.required) ?? step.fields[0];
    if (!target) return;
    setValue(target.key, text);
    setNotice(`已填进「${target.label}」—— 改一改再保存也行`);
  };

  const kickoffTargetLabel = step.fields.find((field) => field.required)?.label ?? "名称";
  const progressPct = Math.min(100, Math.round((cards.length / GOAL_CARDS) * 100));

  /**
   * R149：**右栏「产物与工具」**（学 TRAE SOLO 的三栏：左=正在进行的任务 / 中=主工作区 / 右=产物与工具）。
   *
   * 这一栏只放**真产物**（作者刚建好的卡、已经写出来的章）与**去哪儿**（跳到对应页），
   * 全部从**真源现算** —— 不摆装饰性的卡片。
   */
  const recentCards = cards.slice(-5).reverse();
  const writtenChapters = (library?.chapters ?? [])
    .filter((chapter) => chapter.chapterPath !== null && chapter.wordCount > 0)
    .slice(-3)
    .reverse();

  /**
   * R147：**「接下来做什么」三条** —— 全部从**真源现算**（卡列表 + 稿件总览），不是写死的文案。
   *
   * 为什么要有这一段：AI 工具的主页除了"入口"，还会告诉你**下一步**与**最近的产物**
   * （TRAE SOLO 左栏是"正在进行的任务"）⇒ 作者打开软件时最需要的不是一张空表单，
   * 而是"我该接着做什么"。写死的文案没有用（那不是他的书）⇒ 三条都要现算。
   */
  const builtLayers = new Set(cards.map((card) => card.layer));
  const nextStep = GENESIS_STEPS.find((item) => !builtLayers.has(item.layer)) ?? null;
  const nextLayerText =
    nextStep !== null
      ? `下一层是「${nextStep.title}」—— ${nextStep.intro}`
      : "九层都建过了 ⇒ 去看看稿子，或者回头补一补已建的层";
  const draftedChapters = (library?.chapters ?? []).filter(
    (chapter) => chapter.chapterPath !== null && chapter.wordCount > 0,
  );
  const lastDrafted = draftedChapters[draftedChapters.length - 1] ?? null;
  const continueText =
    lastDrafted !== null
      ? `接着写《${lastDrafted.title}》（已 ${String(lastDrafted.wordCount)} 字）`
      : "还没建草稿 —— 从大纲里挑一章开始写";
  const bookText =
    library === null
      ? "正在读这本书的规模…"
      : `${String(library.totals.chapters)} 章 · 已建草稿 ${String(library.totals.drafted)} · 共 ${String(library.totals.words)} 字`;

  return (
    <div className="genesis">
      <aside>
        <div className="panel-title">
          <span className="muted">世界构建层级</span>
          <span className="muted">已建卡 {cards.length} 张</span>
        </div>
        {/* R146：**进度看得见**（AI 工具的主页都有上下文/进度条 ——
            "我建了多少、还差多少"不该只靠一行小字）。 */}
        <div className="genesis-progress">
          <div
            className="genesis-progress-bar"
            role="progressbar"
            aria-label="设定卡进度"
            aria-valuemin={0}
            aria-valuemax={GOAL_CARDS}
            aria-valuenow={cards.length}
          >
            <span style={{ width: `${String(progressPct)}%` }} />
          </div>
          <span className="muted">
            设定卡 {cards.length} / {GOAL_CARDS}
          </span>
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
              >
                {/* 键盘可达（R110）：清单行是**真按钮**（照记忆页的约定），
                    选中态用 aria-current 标出——"只有鼠标能碰到"在本项目是债。 */}
                <button
                  type="button"
                  aria-current={index === stepIndex ? "true" : undefined}
                  onClick={() => setStepIndex(index)}
                >
                  <span className="dot">{state === "done" ? "✓" : index + 1}</span>
                  <span>{item.title}</span>
                  {closed && <span className="muted">（本层已关闭）</span>}
                  {state === "skipped" && <span className="muted">已跳过</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="muted pad">目标：≥5 张设定卡（M1 验收基线）</div>
      </aside>

      <section>
        <div className="wizard-head">
          <h3>{step.title}</h3>
          <span className="muted">{step.intro}</span>
        </div>

        {/* R146：**一句话开局**（学 AI 工具的主页：**入口是主角**，不是一堆表单）。
            作者最卡的是"从哪开始" ⇒ 给一个一句话的入口 + 四个常用起点；
            它**只是把这句话填进下面这一步的必填字段**，不自动保存（真源只收作者确认过的）。 */}
        <div className="genesis-kickoff">
          <div className="genesis-kickoff-head">
            <strong>这本书从哪里开始？</strong>
            <span className="muted">写一句话就行 —— 它会自动填进下面这一步的「{kickoffTargetLabel}」</span>
          </div>
          <div className="genesis-kickoff-row">
            <input
              value={kickoff}
              placeholder="如：混沌中第一缕灵光开天，天柱断裂化为九城"
              onChange={(event) => setKickoff(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  fillKickoff();
                }
              }}
            />
            <button type="button" className="primary" onClick={fillKickoff} disabled={kickoff.trim() === ""}>
              用这句话开局
            </button>
          </div>
          <div className="genesis-kickoff-starts">
            {KICKOFF_STARTERS.map((starter) => (
              <button
                key={starter.label}
                type="button"
                className="genesis-starter"
                onClick={() => setKickoff(starter.text)}
                title={starter.text}
              >
                {starter.label}
              </button>
            ))}
          </div>
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

        {/* R147：**「接下来做什么」** —— 三条都从真源现算（不是写死的文案）。
            AI 工具的主页除了"入口"，还会告诉你**下一步**与**最近的产物**
            （TRAE SOLO 左栏就是"正在进行的任务"）⇒ 作者打开软件时最需要的
            不是一张空表单，而是"我该接着做什么"。 */}
        <div className="genesis-next">
          <div className="panel-title">
            <span className="muted">接下来做什么</span>
          </div>
          <ul className="genesis-next-list">
            <li>
              <span className="genesis-next-label">先建这一层</span>
              <span>{nextLayerText}</span>
            </li>
            <li>
              <span className="genesis-next-label">接着写</span>
              <span>{continueText}</span>
            </li>
            <li>
              <span className="genesis-next-label">这本书</span>
              <span>{bookText}</span>
            </li>
          </ul>
        </div>
      </section>

      {/* R149：**右栏「产物与工具」**（三栏里的第三栏）——
          只放**真产物**（刚建好的卡、已写出来的章）与**去哪儿**，全部从真源现算。 */}
      <aside className="genesis-col-outputs">
        <div className="panel-title">
          <span className="muted">产物与工具</span>
        </div>
        <div className="genesis-outputs">
          <div className="genesis-outputs-label">刚建好的卡</div>
          {recentCards.length === 0 ? (
            <div className="muted">还没建卡 —— 左边走完第一层就有</div>
          ) : (
            <ul className="genesis-outputs-list">
              {recentCards.map((card) => (
                <li key={card.path}>
                  <span>{card.name}</span>
                  <span className="muted">{card.layer}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="genesis-outputs-label">已写的章</div>
          {writtenChapters.length === 0 ? (
            <div className="muted">还没建草稿 —— 从大纲里挑一章</div>
          ) : (
            <ul className="genesis-outputs-list">
              {writtenChapters.map((chapter) => (
                <li key={chapter.chapterId}>
                  <span>{chapter.title}</span>
                  <span className="muted">{chapter.wordCount} 字</span>
                </li>
              ))}
            </ul>
          )}
          <div className="genesis-outputs-label">去哪儿</div>
          <div className="genesis-outputs-links">
            <button type="button" onClick={() => props.onNavigate?.("library")}>
              稿件总览
            </button>
            <button type="button" onClick={() => props.onNavigate?.("rules")}>
              规则体检
            </button>
            <button type="button" onClick={() => props.onNavigate?.("archive")}>
              世界观档案
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}