import { useEffect, useState } from "react";
import type { ChronicleBookPayload } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 编年史面板（M4 / T4-8，R71）：只读。
 *
 * 显示的是**同一套刻度的两种口径**：`年份` 列走历法换算，`刻度` 列是内部数字年——
 * 两者并列是故意的，免得读者把"帝国纪年 1204"当成真源里存的数（真源只有 0）。
 * 多文化事件按文化各占一行，分歧行标出来；没有多文化版本的事件标"中性记载"而不是留空，
 * 因为"作者没写"与"写了但内容为空"是两回事。
 */

export function ChronologyPanel() {
  const [book, setBook] = useState<ChronicleBookPayload | null>(null);
  const [calendar, setCalendar] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api()
      .chronicle.book(calendar === "" ? {} : { calendar })
      .then((result) => {
        if (alive) setBook(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [calendar]);

  const divergenceOf = (eventId: string) => book?.divergences.find((d) => d.eventId === eventId) ?? null;
  const eraOf = (year: number) => book?.eras.find((era) => year >= era.from && year < era.to) ?? null;

  return (
    <section className="panel chronology-panel">
      <div className="panel-title">
        编年史（只读 · 伪史书：同一事件按文化各记一行）
        {book !== null && book.calendars.length > 0 && (
          <select className="chronology-calendar" value={calendar} onChange={(event) => setCalendar(event.target.value)}>
            <option value="">按各时间线自己的历法</option>
            {book.calendars.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}（offset {item.offset}）
              </option>
            ))}
          </select>
        )}
      </div>
      {error !== "" && <div className="error-text">{error}</div>}
      {book !== null && error === "" && (
        <>
          <div className="chronology-summary muted">{book.note}</div>
          {book.entries.length > 0 && (
            <table className="slot-table chronology-table">
              <thead>
                <tr>
                  <th>时代</th>
                  <th>年份</th>
                  <th>刻度</th>
                  <th>事件</th>
                  <th>视角</th>
                  <th>记载</th>
                </tr>
              </thead>
              <tbody>
                {book.entries.map((entry, index) => {
                  const divergence = divergenceOf(entry.eventId);
                  return (
                    <tr key={`${entry.eventId}-${entry.culture ?? "-"}-${index}`}>
                      <td>{eraOf(entry.year)?.label ?? "—"}</td>
                      <td>{entry.displayYear ?? "历法未识别"}</td>
                      <td>{entry.year}</td>
                      <td>
                        {entry.title}
                        {divergence !== null && (
                          <span className={divergence.differing ? "chronology-flag diff" : "chronology-flag same"}>
                            {divergence.differing ? `分歧 ${divergence.cultures.length}` : "诸说一致"}
                          </span>
                        )}
                      </td>
                      <td>{entry.culture ?? "中性记载"}</td>
                      <td>{entry.account ?? "—"}{entry.source !== null ? <span className="muted">（{entry.source}）</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {book.eraSkipped.length > 0 && (
            <div className="chronology-notices">
              这些 era 卡没写 <code>extensions.chronicle.{"{from,to}"}</code>，因此不参与分段（引擎不猜年代边界）：
              {book.eraSkipped.join("、")}
            </div>
          )}
          {book.uneraled.length > 0 && (
            <div className="chronology-notices">落不进任何时代的事件：{book.uneraled.join("、")}</div>
          )}
          {book.ambiguousEra && <div className="chronology-notices">时代区间有重叠，重合年份按给出顺序归入前一段</div>}
          {book.orphanEvents.length > 0 && (
            <div className="chronology-notices">
              事件写了合法时间线却没被任何时间线的 events[] 列出：{book.orphanEvents.join("、")}
            </div>
          )}
          {book.withoutViewpoints.length > 0 && (
            <div className="chronology-notices">
              只有单一记载（无多文化版本）的事件 {book.withoutViewpoints.length} 个：{book.withoutViewpoints.slice(0, 8).join("、")}
              {book.withoutViewpoints.length > 8 ? "…" : ""}
            </div>
          )}
        </>
      )}
    </section>
  );
}
