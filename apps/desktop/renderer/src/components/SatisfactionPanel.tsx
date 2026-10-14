/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import type { SatisfactionBoardPayload, SatisfactionThresholdsPayload } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 爽点与期待感看板（M4 / T4-10，R73）：只读。
 *
 * 判定全在引擎（`world-engine/satisfaction.ts`），面板只投影。两件事在界面上必须分开：
 * ① **结论**（findings）与**没判的**（notEvaluated）分成两块——把"没判"显示成"没问题"，
 *    作者就会以为节奏是绿的；② **推进率为空**显示"无声明"而不是 0%，
 *    0% 是一个结论，"无声明"是一个事实，两者不能互相冒充。
 * 阈值输入框留空即不传 ⇒ 对应规则不跑（引擎会把理由回传，直接显示在"没判的"里）。
 */

const THRESHOLD_FIELDS: { key: keyof SatisfactionThresholdsPayload; label: string; hint: string }[] = [
  { key: "same_type_streak_max", label: "同质化连章", hint: "连续几章同一种爽点算重复" },
  { key: "release_interval_max", label: "释放间隔", hint: "隔几章必须有一次强释放" },
  { key: "strong_intensity", label: "强释放门槛", hint: "intensity 达到几算强" },
  { key: "suppress_streak_max", label: "压抑连章", hint: "憋几章算欠账" },
  { key: "promise_open_max", label: "未决承诺上限", hint: "同时挂着几条算超载" },
  { key: "no_advance_streak", label: "无推进连场景", hint: "连续几个场景不推进该删" },
];

const SEVERITY_LABEL: Record<"error" | "warn" | "info", string> = { error: "必改", warn: "建议", info: "提示" };

const PHASE_LABEL: Record<string, string> = {
  suppress: "压抑",
  build: "蓄力",
  release: "释放",
  aftermath: "余韵",
};

const TYPE_LABEL: Record<string, string> = {
  face_slap: "打脸",
  upgrade: "升级",
  harvest: "收获",
  show: "装逼",
  reveal: "揭密",
  sweet: "糖点",
};

export function SatisfactionPanel() {
  const [board, setBoard] = useState<SatisfactionBoardPayload | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const thresholds = (): SatisfactionThresholdsPayload => {
    const out: Record<string, number> = {};
    for (const field of THRESHOLD_FIELDS) {
      const raw = inputs[field.key] ?? "";
      const value = Number(raw);
      if (raw.trim() !== "" && Number.isInteger(value) && value > 0) out[field.key as string] = value;
    }
    return out;
  };

  useEffect(() => {
    let alive = true;
    api()
      .satisfaction.board({ thresholds: thresholds() })
      .then((result) => {
        if (alive) setBoard(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
    // 只在挂载与阈值变化时取数；thresholds() 每次渲染都是新对象，故把依赖收敛成序列化后的键
  }, [JSON.stringify(inputs)]);

  return (
    <section className="panel satisfaction-panel">
      <div className="panel-title">爽点与期待感（只读 · 判定在引擎，阈值不设就不判）</div>
      {error !== "" && <div className="error-text">{error}</div>}
      {board !== null && error === "" && (
        <>
          <div className="satisfaction-summary muted">{board.note}</div>
          <div className="satisfaction-thresholds">
            {THRESHOLD_FIELDS.map((field) => (
              <label className="field" key={field.key} title={field.hint}>
                <span>{field.label}</span>
                <input
                  className="satisfaction-threshold"
                  type="number"
                  min={1}
                  value={inputs[field.key] ?? ""}
                  placeholder="不判定"
                  onChange={(event) => setInputs({ ...inputs, [field.key]: event.target.value })}
                />
              </label>
            ))}
          </div>
          {board.findings.length > 0 && (
            <ul className="satisfaction-findings">
              {board.findings.map((finding) => (
                <li key={finding.id} className={`satisfaction-finding ${finding.severity}`}>
                  <span className="satisfaction-sev">{SEVERITY_LABEL[finding.severity]}</span>
                  <code>{finding.rule}</code>
                  <span>{finding.message}</span>
                </li>
              ))}
            </ul>
          )}
          {board.notEvaluated.length > 0 && (
            <div className="satisfaction-not-evaluated">
              <span className="satisfaction-ne-title">没判的（不等于判过没问题）</span>
              <ul>
                {board.notEvaluated.map((item) => (
                  <li key={item.rule} className="muted">
                    <code>{item.rule}</code>——{item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {board.promises.length > 0 && (
            <table className="slot-table satisfaction-promises">
              <thead>
                <tr>
                  <th>承诺</th>
                  <th>内容</th>
                  <th>状态</th>
                  <th>逾期</th>
                  <th>兑现证据</th>
                </tr>
              </thead>
              <tbody>
                {board.promises.map((item) => (
                  <tr key={item.id} className="satisfaction-promise-row">
                    <td>
                      <code>{item.id}</code>
                    </td>
                    <td>{item.promise}</td>
                    <td>{item.status}</td>
                    <td>{item.overdueBy === null ? "—" : item.overdueBy > 0 ? `逾期 ${String(item.overdueBy)} 章` : "未到期"}</td>
                    <td className="muted">
                      {item.evidence === "hit" ? "有爽点记录" : item.evidence === "foreshadow" ? "挂在伏笔上" : "无"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table className="slot-table satisfaction-rows">
            <thead>
              <tr>
                <th>章</th>
                <th>爽点</th>
                <th>相位</th>
                <th>新增承诺</th>
                <th>场景推进</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row) => (
                <tr key={row.chapter} className="satisfaction-row">
                  <td>
                    第 {String(row.ordinal)} 章 <span className="muted">{row.chapter}</span>
                  </td>
                  <td>
                    {row.hits.length === 0
                      ? "—"
                      : row.hits
                          .map((h) => `${TYPE_LABEL[h.type] ?? h.type} ${String(h.intensity > 0 ? "+" : "")}${String(h.intensity)}`)
                          .join("、")}
                  </td>
                  <td>{row.phase === null ? "—" : PHASE_LABEL[row.phase] ?? row.phase}</td>
                  <td>{row.promisesOpened.length === 0 ? "—" : row.promisesOpened.join("、")}</td>
                  <td className="satisfaction-advance">
                    {row.advanceRate === null
                      ? "无声明"
                      : `${String(row.scenes.advancing)} / ${String(row.scenes.total)}（${String(Math.round(row.advanceRate * 100))}%）`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            登记方式：直接编辑 <code>{board.path}</code>（真源）。引擎只算间隔与计数，
            <strong>不判断"这章读起来爽不爽"</strong>；推进率的分子分母都来自作者自己声明的场景标注（I04 §3.2）。
          </p>
        </>
      )}
    </section>
  );
}
