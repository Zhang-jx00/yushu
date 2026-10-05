import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { AiDraftTarget } from "../../../src/shared/ipc";
import { api } from "../api";
import { findUnsupportedSyntax, htmlToMd, mdToHtml } from "../markdown-bridge";
import { collectMentionedEntities, type EntityIndexEntry } from "../entity-mentions";
import { entityMentionPlugin } from "../entity-mention-plugin";
import { createAutosaveScheduler, type AutosaveScheduler, type AutosaveState } from "../autosave";
import { registerEditorFlusher } from "../editor-flush";
import { createRecoveryJournalScheduler, type RecoveryJournalScheduler } from "../recovery-journal";
import { takePendingRecovery } from "../recovery-inbox";
import { cardTypeLabel, layerLabel } from "../card-labels";

/**
 * 章节编辑器（T2-1：CodeMirror 6 源码形态 + TipTap 富文本形态；T2-2 实体 @ 提及）。
 * - 磁盘真源始终是 chapters/<卷>/<章>.md（Markdown 文本）；两种形态是同一文本的两种视图；
 * - 富文本形态由 StarterKit 承载（标题/粗斜/引用/列表/分隔线）；检测到暂不支持的语法（表格/代码块/图片/链接/HTML）
 *   会先提示再由用户决定，避免往返丢数据；
 * - 保存经 chapter:write：同步 word_count（与导出对账同口径）+ baseHash 并发检测；
 * - 保存管线（T2-6 切片）：编辑即登记自动保存（防抖 800ms / 高频上限 5s），
 *   失焦与切换章节前 flush；冲突冻结时提供「写入旁路文件」与「重新载入」两条人工处置路径；
 * - 实体提及（T2-2）：正文 `@名称`/`@别名` 在源码形态高亮（悬停提示，Ctrl/⌘+点击打开设定卡），
 *   底部「本章提及」面板可一键跳转档案（点击跳转由 ProjectScreen 协调）。
 */

/** UI 预演（--ui-walkthrough）经 window.__yushuDebug 暴露的调试句柄（生产不设置该标志则不可见） */
type DebugWindow = Window & {
  __yushuDebug?: boolean;
  __yushuCmView?: EditorView | null;
  /** reload 精确等待重载完成（预演同步点）；doc 读取当前编辑器文本 */
  __yushuEditorDebug?: { reload: () => Promise<void>; doc: () => string };
};

/** 与 @yushu/core countWords 同口径（去空白字符数）——渲染层不 import 引擎包，保持零依赖约定 */
function localCountWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** 双栏对照的卡片摘要（复核修复 2026-09-30）：清洗 Markdown 标记 → 单段纯文本 → 截断加省略号 */
function excerptOf(body: string): string {
  const plain = body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
}

/** 把光标所在行滚动到视口垂直居中（打字机滚动；T2-3 切片 A） */
function centerLine(view: EditorView): void {
  const pos = view.state.selection.main.head;
  const block = view.lineBlockAt(pos);
  const viewport = view.scrollDOM.clientHeight;
  const target = Math.max(0, block.top + block.height / 2 - viewport / 2);
  // 阈值防抖动：滚动本身不产生 ViewUpdate，不会自激循环
  if (Math.abs(view.scrollDOM.scrollTop - target) > 24) {
    view.scrollDOM.scrollTop = target;
  }
}

/** 打字机滚动插件：仅在启用时（专注模式）随输入 / 光标移动保持光标行居中 */
function typewriterScrollExtension(enabled: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!enabled()) return;
        if (!update.docChanged && !update.selectionSet) return;
        centerLine(update.view);
      }
    },
  );
}

type EditorMode = "source" | "rich";

/** 双栏对照（T2-3 切片 B）：本章提及的设定卡 + 正文摘要（只读） */
interface MentionCardData {
  id: string;
  name: string;
  type: string;
  layer: string;
  filePath: string;
  aliases: string[];
  excerpt: string;
}

