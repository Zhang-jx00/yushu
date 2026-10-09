import { useCallback, useEffect, useState } from "react";
import type {
  ConsistencyCheckPayload,
  ConsistencyReportPayload,
  RuleCatalogPayload,
  RuleDryRunResult,
  RuleRowPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 规则页（M4 / T4-1 桌面接入，R51）：列出项目所选派系包携带的一致性规则，并提供沙箱试算。
 *
 * 两条口径从引擎一路带到界面：
 * - **坏规则要看得见**：解析失败的文件、表达式违规的规则条目都显式标红，不折叠成"0 条规则"；
 * - **试算失败不等于"没发现问题"**：被沙箱拒绝时显示原始 `E_RULE_*` 原因，不显示成未命中。
 * 本页只读——规则本体属内置派系包，御书不改包；拿项目真数据比对属 T4-2。
 */

const SAMPLE_FIXTURE = `{
  "a": { "chapter": "第 3 章", "realm": { "tier": 3 }, "combat_power": 100 },
  "b": { "chapter": "第 4 章", "realm": { "tier": 4 }, "combat_power": 80 }
}`;

const SEVERITY_LABEL: Record<string, string> = { error: "错误", warn: "警告", info: "提示" };
const SCOPE_LABEL: Record<string, string> = {
  scene: "场景",
  chapter: "单章",
  cross_chapter: "跨章",
  project: "全书",
};

export function RulesView({ onOpenCard }: { onOpenCard?: (path: string) => void }) {
  const [catalog, setCatalog] = useState<RuleCatalogPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState("");
  const [fixture, setFixture] = useState(SAMPLE_FIXTURE);
  const [dryRun, setDryRun] = useState<RuleDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyReportPayload | null>(null);
  const [consistencyError, setConsistencyError] = useState<string | null>(null);
  const [consistencyBusy, setConsistencyBusy] = useState(false);

  const runConsistency = useCallback(async (payload: ConsistencyCheckPayload) => {
    try {
      setConsistencyError(null);
      setConsistencyBusy(true);
      setConsistency(await api().consistency.check(payload));
    } catch (err) {
      setConsistency(null);
      setConsistencyError(err instanceof Error ? err.message : String(err));
    } finally {
      setConsistencyBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const next = await api().rule.catalog();
      setCatalog(next);
      const first = next.files.flatMap((file) => file.rules)[0];
      if (first && !next.files.some((file) => file.rules.some((rule) => rule.id === ruleId))) {
        setRuleId(first.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ruleId]);

  useEffect(() => {
    void refresh();
    // 挂载即取一次「最近结果」：标签页切换会重挂载本组件，若不在这里回填，
    // 作者点完"跳到原文"再回来就看不到刚才的结论了（主进程缓存未过期时是零成本复用）。
    void runConsistency({ timing: "post-save" });
    // 挂载时拉一次目录与缓存结果；刷新由按钮触发，避免每次改夹具都打主进程
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allRules: Array<RuleRowPayload & { file: string }> = (catalog?.files ?? []).flatMap((file) =>
    file.rules.map((rule) => ({ ...rule, file: file.file })),
  );
  const selected = allRules.find((rule) => rule.id === ruleId) ?? null;

  const runDryRun = async () => {
    if (!selected) return;
    try {
      setDryRunError(null);
      setDryRun(await api().rule.dryRun({ ruleId: selected.id, file: selected.file, data: fixture }));
    } catch (err) {
      setDryRun(null);
      setDryRunError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="view rules-view">
      <section className="panel">
        <h3>规则目录（派系包携带）</h3>
        <div className="rules-toolbar">
          <button className="btn rules-refresh" onClick={() => void refresh()}>
            刷新规则目录
          </button>
          <span className="muted rules-pack-ids">
            本项目派系包：{catalog ? (catalog.packIds.length > 0 ? catalog.packIds.join("、") : "（未选包）") : "加载中…"}
          </span>
        </div>
        {error && <p className="error rules-error">读取失败：{error}</p>}
        {catalog?.loadError && <p className="error rules-load-error">派系包加载失败（下面的空目录不等于"这些包没有规则"）：{catalog.loadError}</p>}
        {catalog && (
          <>
            <p className="muted rules-summary">
              规则 {catalog.total} 条 · 解析失败文件 {catalog.brokenFiles} 个 · 表达式有问题 {catalog.problemRules} 条
              {catalog.duplicateIds.length > 0 ? ` · 跨文件重名 ${catalog.duplicateIds.length} 个` : ""}
            </p>
            {catalog.duplicateIds.map((item) => (
              <p key={item.id} className="warn rules-duplicate">
                规则 id「{item.id}」在多个文件里重复（{item.files.join("、")}）：同包撞名没有版本依据，拒绝按加载顺序取后者
              </p>
            ))}
            {catalog.files.map((file) => (
              <div className="rules-file" key={`${file.packId}-${file.file}`}>
                <div className="muted rules-file-head">
                  {file.file}（派系包 {file.packId}）
                </div>
                {file.error !== null ? (
                  <p className="error rules-file-error">
                    解析失败，该文件 0 条规则生效：{file.error}
                  </p>
                ) : (
                  <table className="slot-table rules-table">
                    <thead>
                      <tr>
                        <th>规则 id</th>
                        <th>级别</th>
                        <th>作用域</th>
                        <th>结论</th>
                        <th>出处</th>
                        <th>问题</th>
                      </tr>
                    </thead>
                    <tbody>
                      {file.rules.map((rule) => (
                        <tr key={rule.id}>
                          <td>
                            <code>{rule.id}</code>
                          </td>
                          <td className={rule.severity === "error" ? "error" : rule.severity === "warn" ? "warn" : "muted"}>
                            {SEVERITY_LABEL[rule.severity] ?? rule.severity}
                          </td>
                          <td>{SCOPE_LABEL[rule.scope] ?? rule.scope}</td>
                          <td>{rule.message}</td>
                          <td className="muted">{rule.origin_source ?? rule.origin_set ?? "—"}</td>
                          <td className={"rules-problems" + (rule.issues.length > 0 ? " error" : " muted")}>
                            {rule.issues.length > 0 ? rule.issues.join("；") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
            {catalog.files.length === 0 && <p className="muted">所选派系包没有声明规则件。</p>}
          </>
        )}
      </section>

      <section className="panel">
        <h3>沙箱试算（只读，不写任何数据）</h3>
        <div className="rules-dryrun-form">
          <label className="muted" htmlFor="rules-pick">
            规则
          </label>
          <select id="rules-pick" className="rules-rule-pick" value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
            {allRules.map((rule) => (
              <option key={`${rule.file}-${rule.id}`} value={rule.id}>
                {rule.id}（{rule.file}）
              </option>
            ))}
          </select>
          <button className="btn rules-dryrun-run" onClick={() => void runDryRun()} disabled={selected === null}>
            试算
          </button>
        </div>
        <p className="muted">
          夹具是比对上下文（JSON 对象），规则里的 <code>{"{var: \"a.realm.tier\"}"}</code> 就是按点分路径从这里取值。
          表达式禁循环、禁 IO，求值有节点预算与深度上限。
        </p>
        <textarea className="rules-fixture" rows={6} value={fixture} onChange={(event) => setFixture(event.target.value)} />
        {dryRunError && <p className="error rules-dryrun-error">调用失败：{dryRunError}</p>}
        {dryRun && (
          <div className="rules-dryrun-result">
            {dryRun.ok ? (
              <>
                <p className={dryRun.matched ? "rules-dryrun-hit" : "muted rules-dryrun-miss"}>
                  {dryRun.matched ? "命中：" : "未命中："}
                  {dryRun.message}
                </p>
                <table className="slot-table rules-evidence-table">
                  <thead>
                    <tr>
                      <th>读取的 var</th>
                      <th>取到的值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(dryRun.evidence).map(([path, value]) => (
                      <tr key={path}>
                        <td>
                          <code>{path}</code>
                        </td>
                        <td>{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="error rules-dryrun-rejected">
                沙箱拒绝（不是"没发现问题"）：{dryRun.error}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>一致性体检（结构类规则 · 只读）</h3>
        <div className="consistency-toolbar">
          <button
            className="btn consistency-manual"
            onClick={() => void runConsistency({ timing: "manual" })}
            disabled={consistencyBusy}
          >
            全书体检
          </button>
          <button
            className="btn consistency-post-save"
            onClick={() => void runConsistency({ timing: "post-save" })}
            disabled={consistencyBusy}
          >
            取最近结果
          </button>
          <span className="muted consistency-hint">
            保存正文或改卡后结论即过期；「取最近结果」在未过期时复用缓存，不打断输入。
          </span>
        </div>
        {consistencyError && <p className="error consistency-error">体检失败：{consistencyError}</p>}
        {consistency && (
          <>
            {consistency.allowError && (
              <p className="error consistency-allow-error">
                豁免清单读不了，本次「未应用任何豁免」（不静默放行）：{consistency.allowError}
              </p>
            )}
            {consistency.worldNote && <p className="warn consistency-world-note">{consistency.worldNote}</p>}
            <p className="muted consistency-summary">
              时机 {consistency.timing} · {consistency.ranAgain ? "已重算" : "复用缓存"} · 实体{" "}
              {consistency.entities} 引用 {consistency.refs} · 结论 {consistency.counted.entries} · 豁免{" "}
              {consistency.counted.suppressed} · 未纳入范围 {consistency.outOfScope.length}
              {consistency.counted.filteredOut > 0 ? ` · 范围外过滤 ${consistency.counted.filteredOut}` : ""}
              {consistency.skipped.cycleDepthCapped > 0
                ? ` · 环搜索深度封顶 ${consistency.skipped.cycleDepthCapped} 次（未假装没有环）`
                : ""}
            </p>
            {/* 派系包规则本轮跑了哪些、哪些没跑、哪些数据读不出——三件都必须看得见 */}
            <p className="muted consistency-pack">
              包规则：本轮求值 {consistency.pack.evaluated.length} 条
              {consistency.pack.evaluated.length > 0 ? `（${consistency.pack.evaluated.join(", ")}）` : ""} · 未参与{" "}
              {consistency.pack.notEvaluated.length} 条
              {consistency.pack.errors.length > 0 ? ` · 数据读不出 ${consistency.pack.errors.length} 处` : ""}
            </p>
            {consistency.pack.notEvaluated.length > 0 && (
              <p className="muted consistency-pack-skipped">
                没跑的规则不算通过，只是没数据可比：
                {consistency.pack.notEvaluated.map((item) => `${item.id}（${item.reason}）`).join("；")}
              </p>
            )}
            {consistency.pack.errors.length > 0 && (
              <p className="warn consistency-pack-errors">{consistency.pack.errors.join("；")}</p>
            )}
            {consistency.entries.length === 0 ? (
              <p className="muted consistency-clean">本次没有一致性结论（结构类 + 已求值的包规则；不代表未纳入范围的项也查过）。</p>
            ) : (
              <table className="slot-table consistency-table">
                <thead>
                  <tr>
                    <th>级别</th>
                    <th>规则</th>
                    <th>主体</th>
                    <th>依据</th>
                    <th>建议修法</th>
                    <th>出处</th>
                    <th>原文</th>
                  </tr>
                </thead>
                <tbody>
                  {consistency.entries.map((entry, index) => (
                    <tr key={`${entry.rule}-${entry.subject}-${entry.related ?? ""}-${index}`}>
                      <td className={entry.severity === "error" ? "error" : "warn"}>{entry.severity}</td>
                      <td>
                        <code>{entry.rule}</code>
                      </td>
                      <td>
                        <code>{entry.subject}</code>
                        {entry.related ? <span className="muted"> → {entry.related}</span> : null}
                      </td>
                      <td>{entry.evidence}</td>
                      <td>{entry.fix}</td>
                      <td className="muted">{entry.origin ?? "内置结构规则"}</td>
                      <td>
                        {entry.span ? (
                          <button
                            className="btn consistency-jump"
                            onClick={() => onOpenCard?.(entry.span!.file)}
                          >
                            {entry.span.file.split("/").pop()}#{entry.span.start}
                          </button>
                        ) : (
                          <span className="muted">（无原文区间）</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {consistency.suppressed.length > 0 && (
              <ul className="issues consistency-suppressed">
                {consistency.suppressed.map((item, index) => (
                  <li key={`sup-${item.rule}-${item.subject}-${index}`} className="muted">
                    已豁免 <code>{item.rule}</code> · <code>{item.subject}</code>
                    {item.related ? ` → ${item.related}` : ""}：{item.reason}
                    {item.decidedAt ? `（${item.decidedAt}）` : "（未记决策时间）"}
                  </li>
                ))}
              </ul>
            )}
            {consistency.unusedAllow.length > 0 && (
              <p className="muted consistency-unused">
                用不上的豁免（可能已失效，建议清理）：{consistency.unusedAllow.join("、")}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
