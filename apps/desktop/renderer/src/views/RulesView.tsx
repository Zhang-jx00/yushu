/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useState } from "react";
import type {
  ConsistencyCheckPayload,
  ConsistencyReportPayload,
  RuleCatalogPayload,
  RuleDryRunResult,
  RuleRowPayload,
  ProposalDecisionPayload,
  ProposalPayload,
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

  // 影响传播（M4/T4-5，R61）：生成提案、逐条表态。**本轮不写回真源**，所以这里没有任何"应用"按钮——
  // 面板上写明的边界比一个灰掉的按钮诚实：读者不必猜"接受之后会发生什么"。
  const [propEntity, setPropEntity] = useState("");
  const [propField, setPropField] = useState("content");
  // 改名类改动才带得出机械可写的下游编辑（R62）：新 id 空着就是"正文类改动"，写回会被拒
  const [propTo, setPropTo] = useState("");
  const [proposals, setProposals] = useState<ProposalPayload[]>([]);
  const [propError, setPropError] = useState<string | null>(null);
  const [propBusy, setPropBusy] = useState(false);

  const refreshProposals = useCallback(async () => {
    try {
      setProposals(await api().proposal.list());
    } catch (err) {
      setPropError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const runPreview = useCallback(async () => {
    try {
      setPropError(null);
      setPropBusy(true);
      const field = propField.trim() || "content";
      await api().propagate.preview({
        entity: propEntity.trim(),
        field,
        ...(field === "id" && propTo.trim() !== "" ? { to: propTo.trim() } : {}),
      });
      await refreshProposals();
    } catch (err) {
      setPropError(err instanceof Error ? err.message : String(err));
    } finally {
      setPropBusy(false);
    }
  }, [propEntity, propField, propTo, refreshProposals]);

  const apply = useCallback(
    async (proposalId: string) => {
      try {
        setPropError(null);
        await api().proposal.apply({ proposalId });
        await refreshProposals();
      } catch (err) {
        setPropError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshProposals],
  );

  const decideApply = useCallback(
    async (proposalId: string) => {
      await apply(proposalId);
    },
    [apply],
  );

  const decide = useCallback(
    async (proposalId: string, index: number, decision: ProposalDecisionPayload) => {
      try {
        setPropError(null);
        await api().proposal.decide({ proposalId, index, decision });
        await refreshProposals();
      } catch (err) {
        setPropError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshProposals],
  );

  useEffect(() => {
    void refreshProposals();
  }, [refreshProposals]);

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
          <button
            className="btn consistency-ai"
            onClick={() => void runConsistency({ timing: "manual", aiAudit: true })}
            disabled={consistencyBusy}
          >
            全书体检 + AI 采样核验
          </button>
          <span className="muted consistency-hint">
            保存正文或改卡后结论即过期；「取最近结果」在未过期时复用缓存，不打断输入。
            AI 采样会真调用模型并按任务记账（默认不跑）。
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
            {/* AI 采样这次跑没跑、跑成什么样子，必须写在明面上 */}
            <p className="muted consistency-ai-line">
              AI 采样：
              {consistency.aiAudit.ran
                ? `已核验 ${consistency.aiAudit.sampled} 段（${consistency.aiAudit.provider}/${consistency.aiAudit.model}）· 结论 ${
                    consistency.entries.filter((entry) => entry.rule.startsWith("ai-sampled-")).length
                  } 条 · 丢弃 ${consistency.aiAudit.rejected} 条（越界或白名单外）`
                : `未跑（${consistency.aiAudit.reason}）`}
            </p>
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
                        {entry.span && entry.span.file.startsWith("world/cards/") ? (
                          <button
                            className="btn consistency-jump"
                            onClick={() => onOpenCard?.(entry.span!.file)}
                          >
                            {entry.span.file.split("/").pop()}#{entry.span.start}
                          </button>
                        ) : (
                          <span className="muted">{entry.span ? "正文片段（在编辑器里定位）" : "（无原文区间）"}</span>
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
      <section className="panel propagate-panel">
        <h3>影响传播（提案与逐项决策）</h3>
        <div className="propagate-bar">
          <input
            className="propagate-entity"
            placeholder="被改实体 id（如 law-spirit）"
            value={propEntity}
            onChange={(event) => setPropEntity(event.target.value)}
          />
          <input
            className="propagate-field"
            placeholder="被改字段"
            value={propField}
            onChange={(event) => setPropField(event.target.value)}
          />
          {propField.trim() === "id" && (
            <input
              className="propagate-to"
              placeholder="新实体 id（改名时必填）"
              value={propTo}
              onChange={(event) => setPropTo(event.target.value)}
            />
          )}
          <button className="btn propagate-preview" disabled={propBusy || propEntity.trim() === ""} onClick={() => void runPreview()}>
            生成影响提案
          </button>
        </div>
        {propError && <p className="warn propagate-error">{propError}</p>}
        <p className="muted propagate-line">
          {propBusy
            ? "正在沿引用反向遍历…"
            : proposals.length === 0
              ? "还没有提案。填实体 id 点「生成影响提案」——真源只读，提案只写 `.yushu/proposals/`。"
              : `已记录 ${proposals.length} 份提案 · 未决策 ${proposals.reduce((sum, item) => sum + item.undecidedCount, 0)} 条`}
        </p>
        {proposals.map((proposal) => (
          <div className="proposal-block" key={proposal.proposalId}>
            <p className="proposal-head">
              <code>{proposal.change.entity}</code> 的 <code>{proposal.change.field}</code> 改动
              {proposal.change.to ? <> → 新 id <code>{proposal.change.to}</code></> : null} ·
              {" "}{proposal.status === "blocked" ? "被环阻断" : "等待逐项确认"} · {proposal.impact.length} 条 ·
              {" "}未决策 {proposal.undecidedCount} 条 · 封顶 {proposal.maxDepth} 层
              {proposal.truncated ? `（下一层还有 ${proposal.truncated.count} 个未展开）` : "（未截断）"}
              {proposal.assumedRelations.length > 0
                ? ` · 权重未定义的关系按 1 计：${proposal.assumedRelations.join("、")}`
                : ""}
            </p>
            <p className="proposal-apply-row">
              <button
                className="btn proposal-apply"
                disabled={proposal.status !== "awaiting_confirmation" || proposal.undecidedCount > 0}
                onClick={() => void decideApply(proposal.proposalId)}
              >
                写回已接受的条目
              </button>
              <span className="muted">
                {proposal.status === "applied"
                  ? `已写回 ${proposal.applied.length} 条`
                  : proposal.undecidedCount > 0
                    ? "还有条目未决策，写回不可用"
                    : "只改引用指向；改名本身要作者自己在真源里完成"}
              </span>
            </p>
            {proposal.status === "blocked" && (
              <p className="warn proposal-cycle">环路径：{proposal.cycle?.join(" → ")}（先修掉成环的引用再传播）</p>
            )}
            {proposal.impact.length > 0 && (
              <table className="slot-table proposal-table">
                <thead>
                  <tr>
                    <th>跳数</th>
                    <th>受影响实体</th>
                    <th>经由关系</th>
                    <th>传播路径</th>
                    <th>权重</th>
                    <th>决策</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.impact.map((row, index) => (
                    <tr key={`${row.entity}-${index}`}>
                      <td className={row.severity === "error" ? "error" : row.severity === "warn" ? "warn" : "muted"}>
                        {row.depth}
                      </td>
                      <td>
                        <code>{row.entity}</code>
                      </td>
                      <td>{row.relation}</td>
                      <td className="muted">{row.path.join(" → ")}</td>
                      <td>
                        {row.weight.toFixed(2)}
                        {row.weightAssumed ? "（含未定义权重）" : ""}
                      </td>
                      <td>
                        <button className="btn proposal-accept" onClick={() => void decide(proposal.proposalId, index, "accept")}>
                          接受
                        </button>
                        <button className="btn proposal-reject" onClick={() => void decide(proposal.proposalId, index, "reject")}>
                          拒绝
                        </button>
                        <button className="btn proposal-pending" onClick={() => void decide(proposal.proposalId, index, "pending")}>
                          待定
                        </button>
                        <span className="proposal-decision">{proposal.decisions[String(index)] ?? "未决策"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        <p className="muted propagate-note">
          本轮只记录决策，<strong>不写回真源</strong>：写回要和"改前先快照 + 带 baseHash 拒覆盖"一起上，
          否则等于让引擎替作者改设定。未确认的条目永远不会落库。
        </p>
      </section>
    </div>
  );
}