export function ChapterEditorView({
  onOpenCard,
  focusMode = false,
  onToggleFocus,
  recoveryFocus,
}: {
  onOpenCard?: (path: string) => void;
  /** 无干扰（专注）模式：由 ProjectScreen 统一隐藏顶栏 / 标签栏 / 侧栏（T2-3 切片 A） */
  focusMode?: boolean;
  onToggleFocus?: (next: boolean) => void;
  /** 崩溃恢复入口（T2-8 切片 A）：ProjectScreen 恢复面板跳转目标（tick 触发；经 selectTarget 先 flush 再切换） */
  recoveryFocus?: { path: string; tick: number } | null;
}) {
  const [targets, setTargets] = useState<AiDraftTarget[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savedBody, setSavedBody] = useState<string>("");
  const [liveWords, setLiveWords] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<EditorMode>("source");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("选择左侧草稿章节开始写作");
  const [error, setError] = useState<string | null>(null);
  const [entities, setEntities] = useState<EntityIndexEntry[]>([]);
  const [mentioned, setMentioned] = useState<EntityIndexEntry[]>([]);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** 双栏对照开关（T2-3 切片 B）与本章设定卡数据 */
  const [splitView, setSplitView] = useState(false);
  const [mentionCards, setMentionCards] = useState<MentionCardData[]>([]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedBodyRef = useRef("");
  const modeRef = useRef<EditorMode>("source");
  const entitiesRef = useRef<EntityIndexEntry[]>([]);
  const onOpenCardRef = useRef<((path: string) => void) | undefined>(onOpenCard);
  const mentionCompartment = useRef(new Compartment());
  const schedulerRef = useRef<AutosaveScheduler | null>(null);
  /** 自动保存闭包读取的最新值（不依赖 React 渲染时序，避免保存到过期章节/hash） */
  const selectedPathRef = useRef<string | null>(null);
  const hashRef = useRef("");
  const dirtyRef = useRef(false);
  const performSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const loadChapterRef = useRef<(path: string, options?: { force?: boolean }) => Promise<void>>(async () => undefined);
  /** updateDerived 的最新引用（实体列表晚于内容加载时补算提及；复核修复 2026-09-30） */
  const updateDerivedRef = useRef<(text: string) => void>(() => undefined);
  /** 最后成功载入的章节（编辑器内容所属章节）；载入竞态回滚选择时使用 */
  const loadedPathRef = useRef<string | null>(null);
  /** 竞态回滚选择后跳过该次自动加载（避免用旧选择再次触发重载） */
  const skipAutoLoadRef = useRef<string | null>(null);
  /** 用户已确认「丢弃未保存改动」时，下一次加载该章节走 force（跳过竞态保护；复核修复 2026-09-30） */
  const forceLoadRef = useRef<string | null>(null);
  /** 专注模式标记（供 CM 打字机滚动插件读取，避免插件随 prop 重建） */
  const focusModeRef = useRef(focusMode);
  /**
   * 最近一次编辑快照（第 12 轮复核修复）：卸载清理阶段形态编辑器可能已先被销毁
   * （清理执行顺序不确定），此时 flush 仍须落盘最后输入——以快照兜底读取正文。
   */
  const latestMarkdownRef = useRef("");

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    focusModeRef.current = focusMode;
    // 进入专注模式时立即居中一次（此后由打字机滚动插件维持）
    if (focusMode) {
      const view = viewRef.current;
      if (view) centerLine(view);
    }
  }, [focusMode]);
  useEffect(() => {
    onOpenCardRef.current = onOpenCard;
  }, [onOpenCard]);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  /**
   * 自动保存调度器（T2-6 切片）：惰性创建一次；save 经 performSaveRef 读取最新渲染闭包。
   * 保存失败（如 baseHash 冲突）进入冻结态不自动重试，由 UI 引导旁路/重载。
   */
  const getScheduler = useCallback((): AutosaveScheduler => {
    if (!schedulerRef.current) {
      schedulerRef.current = createAutosaveScheduler({
        save: () => performSaveRef.current(),
        onChange: (state, detail) => {
          setAutosaveState(state);
          if (state === "saved") {
            setSavedAt(detail?.savedAt ?? Date.now());
            setError(null);
          }
          if (state === "error" && detail?.error) {
            setError(
              detail.error.includes("E_DOC_CONFLICT")
                ? `${detail.error} —— 自动保存已暂停：可「写入旁路文件」保留当前内容，或「重新载入」磁盘最新版本后再编辑`
                : detail.error,
            );
          }
        },
      });
    }
    return schedulerRef.current;
  }, []);

  const journalRef = useRef<RecoveryJournalScheduler | null>(null);

  /**
   * 编辑日志（T2-8 切片 A）：输入期间以固定间隔（500ms）把当前正文快照写入 .yushu/recovery/——
   * 进程被杀 / 崩溃时最多丢失该间隔内的输入；保存成功后取消并清除 journal 文件。
   */
  const getJournal = useCallback((): RecoveryJournalScheduler => {
    if (!journalRef.current) {
      journalRef.current = createRecoveryJournalScheduler({
        // 失败时让 Promise 拒绝（由调度器保留待写文本、下一轮重试）；无选中章节则为空操作
        write: (text) => {
          const path = selectedPathRef.current;
          if (!path) return Promise.resolve();
          return api()
            .recovery.writeJournal({ path, body: text })
            .then(() => undefined);
        },
      });
    }
    return journalRef.current;
  }, []);

  // 关闭窗口前 flush（T2-6 完整版）：把「落盘待发改动」注册到全局注册表，供 App 的关闭处理器调用；
  // 返回调度器状态快照（主进程日志诊断：是否确有待发改动、是否落盘成功）
  useEffect(
    () =>
      registerEditorFlusher(async () => {
        const scheduler = getScheduler();
        const before = scheduler.state();
        const snapshot = `path=${selectedPathRef.current ?? "(none)"} dirty=${dirtyRef.current} docLen=${viewRef.current?.state.doc.length ?? -1}`;
        await scheduler.flush();
        return `scheduler ${before}→${scheduler.state()}；${snapshot}`;
      }),
    [getScheduler],
  );

  // 切页（组件卸载）立即落盘（第 12 轮复核修复）：消除"切页后 800ms 防抖窗口内关窗"的丢稿窗口——
  // 切页时关闭前 flush 的注册表随卸载清空，若此时窗口被关闭将没有 flush 路径覆盖待发改动。
  // 注：渲染层 reload / 进程被杀不触发 React 卸载清理（该场景由 T2-8 编辑日志覆盖）。
  useEffect(
    () => () => {
      void getScheduler().flush();
      getJournal().dispose(); // T2-8：停掉日志定时器（journal 文件保留；flush 落盘成功后会清除它）
    },
    [getScheduler, getJournal],
  );

  const refreshEntities = useCallback(async () => {
    try {
      const cards = await api().card.list();
      const list: EntityIndexEntry[] = cards
        .filter((card) => !card.error)
        .map((card) => ({
          id: card.id,
          name: card.name,
          aliases: card.aliases,
          type: card.type,
          layer: card.layer,
          filePath: card.path,
        }));
      entitiesRef.current = list;
      setEntities(list);
      const view = viewRef.current;
      if (view) {
        // 实体列表变化：重配提及装饰插件（回调通过 ref 读取最新依赖）
        view.dispatch({
          effects: mentionCompartment.current.reconfigure(
            entityMentionPlugin({
              getEntities: () => entitiesRef.current,
              onOpen: (entity) => onOpenCardRef.current?.(entity.filePath),
            }).plugin,
          ),
        });
        // 复核修复 2026-09-30：实体列表可能晚于章节内容加载（重挂载竞态），
        // 就绪后按当前内容补算一次提及（否则面板/设定栏会空到用户再次输入为止）
        const text = view.state.doc.toString();
        if (text) updateDerivedRef.current(text);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const updateDerived = useCallback(
    (text: string) => {
      latestMarkdownRef.current = text;
      setLiveWords(localCountWords(text));
      const nextDirty = text !== savedBodyRef.current;
      dirtyRef.current = nextDirty;
      setDirty(nextDirty);
      setMentioned(collectMentionedEntities(text, entitiesRef.current));
      // T2-6：文本有变化即登记自动保存（防抖 800ms / 高频上限 5s）；还原为磁盘态则撤销待发保存
      if (nextDirty) {
        getScheduler().schedule();
        getJournal().note(text); // T2-8：编辑日志（500ms 快照，崩溃恢复用）
      } else {
        getScheduler().cancel();
        getJournal().cancel(); // 回到磁盘态：取消待发日志（已存在的 journal 文件不动，供异常终止场景恢复）
      }
    },
    [getScheduler, getJournal],
  );
  updateDerivedRef.current = updateDerived;

  const refreshTargets = useCallback(async () => {
    try {
      const list = await api().ai.drafts();
      setTargets(list);
      setSelectedPath((prev) =>
        prev && list.some((item) => item.chapterPath === prev) ? prev : (list[0]?.chapterPath ?? null),
      );
      return list;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshTargets();
    void refreshEntities();
  }, [refreshTargets, refreshEntities]);

  // 源码形态：CodeMirror 实例（一次创建；实体提及装饰走 Compartment，便于实体列表变化后重配）
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          mentionCompartment.current.of([]),
          // 打字机滚动（T2-3 切片 A）：仅在专注模式下把光标行保持居中
          typewriterScrollExtension(() => focusModeRef.current),
          // 失焦立即落盘（T2-6：把"杀进程丢稿"窗口压到最短）
          EditorView.domEventHandlers({
            blur: () => {
              void getScheduler().flush();
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            updateDerived(update.state.doc.toString());
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    // UI 预演调试句柄（--ui-walkthrough）：仅在 __yushuDebug 时暴露
    const debugWindow = window as DebugWindow;
    if (debugWindow.__yushuDebug) debugWindow.__yushuCmView = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      if (debugWindow.__yushuCmView === view) debugWindow.__yushuCmView = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 富文本形态：TipTap（StarterKit）；更新时序列化回 Markdown 参与 dirty/字数统计
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    onUpdate: ({ editor: instance }) => {
      if (modeRef.current !== "rich") return;
      updateDerived(htmlToMd(instance.getHTML()));
    },
  });

  // 富文本形态失焦同样立即落盘（与源码形态的 blur 行为一致）
  useEffect(() => {
    if (!editor) return;
    const onBlur = () => {
      void getScheduler().flush();
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor, getScheduler]);

  /** 当前正文（第 12 轮复核修复：兜底「最近一次编辑快照」——卸载清理阶段编辑器可能已被先销毁，仍能落盘最后输入） */
  const currentMarkdown = (): string => {
    if (modeRef.current === "rich") {
      if (editor && !editor.isDestroyed) return htmlToMd(editor.getHTML());
    } else if (viewRef.current) {
      return viewRef.current.state.doc.toString();
    }
    return latestMarkdownRef.current;
  };

  const loadChapter = useCallback(
    async (path: string, options?: { force?: boolean }) => {
      try {
        setError(null);
        const chapter = await api().chapter.read(path);
        const view = viewRef.current;
        // 载入竞态保护（复核修复 2026-09-29）：读取磁盘期间用户已开始输入 —— 绝不用磁盘内容覆盖刚敲的字；
        // force = 用户主动「重新载入 / 同值点击章节」，视为明确要求回到磁盘态
        if (!options?.force && view && view.state.doc.toString() !== savedBodyRef.current) {
          const loaded = loadedPathRef.current;
          if (loaded && loaded !== path) {
            // 选择已前移但内容仍属于旧章节：把选择回滚到内容所属章节，保持「内容 ↔ 选择」一致，
            // 用户刚敲的字继续归属旧章节、自动保存可正常落盘（避免错位后误写新章节）
            skipAutoLoadRef.current = loaded;
            setSelectedPath(loaded);
            setStatus(`已取到 ${path} 的磁盘版本，但载入期间编辑器已有新输入：已保留输入并保持在原章节（未切换）`);
          } else {
            setStatus(
              "已取到磁盘最新版本，但载入期间编辑器已有新输入：已保留输入未覆盖（如需查看磁盘版本请点「重新载入」）",
            );
          }
          return;
        }
        loadedPathRef.current = path;
        // 崩溃恢复（T2-8 切片 A）：守卫之后取收件箱（有恢复内容时以其为初始正文——savedBody / hash
        // 仍记磁盘正文 → 内容呈「脏」态，随后的自动保存把恢复内容落盘）
        const recovered = takePendingRecovery(path);
        const initialBody = recovered ?? chapter.body;
        if (view) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initialBody } });
        }
        editor?.commands.setContent(mdToHtml(initialBody));
        savedBodyRef.current = chapter.body;
        setSavedBody(chapter.body);
        hashRef.current = chapter.hash;
        updateDerived(initialBody);
        setStatus(
          recovered !== null
            ? `已载入崩溃前未保存内容（${localCountWords(initialBody)} 字；磁盘为 ${chapter.wordCount} 字）——即将自动保存`
            : `已载入 ${path}（记录 ${chapter.wordCount} 字）`,
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [editor, updateDerived],
  );
  loadChapterRef.current = loadChapter;

  /**
   * 切换 / 重新载入章节（T2-6）：先 flush 把待自动保存的改动落盘再切换 —— 不再走"丢稿式"确认；
   * 仅当自动保存已冻结（写入冲突、flush 无法完成）时才提示可能丢失，由用户决定是否强制继续。
   */
  const selectTarget = (path: string) => {
    void (async () => {
      const scheduler = getScheduler();
      await scheduler.flush();
      if (scheduler.state() === "error") {
        const prefix = dirty ? "当前章自动保存失败（写入冲突）：继续将丢弃未保存的改动" : "当前章自动保存失败（写入冲突）";
        if (!confirm(`${prefix}。仍要继续？`)) return;
        // 用户已确认丢弃未保存改动：本次加载走 force，避免载入竞态保护再次拦截（复核修复 2026-09-30）
        forceLoadRef.current = path;
      }
      if (path === selectedPath) {
        // 同值点击 = 强制重新载入（外部改动 / 冲突后的恢复路径；force 绕过载入竞态保护）
        forceLoadRef.current = null; // 此分支已显式 force，无需标记
        void loadChapter(path, { force: true });
        return;
      }
      setSelectedPath(path);
    })();
  };

  const selected = targets.find((item) => item.chapterPath === selectedPath) ?? null;

  const selectTargetRef = useRef<(path: string) => void>(() => undefined);
  selectTargetRef.current = selectTarget;

  // 崩溃恢复入口（T2-8 切片 A）：恢复面板跳转 → 经 selectTarget 选中该章节
  // （先 flush 当前章再切换，避免载入竞态保护拦截；loadChapter 随后从收件箱取恢复内容）
  useEffect(() => {
    if (recoveryFocus) selectTargetRef.current(recoveryFocus.path);
  }, [recoveryFocus]);

  useEffect(() => {
    // 竞态回滚选择：本次 selectedPath 变化由回滚产生，跳过自动加载（编辑器内容本就属于该章节）
    if (skipAutoLoadRef.current !== null && skipAutoLoadRef.current === selectedPath) {
      skipAutoLoadRef.current = null;
      return;
    }
    // 用户确认「丢弃未保存改动」后的强制加载（复核修复 2026-09-30）
    const force = forceLoadRef.current === selectedPath;
    if (force) forceLoadRef.current = null;
    if (selectedPath) void loadChapter(selectedPath, { force });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  // 双栏对照（T2-3 切片 B）：加载本章提及的设定卡与正文摘要（按提及集合去重，避免每次输入重复读卡）
  const mentionedKey = mentioned.map((item) => item.id).join(",");
  useEffect(() => {
    if (!splitView) {
      setMentionCards([]);
      return;
    }
    let alive = true;
    void (async () => {
      const loaded = await Promise.all(
        mentioned.map(async (entity) => {
          try {
            const card = await api().card.read(entity.filePath);
            return { ...entity, excerpt: excerptOf(card.body) };
          } catch {
            return { ...entity, excerpt: "（读取失败，可在档案页查看）" };
          }
        }),
      );
      if (alive) setMentionCards(loaded);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitView, mentionedKey]);

  // UI 预演调试句柄（--ui-walkthrough；仅 __yushuDebug 时暴露）：reload 精确等待重载完成，避免预演竞态
  useEffect(() => {
    const debugWindow = window as DebugWindow;
    if (!debugWindow.__yushuDebug) return;
    debugWindow.__yushuEditorDebug = {
      reload: async () => {
        const path = selectedPathRef.current;
        if (path) await loadChapterRef.current(path, { force: true });
      },
      doc: () => viewRef.current?.state.doc.toString() ?? "",
    };
    return () => {
      delete debugWindow.__yushuEditorDebug;
    };
  }, []);

  const switchToRich = () => {
    if (!editor || mode === "rich") return;
    const mdText = viewRef.current?.state.doc.toString() ?? "";
    const unsupported = findUnsupportedSyntax(mdText);
    if (unsupported.length > 0) {
      const detail = unsupported.map((item) => `${item.label}（如：${item.sample}）`).join("；");
      if (
        !confirm(
          `富文本形态暂不支持：${detail}。\n继续切换可能造成这些格式在切回源码时丢失，建议保持源码形态。仍要切换吗？`,
        )
      ) {
        return;
      }
    }
    editor.commands.setContent(mdToHtml(mdText));
    setMode("rich");
    setStatus("已切换到富文本形态（保存仍写回 Markdown 真源）");
  };

  const switchToSource = () => {
    if (!editor || mode === "source") return;
    const mdText = htmlToMd(editor.getHTML());
    const view = viewRef.current;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: mdText } });
      // 复核修复（2026-09-29）：CM 在 display:none 期间尺寸测量失效，切回时强制重新测量
      view.requestMeasure();
    }
    setMode("source");
    setStatus("已切回源码形态（Markdown）");
  };

  /** 保存正文（自动保存与手动保存共用；失败会抛出，由调度器进入冻结态/UI 呈现） */
  const performSave = async (): Promise<void> => {
    const path = selectedPathRef.current;
    if (!path || !dirtyRef.current) return;
    const body = currentMarkdown();
    const result = await api().chapter.write({ path, body, baseHash: hashRef.current });
    // T2-8：保存成功 = 编辑日志使命完成（取消待发写入 + 清除 journal 文件）
    getJournal().cancel();
    void api()
      .recovery.clearJournal(path)
      .catch(() => undefined);
    savedBodyRef.current = body;
    hashRef.current = result.hash;
    dirtyRef.current = false;
    setSavedBody(body);
    setDirty(false);
    setStatus(`已保存 ${result.path}（${result.wordCount} 字，frontmatter 已同步）`);
    await refreshTargets();
  };
  performSaveRef.current = performSave;

  const save = async () => {
    if (!selectedPath) return;
    setError(null);
    // 手动保存 = flush：若已有自动保存在途则等待其完成，避免并发双写（baseHash 只有一个赢家）
    await getScheduler().flush();
  };

  /** 冲突旁路（T2-6）：把当前编辑内容另存 <章节>.conflict-<时间戳>.md，主文件不动 */
  const writeSidecar = async () => {
    if (!selectedPath) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api().chapter.writeSidecar({ path: selectedPath, body: currentMarkdown() });
      setStatus(
        `冲突内容已写入旁路文件 ${result.sidecarPath}（${result.wordCount} 字）；建议「重新载入」磁盘版本后手动合并`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const autosaveLabel = (): string => {
    switch (autosaveState) {
      case "pending":
        return "编辑中…";
      case "saving":
        return "保存中…";
      case "saved":
        return savedAt
          ? `已自动保存 ${new Date(savedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
          : "已自动保存";
      case "error":
        return "自动保存已暂停（冲突）";
      default:
        return "自动保存待命";
    }
  };

  return (
    <div className="chapter-editor">
      <aside>
        <div className="panel-title">
          <span className="muted">草稿章节（{targets.length}）</span>
          <button type="button" className="link" onClick={() => void refreshTargets()}>
            刷新
          </button>
        </div>
        {targets.length === 0 && (
          <p className="muted pad">
            尚无草稿章节：请先在「三级大纲」为章纲点击「创建草稿章节」。
          </p>
        )}
        <ul className="draft-list">
          {targets.map((target) => (
            <li
              key={target.chapterPath}
              className={target.chapterPath === selectedPath ? "on" : ""}
              onClick={() => selectTarget(target.chapterPath)}
            >
              <div>
                <strong>{target.title}</strong>
                <span className="muted">{target.wordCount} 字</span>
              </div>
              <div className="muted">
                {target.volumeTitle} · 第 {target.idx} 章{target.hasBody ? "" : "（空正文）"}
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section className={splitView ? "editor split-on" : "editor"}>
        <div className="panel-title">
          <span className="muted">
            {selected ? selected.chapterPath : "未选择章节"}
            {dirty && (
              <span className="dirty">
                {" "}｜ {autosaveState === "error" ? "未保存（自动保存已暂停）" : "编辑中（待自动保存）"}
              </span>
            )}
          </span>
          <span className="mode-switch">
            <button
              type="button"
              className="link"
              onClick={() => {
                if (!selectedPath) return;
                // 先 flush 落盘再重载；仅冲突冻结时确认后强制重载（T2-6）
                selectTarget(selectedPath);
              }}
              disabled={!selectedPath}
            >
              重新载入
            </button>
            <button
              type="button"
              className={mode === "source" ? "on" : ""}
              onClick={switchToSource}
              disabled={mode === "source"}
            >
              源码形态
            </button>
            <button
              type="button"
              className={mode === "rich" ? "on" : ""}
              onClick={switchToRich}
              disabled={mode === "rich" || !editor}
            >
              富文本形态
            </button>
            <button
              type="button"
              className={focusMode ? "on" : ""}
              onClick={() => onToggleFocus?.(!focusMode)}
              disabled={!selectedPath}
              title="隐藏顶栏 / 标签栏 / 侧栏，只留正文；Esc 退出"
            >
              专注模式
            </button>
            <button
              type="button"
              className={splitView ? "on" : ""}
              onClick={() => setSplitView((value) => !value)}
              disabled={!selectedPath}
              title="左设定右正文：显示本章提及的设定卡与正文摘要"
            >
              双栏对照
            </button>
            <span className="muted">
              实时 {liveWords} 字（记录 {localCountWords(savedBody)} 字）
            </span>
          </span>
        </div>
        <div className="editor-main">
          {splitView && (
            <aside className="setting-column">
              <div className="panel-title">
                <span className="muted">本章设定（{mentionCards.length}）</span>
              </div>
              {mentionCards.length === 0 && (
                <p className="muted pad">
                  本章尚未提及已建档实体：在正文中用 <code>@名称</code> 引用后自动出现在这里。
                </p>
              )}
              {mentionCards.map((card) => (
                <div key={card.id} className="setting-card">
                  <div className="setting-card-head">
                    <strong>{card.name}</strong>
                    <span className="muted">
                      {cardTypeLabel(card.type)}｜{layerLabel(card.layer)}
                    </span>
                  </div>
                  {card.aliases.length > 0 && <div className="muted">别名：{card.aliases.join("、")}</div>}
                  <p className="setting-excerpt">{card.excerpt || "（卡片暂无正文）"}</p>
                  <button type="button" className="link" onClick={() => onOpenCard?.(card.filePath)}>
                    打开设定卡
                  </button>
                </div>
              ))}
            </aside>
          )}
          <div className="editor-body">
            <div className="cm-host" ref={hostRef} style={{ display: mode === "source" ? undefined : "none" }} />
            {mode === "rich" && (
              <div className="tiptap-host">
                <EditorContent editor={editor} />
              </div>
            )}
          </div>
        </div>
        <div className="mention-panel">
          <span className="muted">本章提及（{mentioned.length}）：</span>
          {mentioned.length === 0 && (
            <span className="muted">
              在正文中用 <code>@名称</code> 引用已建档实体
              {entities[0] ? `（如 @${entities[0].name}）` : "（先在「世界观档案」建档）"}
              ；源码形态下 Ctrl/⌘+点击可打开设定卡
            </span>
          )}
          {mentioned.map((entity) => (
            <button
              key={entity.id}
              type="button"
              className="mention-chip"
              title={`${cardTypeLabel(entity.type)}｜${entity.filePath}`}
              onClick={() => onOpenCard?.(entity.filePath)}
            >
              {entity.name}
            </button>
          ))}
        </div>
        <div className="editor-foot">
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={busy || autosaveState === "saving" || !dirty || autosaveState === "error"}
          >
            {busy || autosaveState === "saving" ? "保存中…" : "保存正文（baseHash + 字数同步）"}
          </button>
          <span className={`autosave-status ${autosaveState}`} title="编辑即自动保存；失焦与切换章节前会立即落盘">
            {autosaveLabel()}
          </span>
          {autosaveState === "error" && (
            <button type="button" onClick={() => void writeSidecar()} disabled={busy}>
              写入旁路文件
            </button>
          )}
          <span className="muted">T2-1：源码（Markdown）/ 富文本（TipTap）双形态，真源始终为 Markdown</span>
          {error ? <span className="error-text">{error}</span> : <span className="muted">{status}</span>}
        </div>
      </section>
      {focusMode && (
        <div className="focus-hint">
          专注模式 · {mode === "source" ? "打字机滚动已开启" : "打字机滚动仅源码形态"} · 按 Esc 退出
        </div>
      )}
    </div>
  );
}