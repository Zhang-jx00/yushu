import { useCallback, useEffect, useState } from "react";
import type {
  OutlineBrief,
  OutlineChapterPayload,
  OutlineDocPayload,
  OutlineState,
  OutlineTemplateSummary,
  OutlineVolumePayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 三级大纲（T1-10 / T1-11 / T1-12）：
 * - 一键从派系包模板生成骨架（生成≠写死，可任意增删改）；
 * - 总纲 / 卷纲 / 章纲三级就地编辑；章纲按钮排序；
 * - 细纲一键创建草稿章节（回填 chapter_id，双向映射）。
 */

const BRIEF_FIELDS: { key: keyof OutlineBrief; label: string; placeholder: string }[] = [
  { key: "who", label: "谁", placeholder: "主角/对手/关键配角" },
  { key: "where", label: "在哪", placeholder: "场景与地理" },
  { key: "goal", label: "目标", placeholder: "本章要达成什么" },
  { key: "obstacle", label: "阻碍", placeholder: "谁/什么在阻止" },
  { key: "turn", label: "转折", placeholder: "意外与反转" },
  { key: "result", label: "结果", placeholder: "本章落点" },
  { key: "hook", label: "钩子", placeholder: "章末悬念（追读钩子）" },
];

function emptyBrief(): OutlineBrief {
  return { who: "", where: "", goal: "", obstacle: "", turn: "", result: "", hook: "" };
}

function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const temporary = next[index]!;
  next[index] = next[target]!;
  next[target] = temporary;
  return next;
}

