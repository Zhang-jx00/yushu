/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PublishBoardPayload,
  PublishStatus,
  PublishStockDueState,
  PublishStockRow,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 发布状态面板（M5 / T5-6，R105；R174 起加「存稿池」）。
 *
 * 这一屏只做五件事：**看清状态 → 改状态 → 设定定时 → 看清提醒与字数 → 看清存稿池**。
 * 判定全在引擎（`@yushu/world-engine/publish.ts` 与 `publish-stock.ts`，
 * 出处 I01 §5 状态机与 I07 平台规则包），这里一律不重算——两处各算一次，作者就会照一句假话核对。
 *
 * 五条展示口径：
 * ① **定时发布只是本地提醒，不代替平台发布**（I01 §3.7）：面板里必须把这句话写出来，
 *    不然"到点了"会被读成"御书替我发了"；
 * ② **本地字数 ≠ 平台有效字数**：平台口径名要单列（番茄是"后台打卡口径"，本地算不了）；
 * ③ **没声明就不判**：包里没声明单章下限 ⇒ 面板不显示"低于下限"的结论，也不显示"全部达标"；
 * ④ **读不动就说读不动**：口径包或台账读不动时把原因摊开，不降级成"没问题"；
 * ⑤ **存稿池是 draft 的子集，不是第四个状态**（R174）：面板上的「处境」是同一批草稿的不同处境，
 *    **写入口仍然只有那两个**（改状态 / 设定定时）——池子里每行的动作直接调同一条通道，
 *    不另造第三套写入点（另造一套就会漂，漂出来的按钮点下去只会被引擎拒）。
 *
 * 零新增 CSS：复用 `.panel` / `.slot-table` / `.field` / `.muted` / `.warn` / `.error-text` / `.chip`
 * （契约 §7：先复用再新建）。按钮一律用真 `<button>`（键盘可达，键盘债不新增）。
 */

const STATUS_LABEL: Record<PublishStatus, string> = {
  draft: "草稿",
  revised: "修订中",
  published: "已发布",
};

/** 存稿池里一章的处境（引擎 `STOCK_DUE_STATES` 的逐字副本；漂移由 publish-stock-ids.test.ts 盯住） */
const DUE_STATE_LABEL: Record<PublishStockDueState, string> = {
  due: "到期",
  soon: "临期",
  scheduled: "已定时",
  stock: "存稿",
};

