import { useEffect, useState } from "react";
import type {
  AxisValues,
  FusionPreview,
  PackCatalog,
  ProjectSnapshot,
} from "../../../src/shared/ipc";
import { api } from "../api";
import { AxisPicker } from "../components/AxisPicker";
import { FusionReportView } from "../components/FusionReportView";

interface Props {
  onCancel: () => void;
  onCreated: (snapshot: ProjectSnapshot) => void;
}

const EMPTY_AXES: AxisValues = { channel: [], world: [], technique: [], tone: [] };

/** 新建项目向导（T1-3/T1-4）：派系包多选 → 融合预演 → 四维修订 → 确认创建 */
export function WizardView({ onCancel, onCreated }: Props) {
  const [catalog, setCatalog] = useState<PackCatalog | null>(null);
  const [title, setTitle] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [axes, setAxes] = useState<AxisValues>(EMPTY_AXES);
  const [preview, setPreview] = useState<FusionPreview | null>(null);
  const [fuseError, setFuseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api()
      .pack.catalog()
      .then(setCatalog)
      .catch((err: Error) => setError(err.message));
  }, []);

  // 派系包选择变化 → 触发融合预演（未确认前不落库）
  useEffect(() => {
    if (selected.length === 0) {
      setPreview(null);
      setFuseError(null);
      return;
    }
    let alive = true;
    api()
      .pack.fuse(selected)
      .then((result) => {
        if (!alive) return;
        setPreview(result);
        setFuseError(null);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setPreview(null);
        setFuseError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  // 首次获得融合结果且四维尚未填写 → 自动填充（此后由用户掌控，可随时"以融合结果填充"重填）
  useEffect(() => {
    if (!preview) return;
    setAxes((prev) => {
      const untouched =
        !prev.channel.length &&
        !prev.world.length &&
        !prev.technique.length &&
        !prev.tone.length &&
        !prev.romance_mode_default;
      return untouched ? { ...preview.genreAxes } : prev;
    });
  }, [preview]);

  const togglePack = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const chooseDir = async () => {
    try {
      const picked = await api().project.chooseDirectory();
      if (picked) setDir(picked);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const canCreate = Boolean(title.trim() && dir && selected.length > 0 && preview?.ready && !busy);

  const create = async () => {
    if (!dir || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = await api().project.create({
        dir,
        title: title.trim(),
        packIds: selected,
        axes,
      });
      onCreated(snapshot);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h2>新建项目</h2>
        <span className="muted">四维派系可多选、可修改；融合冲突未解决前不会写入项目</span>
      </div>

      <div className="wizard-row">
        <label className="field">
          <span>项目名</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：天启界"
          />
        </label>
        <label className="field grow">
          <span>存放目录</span>
          <div className="dir-row">
            <input value={dir ?? ""} readOnly placeholder="点击右侧选择目录" />
            <button type="button" onClick={chooseDir}>
              选择…
            </button>
          </div>
        </label>
      </div>

      <div className="wizard-grid">
        <section className="panel">
          <h3>派系包（可多选）</h3>
          {!catalog && <div className="muted pad">加载中…</div>}
          {catalog?.packs.map((pack) => (
            <button
              key={pack.id}
              type="button"
              className={selected.includes(pack.id) ? "pack on" : "pack"}
              onClick={() => togglePack(pack.id)}
            >
              <div className="pack-title">
                <strong>{pack.name}</strong>
                <span className="muted">
                  {pack.id} · v{pack.version}
                </span>
              </div>
              <div className="muted pack-axes">
                {[
                  ...pack.genreAxes.channel,
                  ...pack.genreAxes.world,
                  ...pack.genreAxes.technique,
                  ...pack.genreAxes.tone,
                ].join(" / ")}
              </div>
              {!pack.lint.ok && <div className="pack-lint">⚠ {pack.lint.messages[0]}</div>}
            </button>
          ))}
          {catalog && catalog.packs.length === 0 && (
            <div className="muted pad">未发现内置派系包（packs/ 目录为空）</div>
          )}
        </section>

        <section className="panel">
          <h3>融合预演</h3>
          {fuseError ? (
            <div className="error-text">{fuseError}</div>
          ) : (
            <FusionReportView preview={preview} />
          )}
          {preview && (
            <button type="button" className="link" onClick={() => setAxes({ ...preview.genreAxes })}>
              以融合结果填充四维 ↓
            </button>
          )}
        </section>
      </div>

      {catalog && (
        <section className="panel">
          <h3>
            四维选择 <span className="muted">（同维多选；融合结果为初始值，可自由修改）</span>
          </h3>
          <div className="axes">
            <AxisPicker
              label="频道维"
              options={catalog.wordlist.channel}
              value={axes.channel}
              onChange={(value) => setAxes({ ...axes, channel: value })}
            />
            <AxisPicker
              label="世界维"
              options={catalog.wordlist.world}
              value={axes.world}
              onChange={(value) => setAxes({ ...axes, world: value })}
            />
            <AxisPicker
              label="手法维"
              options={catalog.wordlist.technique}
              value={axes.technique}
              onChange={(value) => setAxes({ ...axes, technique: value })}
            />
            <AxisPicker
              label="基调维"
              options={catalog.wordlist.tone}
              value={axes.tone}
              onChange={(value) => setAxes({ ...axes, tone: value })}
            />
            <AxisPicker
              label="感情线"
              hint="独立开关"
              options={catalog.wordlist.romance}
              value={axes.romance_mode_default ? [axes.romance_mode_default] : []}
              onChange={(value) =>
                setAxes({ ...axes, romance_mode_default: value[value.length - 1] })
              }
            />
          </div>
        </section>
      )}

      <footer className="wizard-foot">
        {error && <span className="error-text">{error}</span>}
        <span className="spacer" />
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="primary" onClick={create} disabled={!canCreate}>
          {busy ? "创建中…" : "创建项目"}
        </button>
      </footer>
    </div>
  );
}