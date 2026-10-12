import { useCallback, useEffect, useState } from "react";
import type { CardReadResult, CardSummary, ForeshadowBoardPayload, NamingKindPayload, NamingResultPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { cardTypeLabel, layerLabel } from "../card-labels";
import { Disclosure } from "../components/Disclosure";

const NAMING_KINDS: { kind: NamingKindPayload; label: string }[] = [
  { kind: "character", label: "角色名" },
  { kind: "place", label: "地名" },
  { kind: "sect", label: "门派" },
  { kind: "technique", label: "功法" },
];

/** 世界观档案（T1-9）：设定卡列表 + 可视化编辑（frontmatter 字段 + 正文，带并发检测）+ 取名助手（T1-8）；
 *  支持外部聚焦（T2-2：编辑器实体提及 → 跳转并选中该卡） */
export function ArchiveView({
  focusCardPath,
}: {
  /** 外部聚焦请求（tick 变化即触发一次选中）；由 ProjectScreen 传入 */
  focusCardPath?: { path: string; tick: number } | null;
} = {}) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<CardReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // 取名助手（本地生成，离线可用）
  const [namingKind, setNamingKind] = useState<NamingKindPayload>("character");
  const [namingCount, setNamingCount] = useState(5);
  const [namingSeed, setNamingSeed] = useState("");
  const [namingResult, setNamingResult] = useState<NamingResultPayload | null>(null);
  const [namingNotice, setNamingNotice] = useState("");

  // 伏笔台账（T4-6，R66）：只读看板——判定在引擎，这里只摆出来，不给"一键改状态"的按钮
  const [board, setBoard] = useState<ForeshadowBoardPayload | null>(null);
  const [boardError, setBoardError] = useState("");
  useEffect(() => {
    let alive = true;
    api()
      .foreshadow.board()
      .then((result) => {
        if (alive) setBoard(result);
      })
      .catch((err: unknown) => {
        if (alive) setBoardError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const generateNames = async () => {
    try {
      setError(null);
      setNamingNotice("");
      const result = await api().naming.generate({
        kind: namingKind,
        count: namingCount,
        ...(namingSeed.trim() !== "" ? { seed: namingSeed.trim() } : {}),
      });
      setNamingResult(result);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyName = async (name: string) => {
    try {
      // 走主进程 Electron clipboard（渲染层 navigator.clipboard 在生产 file:// 下不可靠）
      await api().app.writeClipboard(name);
      setNamingNotice(`已复制「${name}」`);
    } catch (err) {
      setNamingNotice(`复制失败：${(err as Error).message}`);
    }
  };

  const refresh = useCallback(async () => {
    try {
      setCards(await api().card.list());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCard = async (path: string) => {
    try {
      setError(null);
      const result = await api().card.read(path);
      setSelected(path);
      setDoc(result);
      setDraft(result.body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 外部聚焦（T2-2）：编辑器实体提及跳转过来时自动选中该卡（tick 每次变化都会触发）
  useEffect(() => {
    if (focusCardPath) void openCard(focusCardPath.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCardPath?.tick]);

  const patch = (fields: Record<string, unknown>) => {
    if (!doc) return;
    setDoc({ ...doc, card: { ...doc.card, ...fields } });
  };

  const save = async () => {
    if (!doc) return;
    try {
      setError(null);
      const result = await api().card.write({
        path: doc.path,
        card: doc.card,
        body: draft,
        baseHash: doc.hash,
      });
      setDoc((prev) => (prev ? { ...prev, hash: result.hash } : prev));
      setStatus(
        `已保存 ${result.path}${
          result.warnings.length > 0 ? `（告警：${result.warnings.join("；")}）` : ""
        }`,
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="archive">
      <aside>
        <section className="panel naming">
          <h3>
            取名助手 <span className="muted">本地生成 · 离线可用</span>
          </h3>
          <div className="master-grid">
            <label className="field">
              <span>类型</span>
              <select
                value={namingKind}
                onChange={(event) => setNamingKind(event.target.value as NamingKindPayload)}
              >
                {NAMING_KINDS.map((item) => (
                  <option key={item.kind} value={item.kind}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>数量</span>
              <input
                type="number"
                min={1}
                max={20}
                value={namingCount}
                onChange={(event) => setNamingCount(Number(event.target.value) || 5)}
              />
            </label>
            <label className="field">
              <span>种子（可留空=换一批）</span>
              <input
                value={namingSeed}
                placeholder="填同一个种子可复现"
                onChange={(event) => setNamingSeed(event.target.value)}
              />
            </label>
          </div>
          <div className="outline-actions">
            <button type="button" onClick={generateNames}>
              生成
            </button>
            {namingResult && (
              <span className="muted">
                {namingResult.rulesTitle} · 种子 {namingResult.seed}
              </span>
            )}
          </div>
          {namingResult && (
            <>
              <div className="muted naming-pattern">{namingResult.pattern}</div>
              <ul className="name-list">
                {namingResult.names.map((name) => (
                  <li key={name} onClick={() => void copyName(name)} title="点击复制">
                    {name}
                  </li>
                ))}
              </ul>
            </>
          )}
          {namingNotice && <div className="muted">{namingNotice}</div>}
        </section>

        <div className="panel-title">
          <span className="muted">设定卡（{cards.length}）</span>
          <button type="button" className="link" onClick={refresh}>
            刷新
          </button>
        </div>
        <ul className="card-list">
          {cards.map((card) => (
            <li
              key={card.path}
              className={card.path === selected ? "on" : ""}
              onClick={() => openCard(card.path)}
            >
              <div>
                <strong>{card.name}</strong>
                <span className="muted">
                  {cardTypeLabel(card.type)} · {layerLabel(card.layer)}
                </span>
              </div>
              <div className="muted">
                {card.id}
                {card.visibility && ` · ${card.visibility}`}
              </div>
              {card.error && <div className="error-text">{card.error}</div>}
            </li>
          ))}
        </ul>
      </aside>

      <section className="editor">
        {!doc && <div className="muted pad">选择左侧设定卡进行编辑；或在「起源工作台」逐步建档</div>}
        {doc && (
          <>
            <div className="panel-title">
              <span className="muted">{doc.path}</span>
              {draft !== doc.body && <span className="dirty">有未保存修改</span>}
            </div>

            <div className="card-fields">
              <label className="field">
                <span>名称</span>
                <input value={doc.card.name} onChange={(event) => patch({ name: event.target.value })} />
              </label>
              <label className="field">
                <span>别名（逗号分隔，供提及追踪）</span>
                <input
                  value={doc.card.aliases?.join(", ") ?? ""}
                  onChange={(event) =>
                    patch({
                      aliases: event.target.value
                        .split(/[,，]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>可见性（冰山原则）</span>
                <select
                  value={doc.card.visibility ?? "hidden"}
                  onChange={(event) => patch({ visibility: event.target.value })}
                >
                  <option value="hidden">隐藏（未在正文出现）</option>
                  <option value="written_unrevealed">已写未揭示</option>
                  <option value="foreshadowed">已埋伏笔</option>
                  <option value="revealed">已揭示</option>
                </select>
              </label>
            </div>

            {doc.card.extensions && Object.keys(doc.card.extensions).length > 0 && (
              <Disclosure className="extensions" label="扩展字段（派系包注入；M1 为只读预览）">
                <pre>{JSON.stringify(doc.card.extensions, null, 2)}</pre>
              </Disclosure>
            )}

            <textarea
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />

            <div className="editor-foot">
              <button type="button" className="primary" onClick={save}>
                保存（baseHash 并发检测）
              </button>
              {error ? <span className="error-text">{error}</span> : <span className="muted">{status}</span>}
            </div>
          </>
        )}
      </section>

      <section className="panel foreshadow-board">
        <div className="panel-title">伏笔台账（只读 · 判定在引擎）</div>
        {boardError !== "" && <div className="error-text">{boardError}</div>}
        {board !== null && boardError === "" && (
          <>
            <div className="foreshadow-summary muted">
              {board.note}；共 {board.stats.total} 条 · 未回收 {board.stats.open} · 已回收 {board.stats.paid} ·
              已放弃 {board.stats.abandoned} · 红鲱鱼 {board.stats.redHerring} · 逾期 {board.stats.overdue}
            </div>
            {board.findings.length > 0 && (
              <ul className="foreshadow-findings">
                {board.findings.map((finding, index) => (
                  <li key={`${finding.id}-${finding.rule}-${index}`} className={`foreshadow-finding ${finding.severity}`}>
                    <span className="foreshadow-sev">{finding.severity === "error" ? "必须处理" : finding.severity === "warn" ? "建议处理" : "提示"}</span>
                    <span className="muted">{finding.rule}</span>
                    <span>{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {board.rows.length > 0 && (
              <table className="slot-table foreshadow-table">
                <thead>
                  <tr>
                    <th>伏笔</th>
                    <th>状态</th>
                    <th>看板</th>
                    <th>逾期</th>
                    <th>距上次动作</th>
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.name}
                        {row.isRedHerring ? <span className="foreshadow-rh">红鲱鱼</span> : null}
                      </td>
                      <td>{row.state}</td>
                      <td>{row.board === "open" ? "未回收" : "已闭环"}</td>
                      <td>{row.overdueBy === null ? "—" : `逾期 ${row.overdueBy} 章`}</td>
                      <td>{row.sinceAction === null ? "—" : `${row.sinceAction} 章`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="muted">
              登记方式：直接编辑 <code>{board.path}</code>（真源）。引擎不替你写伏笔，只告诉你哪几条还欠读者一个兑现；
              红鲱鱼与"放弃 + 理由"是合法终态，不会被报成问题。
            </div>
          </>
        )}
      </section>
    </div>
  );
}