import type { FusionPreview } from "../../../src/shared/ipc";

/** 融合预演报告视图：新增 / 覆盖 / 冲突 三类 + ready 门禁（docs/03 §8.3） */
export function FusionReportView({ preview }: { preview: FusionPreview | null }) {
  if (!preview) {
    return <div className="muted pad">选择派系包后，这里会显示融合预演报告</div>;
  }

  const errors = preview.conflicts.filter((c) => c.severity === "error");
  const warns = preview.conflicts.filter((c) => c.severity === "warn");

  const byPiece = new Map<string, number>();
  for (const item of preview.added) {
    byPiece.set(item.piece, (byPiece.get(item.piece) ?? 0) + 1);
  }

  return (
    <div className="fusion">
      <div className={errors.length > 0 ? "badge bad" : "badge good"}>
        {errors.length > 0 ? `存在 ${errors.length} 项冲突，不可创建` : "融合预演通过，可确认创建"}
      </div>

      <section>
        <h4>四维并集</h4>
        <div className="fusion-axes muted">
          {(["channel", "world", "technique", "tone"] as const)
            .map((axis) => `${axis}: ${preview.genreAxes[axis].join("、") || "—"}`)
            .join(" ｜ ")}
          {preview.genreAxes.romance_mode_default
            ? ` ｜ 感情线: ${preview.genreAxes.romance_mode_default}`
            : ""}
        </div>
      </section>

      <section>
        <h4>新增（{preview.added.length}）</h4>
        <div className="chips">
          {[...byPiece.entries()].map(([piece, count]) => (
            <span className="chip static" key={piece}>
              {piece} × {count}
            </span>
          ))}
        </div>
      </section>

      {preview.overridden.length > 0 && (
        <section>
          <h4>覆盖（{preview.overridden.length}）</h4>
          <ul className="issues">
            {preview.overridden.map((item) => (
              <li key={`${item.piece}-${item.name}`} className="warn">
                {item.piece} / {item.name}：{item.refs.map((r) => r.pack).join(" → ")}（暂定胜出：
                {item.winner}）
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>冲突（{preview.conflicts.length}）</h4>
        {preview.conflicts.length === 0 && <div className="muted">无</div>}
        <ul className="issues">
          {errors.map((conflict, index) => (
            <li key={`e-${index}`} className="error-text">
              [{conflict.kind}] {conflict.message}
            </li>
          ))}
          {warns.map((conflict, index) => (
            <li key={`w-${index}`} className="warn">
              [{conflict.kind}] {conflict.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}