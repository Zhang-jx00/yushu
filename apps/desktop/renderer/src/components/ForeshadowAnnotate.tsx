/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import type { ForeshadowBoardPayload, ForeshadowRowPayload } from "../../../src/shared/ipc.js";
import { api } from "../api.js";

/**
 * **钩子标注**（R187）：作者写完一章，在这里标「这章埋了/回收了哪条伏笔」——
 * 写进真源 `world/foreshadow.yaml`（`plant_chapters` / `payoff_chapters`），
 * **与伏笔台账同源**（不许两本账）：
 * ① 写通道只有一条（`foreshadow:annotate`，主进程 `annotateForeshadow`）；
 * ② 返回值就是**重算的看板**（与台账页同一个载荷）⇒「标注后台账同步变」由数据流保证；
 * ③ 判定永远由引擎现算——面板自己不算 overdueBy，不算 state（R65 纪律：不替作者改状态）。
 *
 * 口径明写：台账的「当前章」= **章清单最后一章**（不是你正在写的章）——
 * 「逾期 N 章」按它算；标注只改章清单字段，读数变化以台账页为准。
 */
export function ForeshadowAnnotate({ currentChapterId }: { currentChapterId: string | null }) {
  const [board, setBoard] = useState<ForeshadowBoardPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      .foreshadow.board()
      .then((payload) => {
        if (alive) setBoard(payload);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const annotate = async (row: ForeshadowRowPayload, kind: "plant" | "payoff", remove: boolean) => {
    if (currentChapterId === null) return;
    setError(null);
    try {
      const next = await api().foreshadow.annotate({
        entryId: row.id,
        kind,
        chapterId: currentChapterId,
        remove,
      });
      setBoard(next);
      const label = kind === "plant" ? "埋设" : "回收";
      setNotice(remove ? `已撤销「${row.name}」在本章的${label}标注` : `已把本章标进「${row.name}」的${label}章清单`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (board === null || !board.exists) {
    return (
      <section className="panel foreshadow-annotate">
        <div className="panel-title">钩子标注</div>
        <p className="muted">项目还没有伏笔台账——先在台账里登记一条（world/foreshadow.yaml）。</p>
      </section>
    );
  }

  const openRows = board.rows.filter((row) => row.board === "open");
  const plantedHere = (row: ForeshadowRowPayload): boolean =>
    currentChapterId !== null && row.plantChapters.includes(currentChapterId);
  const paidHere = (row: ForeshadowRowPayload): boolean =>
    currentChapterId !== null && row.payoffChapters.includes(currentChapterId);

  return (
    <section
      className="panel foreshadow-annotate"
      data-foreshadow-annotate="1"
      data-annotate-chapter={currentChapterId ?? ""}
    >
      <div className="panel-title">钩子标注</div>
      <p className="muted foreshadow-annotate-note">
        把本章标进伏笔的埋设 / 回收章清单（真源 world/foreshadow.yaml，台账同源）；
        「当前章」的口径是章清单最后一章，读数以台账页为准。
      </p>
      {notice !== null && <div className="foreshadow-annotate-notice">{notice}</div>}
      {error !== null && <div className="error-text">{error}</div>}
      {openRows.length === 0 ? (
        <p className="muted">台账里没有未回收的伏笔。</p>
      ) : (
        <ul className="foreshadow-annotate-list">
          {openRows.map((row) => (
            <li key={row.id} data-annotate-row={row.id}>
              <span className="foreshadow-annotate-name">{row.name}</span>
              {plantedHere(row) && <span className="chip">已埋于本章</span>}
              {paidHere(row) && <span className="chip">已回收于本章</span>}
              <span className="foreshadow-annotate-actions">
                <button
                  type="button"
                  className="link"
                  disabled={currentChapterId === null}
                  onClick={() => void annotate(row, "plant", plantedHere(row))}
                >
                  {plantedHere(row) ? "撤销埋设标注" : "埋设于本章"}
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={currentChapterId === null}
                  onClick={() => void annotate(row, "payoff", paidHere(row))}
                >
                  {paidHere(row) ? "撤销回收标注" : "回收于本章"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