/** ISO → `<input type="datetime-local">` 认的本地格式 */
function toLocalInput(iso: string): string {
  if (iso.trim() === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function PublishPanel() {
  const [board, setBoard] = useState<PublishBoardPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [note, setNote] = useState("");
  const [at, setAt] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      const next = await api().publish.board();
      setBoard(next);
      setPicked((current) => {
        if (current !== "" && next.chapters.some((item) => item.id === current)) return current;
        return next.chapters[0]?.id ?? "";
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = useMemo(
    () => board?.chapters.find((item) => item.id === picked) ?? null,
    [board, picked],
  );

  /** 引擎给的迁移矩阵：合法的可点，非法的禁用并把理由挂在 title 上 */
  const targets = useMemo(() => {
    if (board === null || current === null) return [];
    return board.transitionGuide.filter((item) => item.from === current.status);
  }, [board, current]);

  const setStatus = async (to: PublishStatus) => {
    if (current === null || board === null) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await api().publish.setStatus({
        path: current.path,
        to,
        baseHash: current.hash,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      setReceipt(
        `${current.title}：${STATUS_LABEL[result.from]} → ${STATUS_LABEL[result.to]}` +
          `${result.rollback ? "（回退，已留痕）" : ""}；台账第 ${String(result.ledgerEvents)} 条；${String(result.wordCount)} 字`,
      );
      setNote("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const schedule = async (clear: boolean) => {
    if (current === null || board === null) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const iso = clear || at.trim() === "" ? "" : new Date(at).toISOString();
      const result = await api().publish.schedule({ path: current.path, publishAt: iso, baseHash: current.hash });
      setReceipt(
        result.publishAt === ""
          ? `${current.title}：已清除定时`
          : `${current.title}：定时发布设为 ${new Date(result.publishAt).toLocaleString("zh-CN")}`,
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const daily = board?.word.daily;
  const reachedText =
    daily === undefined
      ? "（包里没声明当日口径，本轮不判）"
      : daily.reached.length === 0
        ? "（未达任何档位）"
        : daily.reached.join(" / ");

  /**
   * 存稿池里的一行：两个动作，**都走既有通道**（写入点只有那一处）。
   *
   * - 「标记本章已发布」= 一键进发布状态机（`publish:setStatus`，draft → published 合法）；
   * - 「撤下提醒」= 把这一章的定时撤掉（`publish:schedule` 传空串）⇒ 它不再到期，
   *   但**仍然留在存稿池里**（稿子还在手上，续航天数不变）。
   *
   * 三条口径：① **撤下提醒不写发布台账**——台账只记状态迁移（I01 §5），
   * 撤下定时是一次"改计划"，不是一次状态迁移；② 动作**带 baseHash**，外部改过就拒；
   * ③ **按钮文案不与上面的迁移按钮重名**——两个同名按钮做的是两件事（一个动"选中那一章"，
   * 一个动"这一行"），作者分不清就点错了（R174 的预演当场撞到：按文案找按钮的脚本
   * 找成了池子里那一个，把另一章发了出去 ⇒ step67 当场红）。
   */
  const publishRow = async (row: PublishStockRow) => {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await api().publish.setStatus({ path: row.path, to: "published", baseHash: row.hash });
      setReceipt(`${row.title}：${STATUS_LABEL[result.from]} → ${STATUS_LABEL[result.to]}；台账第 ${String(result.ledgerEvents)} 条`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undoReminder = async (row: PublishStockRow) => {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      await api().publish.schedule({ path: row.path, publishAt: "", baseHash: row.hash });
      setReceipt(`${row.title}：已撤下提醒（定时清空，稿子仍在存稿池里）`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stock = board?.stock;
  const endurance = stock?.endurance;

  return (
    <div className="publish-panel">
      <div className="muted">
        发布状态：草稿 {String(board?.groups.draft ?? 0)} · 修订中 {String(board?.groups.revised ?? 0)} · 已发布{" "}
        {String(board?.groups.published ?? 0)} ｜ 台账留痕 {String(board?.ledgerEvents ?? 0)} 条
        {board !== null && board.platform !== ""
          ? ` ｜ 口径包：${board.platform} ${board.platformVersion}（生效 ${board.effectiveDate}）`
          : ""}
      </div>
      {board !== null && board.rulesError !== "" ? (
        <div className="error-text">口径包读不了，本轮不判字数：{board.rulesError}</div>
      ) : null}
      {board !== null && board.ledgerError !== "" ? (
        <div className="error-text">发布台账读不了（留痕与状态可能对不上）：{board.ledgerError}</div>
      ) : null}
      {board !== null && board.mismatches.length > 0 ? (
        <div className="warn">账实不符：{board.mismatches.join("；")}</div>
      ) : null}
      {board !== null ? (
        <div className="muted">
          判据出处：状态机 {board.origins.status} ｜ 提醒 {board.origins.reminder} ｜ 字数 {board.origins.word}
        </div>
      ) : null}

      <div className="muted">
        本地字数：共 {String(board?.word.count ?? 0)} 章 · 合计 {String(board?.word.total ?? 0)} 字 · 中位{" "}
        {String(board?.word.median ?? 0)} · 最低 {String(board?.word.min ?? 0)} · 最高 {String(board?.word.max ?? 0)}
        {board !== null && board.validWordRule !== "" ? ` ｜ 平台有效字数口径：${board.validWordRule}` : ""}
      </div>
      {board !== null && board.word.perChapterFloorDeclared ? (
        <div className="warn">
          低于平台单章下限的章 {String(board.word.belowFloor.length)} 条：
          {board.word.belowFloor.map((item) => `${item.title}（${String(item.wordCount)} 字）`).join("、") || "（无）"}
        </div>
      ) : null}
      <div className="muted">
        当日已发布字数：{daily === undefined ? "（无口径）" : `${String(daily.publishedChars)} 字`} ｜ 档位 {reachedText}
        {daily !== undefined && daily.standard !== undefined ? ` ｜ 普通档 ${String(daily.standard)}` : ""}
        {daily !== undefined && daily.advanced !== undefined ? ` · 进阶档 ${String(daily.advanced)}` : ""}
      </div>

      <div className="muted">
        定时提醒（<strong>只是本地提醒，不代替平台发布</strong>）：{String(board?.reminders.length ?? 0)} 条
        {board !== null && board.reminders.length > 0
          ? `｜${board.reminders
              .map((item) => `${item.title}（${new Date(item.publishAt).toLocaleString("zh-CN")}）`)
              .join("、")}`
          : ""}
      </div>

      {/* 存稿池与续航（R174，I01 §3.5 / §5）：写完还没发出去的稿 + 还能撑几天。
          它是 `chapters` 的一个子集——同一个数只有一个出处，这里不另抄一份章清单。 */}
      <div
        className="field"
        data-stock-pool="1"
        data-stock-count={String(endurance?.poolCount ?? 0)}
        data-stock-days={endurance?.days === null || endurance === undefined ? "" : String(endurance.days)}
      >
        <span>存稿池（写完还没发出去的稿）</span>
        <div className="muted">
          池子 {String(endurance?.poolCount ?? 0)} 章（到期 {String(endurance?.dueCount ?? 0)} · 临期{" "}
          {String(endurance?.soonCount ?? 0)} · 已定时 {String(endurance?.scheduledCount ?? 0)} · 存稿{" "}
          {String(endurance?.stockCount ?? 0)}）｜ 可撑{" "}
          {endurance === undefined || endurance.days === null ? "（算不出）" : `${String(endurance.days)} 天`}
          {endurance !== undefined && endurance.dailyChapters !== null
            ? ` ｜ 日更 ${String(endurance.dailyChapters)} 章（台账实测）`
            : ""}
        </div>
        {endurance !== undefined && endurance.note !== "" ? (
          <div className="muted">{endurance.note}</div>
        ) : null}
        {endurance !== undefined && endurance.warning !== "" ? (
          <div className="warn">{endurance.warning}</div>
        ) : null}
        {stock !== undefined && stock.rows.length === 0 ? (
          <div className="muted">存稿池是空的：没有"写完还没发"的稿子（草稿箱里还没写完的章不算）。</div>
        ) : null}
        {stock !== undefined && stock.rows.length > 0 ? (
          <table className="slot-table">
            <thead>
              <tr>
                <th>章</th>
                <th className="num">字数</th>
                <th>处境</th>
                <th>定时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {stock.rows.map((row) => (
                <tr key={row.id} data-stock-id={row.id} data-due-state={row.dueState}>
                  <td>{row.title}</td>
                  <td className="num">{String(row.wordCount)}</td>
                  <td>{DUE_STATE_LABEL[row.dueState]}</td>
                  <td>
                    {row.publishAt === "" ? "—" : new Date(row.publishAt).toLocaleString("zh-CN")}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      data-stock-action="publish"
                      title={`把《${row.title}》标记为已发布（台账会留痕）`}
                      onClick={() => void publishRow(row)}
                    >
                      标记本章已发布
                    </button>
                    {row.publishAt !== "" ? (
                      <button
                        type="button"
                        disabled={busy}
                        data-stock-action="undo-reminder"
                        title="撤掉这一章的定时（稿子仍在存稿池里）"
                        onClick={() => void undoReminder(row)}
                      >
                        撤下提醒
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="field">
        <span>选一章（写入点）</span>
        <select value={picked} onChange={(event) => setPicked(event.target.value)}>
          {(board?.chapters ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}（{STATUS_LABEL[item.status]} · {String(item.wordCount)} 字）
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>迁移（只列引擎判为合法的；非法的会禁用并写明理由）</span>
        <div>
          {targets.map((item) => (
            <button
              key={`${item.from}-${item.to}`}
              type="button"
              className="chip"
              disabled={busy || !item.ok}
              title={item.ok ? item.reason : item.reason}
              onClick={() => void setStatus(item.to)}
            >
              {item.rollback ? `退回${STATUS_LABEL[item.to]}` : `标记为${STATUS_LABEL[item.to]}`}            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>定时发布时刻（本地提醒；留空 = 不定时）</span>
        <input
          type="datetime-local"
          value={at}
          onChange={(event) => setAt(event.target.value)}
          placeholder={current === null ? "" : toLocalInput(current.publishAt)}
        />
        <button type="button" disabled={busy || current === null} onClick={() => void schedule(false)}>
          设定定时
        </button>
        <button type="button" disabled={busy || current === null} onClick={() => void schedule(true)}>
          清除定时
        </button>
      </div>
      <div className="field">
        <span>理由（可选；回退时写一句，留在台账里）</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="如：平台审稿没过，退回改" />
      </div>
      {receipt ? <div className="muted">{receipt}</div> : null}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
