import { useCallback, useEffect, useState } from "react";
import type { RuleCatalogPayload, RuleDryRunResult, RuleRowPayload } from "../../../src/shared/ipc";
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

export function RulesView() {
  const [catalog, setCatalog] = useState<RuleCatalogPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState("");
  const [fixture, setFixture] = useState(SAMPLE_FIXTURE);
  const [dryRun, setDryRun] = useState<RuleDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

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
    // 挂载即拉一次目录；刷新由按钮触发，避免每次改夹具都打主进程
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
    </div>
  );
}