export function OutlineView() {
  const [state, setState] = useState<OutlineState | null>(null);
  const [doc, setDoc] = useState<OutlineDocPayload | null>(null);
  const [hash, setHash] = useState<string | undefined>(undefined);
  const [worldTitle, setWorldTitle] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [volumeCount, setVolumeCount] = useState(3);
  const [chaptersPerVolume, setChaptersPerVolume] = useState(3);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
  const [expandedChapterId, setExpandedChapterId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = doc !== null && state?.doc !== undefined && JSON.stringify(doc) !== JSON.stringify(state.doc);

  const applyState = useCallback((next: OutlineState) => {
    setState(next);
    setDoc(next.doc ?? null);
    setHash(next.hash);
    setSelectedVolumeId((prev) =>
      prev && next.doc?.volumes.some((v) => v.id === prev) ? prev : (next.doc?.volumes[0]?.id ?? null),
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [outlineState, world] = await Promise.all([api().outline.read(), api().project.world()]);
      applyState(outlineState);
      if (world) setWorldTitle(world.title);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 模板加载后自动选中第一个可用模板，并同步其默认规模
  useEffect(() => {
    if (templateId) return;
    const first = (state?.templates ?? []).find((template) => !template.error);
    if (!first) return;
    setTemplateId(first.id);
    setVolumeCount(first.defaultVolumeCount);
    setChaptersPerVolume(first.defaultChaptersPerVolume);
  }, [state, templateId]);

  const templates: OutlineTemplateSummary[] = state?.templates ?? [];

  /** 选中模板后同步默认规模 */
  const chooseTemplate = (template: OutlineTemplateSummary) => {
    setTemplateId(template.id);
    setVolumeCount(template.defaultVolumeCount);
    setChaptersPerVolume(template.defaultChaptersPerVolume);
  };

  const projectTitle = () => worldTitle || doc?.master.title || "未命名作品";

  const generate = async () => {
    if (state?.exists && !confirm("重新生成将覆盖当前大纲（未保存的修改会丢失），确定继续？")) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().outline.generate({
        templateId,
        title: projectTitle(),
        volumeCount,
        chaptersPerVolume,
        ...(state?.exists ? { baseHash: hash } : {}),
      });
      setState((prev) => (prev ? { ...prev, exists: true, hash: result.hash, doc: result.doc } : prev));
      setDoc(result.doc);
      setHash(result.hash);
      setSelectedVolumeId(result.doc.volumes[0]?.id ?? null);
      setNotice(
        templateId
          ? `已生成 ${result.doc.volumes.length} 卷 / ${result.doc.volumes.reduce((n, v) => n + v.chapters.length, 0)} 章纲骨架 → ${result.path}`
          : `已创建空白大纲 → ${result.path}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().outline.write({ doc, baseHash: hash ?? "" });
      setDoc(result.doc);
      setHash(result.hash);
      setState((prev) => (prev ? { ...prev, doc: result.doc, hash: result.hash } : prev));
      setNotice("大纲已保存（baseHash 并发检测通过）");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createChapter = async (volumeId: string, chapterId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().outline.createChapter({ volumeId, chapterId, baseHash: hash ?? "" });
      setDoc(result.doc);
      setHash(result.hash);
      setState((prev) => (prev ? { ...prev, doc: result.doc, hash: result.hash } : prev));
      setNotice(
        `${result.reused ? "已复用既有草稿章节" : "已创建草稿章节"} → ${result.chapterPath}（章纲 chapter_id 已回填）`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 就地编辑 ---------- */

  const patchMaster = (patch: Partial<OutlineDocPayload["master"]>) =>
    setDoc((prev) => (prev ? { ...prev, master: { ...prev.master, ...patch } } : prev));

  const patchVolume = (volumeId: string, patch: Partial<OutlineVolumePayload>) =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            volumes: prev.volumes.map((volume) =>
              volume.id === volumeId ? { ...volume, ...patch } : volume,
            ),
          }
        : prev,
    );

  const patchChapter = (
    volumeId: string,
    chapterId: string,
    patch: Partial<OutlineChapterPayload>,
  ) =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            volumes: prev.volumes.map((volume) =>
              volume.id !== volumeId
                ? volume
                : {
                    ...volume,
                    chapters: volume.chapters.map((chapter) =>
                      chapter.id === chapterId ? { ...chapter, ...patch } : chapter,
                    ),
                  },
            ),
          }
        : prev,
    );

  const updateChapterBrief = (
    volumeId: string,
    chapterId: string,
    key: keyof OutlineBrief,
    value: string,
  ) =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            volumes: prev.volumes.map((volume) =>
              volume.id !== volumeId
                ? volume
                : {
                    ...volume,
                    chapters: volume.chapters.map((chapter) =>
                      chapter.id === chapterId
                        ? { ...chapter, brief: { ...chapter.brief, [key]: value } }
                        : chapter,
                    ),
                  },
            ),
          }
        : prev,
    );

  const addVolume = () =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            volumes: [
              ...prev.volumes,
              {
                id: "",
                title: `第${prev.volumes.length + 1}卷`,
                act: prev.master.acts[0]?.name ?? "起",
                desc: "",
                chapters: [],
              },
            ],
          }
        : prev,
    );

  const removeVolume = (volumeId: string) => {
    if (!confirm("删除该卷及其全部章纲？")) return;
    setDoc((prev) => (prev ? { ...prev, volumes: prev.volumes.filter((v) => v.id !== volumeId) } : prev));
  };

  const addChapter = (volumeId: string) =>
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            volumes: prev.volumes.map((volume) =>
              volume.id !== volumeId
                ? volume
                : {
                    ...volume,
                    chapters: [
                      ...volume.chapters,
                      {
                        id: "",
                        idx: volume.chapters.length + 1,
                        title: `第${volume.chapters.length + 1}章（待拟题）`,
                        brief: emptyBrief(),
                        scene_ids: [],
                      },
                    ],
                  },
            ),
          }
        : prev,
    );

  const selectedVolume = doc?.volumes.find((volume) => volume.id === selectedVolumeId) ?? null;

  return (
    <div className="outline">
      <aside>
        <section className="panel">
          <h3>
            模板生成 <span className="muted">T1-11</span>
          </h3>
          {templates.length === 0 && (
            <p className="muted">当前派系包未提供大纲模板（outline_templates），可直接创建空白大纲。</p>
          )}
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={template.id === templateId ? "pack on" : "pack"}
              disabled={Boolean(template.error)}
              onClick={() => chooseTemplate(template)}
            >
              <div className="pack-title">
                <strong>{template.title}</strong>
                <span className="muted">{template.packId}</span>
              </div>
              <div className="pack-axes muted">
                {template.acts.map((act) => act.name).join(" → ") || "（模板解析失败）"}
              </div>
              {template.error ? (
                <div className="error-text">{template.error}</div>
              ) : (
                <div className="muted">
                  默认 {template.defaultVolumeCount} 卷 × {template.defaultChaptersPerVolume} 章
                </div>
              )}
            </button>
          ))}
          <div className="outline-scale">
            <label className="field">
              <span>卷数</span>
              <input
                type="number"
                min={1}
                max={8}
                value={volumeCount}
                onChange={(event) => setVolumeCount(Number(event.target.value) || 1)}
              />
            </label>
            <label className="field">
              <span>每卷章数</span>
              <input
                type="number"
                min={1}
                max={50}
                value={chaptersPerVolume}
                onChange={(event) => setChaptersPerVolume(Number(event.target.value) || 1)}
              />
            </label>
          </div>
          <div className="outline-actions">
            <button type="button" className="primary" disabled={busy || !templateId} onClick={generate}>
              {state?.exists ? "重新生成（覆盖）" : "一键生成骨架"}
            </button>
            <button type="button" disabled={busy} onClick={generateEmpty}>
              空白创建
            </button>
          </div>
        </section>

        {doc && (
          <section className="panel">
            <h3>
              卷纲 <span className="muted">{doc.volumes.length} 卷</span>
            </h3>
            <ul className="volume-list">
              {doc.volumes.map((volume, index) => (
                <li
                  key={`${volume.id || "new"}:${index}`}
                  className={volume.id === selectedVolumeId ? "on" : ""}
                  onClick={() => setSelectedVolumeId(volume.id)}
                >
                  <div className="volume-row">
                    <span>
                      <strong>{volume.title}</strong>
                      <span className="muted"> · {volume.act}</span>
                    </span>
                    <span className="volume-tools">
                      <button
                        type="button"
                        className="link"
                        title="上移"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDoc((prev) =>
                            prev ? { ...prev, volumes: moveItem(prev.volumes, index, -1) } : prev,
                          );
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link"
                        title="下移"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDoc((prev) =>
                            prev ? { ...prev, volumes: moveItem(prev.volumes, index, 1) } : prev,
                          );
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="link"
                        title="删除本卷"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeVolume(volume.id);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  <div className="muted">{volume.chapters.length} 章纲</div>
                </li>
              ))}
            </ul>
            <button type="button" onClick={addVolume}>
              ＋ 添加卷
            </button>
          </section>
        )}
      </aside>

      <section>
        {!doc && (
          <div className="panel">
            <h3>尚无大纲</h3>
            <p className="muted">
              选择左侧派系包模板一键生成「总纲 → 卷纲 → 章纲」骨架；生成后全部字段均可自由修改，
              模板只作为起点（生成≠写死）。
            </p>
          </div>
        )}

        {doc && (
          <>
            <div className="panel">
              <h3>
                总纲 <span className="muted">{doc.source_template ? `来源模板：${doc.source_template}` : "手工创建"}</span>
              </h3>
              <div className="master-grid">
                <label className="field">
                  <span>书名 / 项目名</span>
                  <input
                    value={doc.master.title}
                    onChange={(event) => patchMaster({ title: event.target.value })}
                  />
                </label>
                <label className="field grow">
                  <span>一句话卖点（logline）</span>
                  <input
                    value={doc.master.logline}
                    placeholder="如：废柴少年得系统，于末法之世重燃剑道"
                    onChange={(event) => patchMaster({ logline: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>主题</span>
                  <input
                    value={doc.master.theme}
                    placeholder="如：逆天改命与代价"
                    onChange={(event) => patchMaster({ theme: event.target.value })}
                  />
                </label>
              </div>
              <div className="acts">
                {doc.master.acts.map((act) => (
                  <span key={act.name} className="badge" title={act.desc}>
                    {act.name}
                    {act.chapters_hint ? `（${act.chapters_hint}）` : ""}
                  </span>
                ))}
              </div>
              <label className="field">
                <span>总纲备注</span>
                <textarea
                  rows={2}
                  value={doc.master.notes}
                  onChange={(event) => patchMaster({ notes: event.target.value })}
                />
              </label>
            </div>

            {selectedVolume && (
              <div className="panel">
                <h3>
                  卷纲 <span className="muted">第 {doc.volumes.indexOf(selectedVolume) + 1} 卷</span>
                </h3>
                <div className="master-grid">
                  <label className="field">
                    <span>卷名</span>
                    <input
                      value={selectedVolume.title}
                      onChange={(event) => patchVolume(selectedVolume.id, { title: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>所属幕</span>
                    <select
                      value={selectedVolume.act}
                      onChange={(event) => patchVolume(selectedVolume.id, { act: event.target.value })}
                    >
                      {[
                        ...doc.master.acts.map((act) => act.name),
                        ...(doc.master.acts.some((act) => act.name === selectedVolume.act)
                          ? []
                          : [selectedVolume.act]),
                      ].map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>本卷主线</span>
                  <textarea
                    rows={2}
                    value={selectedVolume.desc}
                    onChange={(event) => patchVolume(selectedVolume.id, { desc: event.target.value })}
                  />
                </label>
                <div className="master-grid">
                  <label className="field grow">
                    <span>卷末高潮</span>
                    <input
                      value={selectedVolume.climax ?? ""}
                      onChange={(event) => patchVolume(selectedVolume.id, { climax: event.target.value })}
                    />
                  </label>
                  <label className="field grow">
                    <span>卷末钩子</span>
                    <input
                      value={selectedVolume.hook ?? ""}
                      onChange={(event) => patchVolume(selectedVolume.id, { hook: event.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>自检清单（逗号分隔）</span>
                  <input
                    value={(selectedVolume.checklist ?? []).join("，")}
                    onChange={(event) =>
                      patchVolume(selectedVolume.id, {
                        checklist: event.target.value
                          .split(/[,，]/)
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>

                <h3 className="chapter-head">
                  章纲 <span className="muted">{selectedVolume.chapters.length} 章（↑↓ 排序，保存时自动重编号）</span>
                </h3>
                <ul className="chapter-list">
                  {selectedVolume.chapters.map((chapter, index) => {
                    const expanded = chapter.id === expandedChapterId;
                    return (
                      <li key={`${chapter.id || "new"}:${index}`} className={expanded ? "on" : ""}>
                        <div className="chapter-row">
                          <span className="chapter-idx">{index + 1}</span>
                          <input
                            className="chapter-title"
                            value={chapter.title}
                            onChange={(event) =>
                              patchChapter(selectedVolume.id, chapter.id, { title: event.target.value })
                            }
                          />
                          <span className="volume-tools">
                            <button
                              type="button"
                              className="link"
                              title="上移"
                              onClick={() =>
                                setDoc((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        volumes: prev.volumes.map((volume) =>
                                          volume.id !== selectedVolume.id
                                            ? volume
                                            : { ...volume, chapters: moveItem(volume.chapters, index, -1) },
                                        ),
                                      }
                                    : prev,
                                )
                              }
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="link"
                              title="下移"
                              onClick={() =>
                                setDoc((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        volumes: prev.volumes.map((volume) =>
                                          volume.id !== selectedVolume.id
                                            ? volume
                                            : { ...volume, chapters: moveItem(volume.chapters, index, 1) },
                                        ),
                                      }
                                    : prev,
                                )
                              }
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="link"
                              title="删除本章纲"
                              onClick={() =>
                                setDoc((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        volumes: prev.volumes.map((volume) =>
                                          volume.id !== selectedVolume.id
                                            ? volume
                                            : {
                                                ...volume,
                                                chapters: volume.chapters.filter((c) => c.id !== chapter.id),
                                              },
                                        ),
                                      }
                                    : prev,
                                )
                              }
                            >
                              ✕
                            </button>
                            <button
                              type="button"
                              className="link"
                              onClick={() => setExpandedChapterId(expanded ? null : chapter.id)}
                            >
                              {expanded ? "收起细纲" : "细纲"}
                            </button>
                          </span>
                          {chapter.chapter_id ? (
                            <span className="badge good" title={chapter.chapter_id}>
                              草稿章节已建
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy || !chapter.id || dirty}
                              title={dirty ? "请先保存大纲，再创建草稿章节" : "创建草稿章节并回填映射"}
                              onClick={() => createChapter(selectedVolume.id, chapter.id)}
                            >
                              创建草稿章节
                            </button>
                          )}
                        </div>
                        {expanded && (
                          <div className="brief-grid">
                            {BRIEF_FIELDS.map((field) => (
                              <label className="field" key={field.key}>
                                <span>{field.label}</span>
                                <input
                                  value={chapter.brief[field.key]}
                                  placeholder={field.placeholder}
                                  onChange={(event) =>
                                    updateChapterBrief(
                                      selectedVolume.id,
                                      chapter.id,
                                      field.key,
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                            ))}
                            {chapter.chapter_id && (
                              <div className="muted">chapter_id：{chapter.chapter_id}（与章节 outline_ref 双向映射）</div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <button type="button" onClick={() => addChapter(selectedVolume.id)}>
                  ＋ 添加章纲
                </button>
              </div>
            )}

            <div className="outline-foot">
              <button type="button" className="primary" disabled={busy || !dirty} onClick={save}>
                保存大纲
              </button>
              <button type="button" disabled={busy} onClick={refresh}>
                重新载入
              </button>
              {dirty && <span className="dirty">有未保存修改</span>}
              {notice && <span className="muted">{notice}</span>}
              {error && <span className="error-text">{error}</span>}
            </div>
          </>
        )}

        {!doc && error && <div className="error-bar">{error}</div>}
      </section>
    </div>
  );

  async function generateEmpty() {
    if (!confirm(state?.exists ? "空白创建将覆盖当前大纲，确定继续？" : "创建空白大纲（不使用模板）？")) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api().outline.generate({
        templateId: "",
        title: projectTitle(),
        ...(state?.exists ? { baseHash: hash } : {}),
      });
      setState((prev) => (prev ? { ...prev, exists: true, hash: result.hash, doc: result.doc } : prev));
      setDoc(result.doc);
      setHash(result.hash);
      setSelectedVolumeId(result.doc.volumes[0]?.id ?? null);
      setNotice(`已创建空白大纲 → ${result.path}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
}