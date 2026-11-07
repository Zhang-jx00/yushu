/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useMemo, useState } from "react";
import type { ProjectSnapshot, RecoveryEntry, SessionStatusPayload } from "../../../src/shared/ipc";
import { api } from "../api";
import { YushuIcon, type YushuIconName } from "../icons";
import { putPendingRecovery } from "../recovery-inbox";
import { AiView } from "./AiView";
import { ArchiveView } from "./ArchiveView";
import { ChapterEditorView } from "./ChapterEditorView";
import { ExportView } from "./ExportView";
import { GenesisView } from "./GenesisView";
import { LibraryView } from "./LibraryView";
import { MemoryView } from "./MemoryView";
import { OutlineView } from "./OutlineView";
import { ProjectView } from "./ProjectView";
import { RulesView } from "./RulesView";
import { StatsView } from "./StatsView";
import { ShortcutPanel } from "../components/ShortcutPanel";
import { CommandPalette } from "../components/CommandPalette";

type Tab = "workbench" | "outline" | "editor" | "library" | "ai" | "memory" | "rules" | "export" | "archive" | "files" | "stats";

/** R173-UI：导航**按任务域分组**（五域：创作 / 世界 / AI / 质检与发布 / 文件）——
 *  项的 key/label/icon 与旧 TABS 逐字一致（预演 131 步按文字找 `.tab` ⇒ 改名即翻红）。 */
const DOMAINS: { id: string; label: string; items: { key: Tab; label: string; icon: YushuIconName }[] }[] = [
  {
    id: "create",
    label: "创作域",
    items: [
      { key: "editor", label: "编辑器", icon: "pen-line" },
      { key: "outline", label: "三级大纲", icon: "list-ordered" },
      { key: "library", label: "稿件总览", icon: "library" },
    ],
  },
  {
    id: "world",
    label: "世界域",
    items: [
      { key: "workbench", label: "起源工作台", icon: "layers" },
      { key: "archive", label: "世界观档案", icon: "book-open" },
    ],
  },
  {
    id: "ai",
    label: "AI 域",
    items: [
      { key: "ai", label: "AI 副驾", icon: "sparkles" },
      { key: "memory", label: "记忆", icon: "brain" },
    ],
  },
  {
    id: "review",
    label: "质检与发布",
    items: [
      { key: "rules", label: "规则", icon: "scale" },
      { key: "export", label: "导出与自查", icon: "download" },
      { key: "stats", label: "码字统计", icon: "chart-column" },
    ],
  },
  {
    id: "files",
    label: "文件域",
    items: [{ key: "files", label: "项目文件", icon: "folder-tree" }],
  },
];

/** 扁平导航项（命令面板的动作集与"当前页名"都从这里取 ⇒ 同一份清单不出两处） */
const NAV_ITEMS = DOMAINS.flatMap((domain) => domain.items);

/** 项目主容器：十一个标签页，跨页保留状态；实体提及可跨页跳转到档案（T2-2）；无干扰专注模式（T2-3 切片 A）；稿件总览全库视图（T2-4 切片 A）；记忆页（T3-5） */
export function ProjectScreen({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tab, setTab] = useState<Tab>("workbench");
  const [archiveFocus, setArchiveFocus] = useState<{ path: string; tick: number } | null>(null);
  /** 无干扰（专注）模式：隐藏顶栏 / 标签栏 / 侧栏与提及面板，只留正文；Esc 退出 */
  const [focusMode, setFocusMode] = useState(false);
  /** 崩溃恢复（T2-8 切片 A）：进入项目（或切换项目）时检测编辑日志与磁盘不一致的未保存编辑 */
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
  const [recoveryFocus, setRecoveryFocus] = useState<{ path: string; tick: number } | null>(null);
  /** 稿件总览（T2-4 切片 A）：点「打开」跳转编辑器并选中该章 */
  const [libraryFocus, setLibraryFocus] = useState<{ path: string; tick: number } | null>(null);
  /** 会话异常退出检测（T2-8 切片 B）：仅在检出「上次会话异常退出」时展示提示 */
  const [session, setSession] = useState<SessionStatusPayload | null>(null);
  /** 「键盘在哪」面板（R157）：作者记不住哪个键在哪儿能按 ⇒ 给一个入口 */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** R173-UI：导航 rail **折叠**（图标态）——用户级偏好，localStorage 记忆（与密度/主题同族） */
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem("yushu.ui.rail") === "collapsed",
  );
  /** R173-UI：**命令面板**（Ctrl/Cmd+K）——跳转与高频动作的统一入口 */
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleNav = () => {
    setNavCollapsed((prev) => {
      const collapsed = !prev;
      localStorage.setItem("yushu.ui.rail", collapsed ? "collapsed" : "expanded");
      return collapsed;
    });
  };

  // 命令面板的全局键（Ctrl/Cmd+K）：登记见 shortcuts.ts（判据按 probe 对账；
  // 判定写成 `.key === "k"` 的形态——快捷键登记表的扫描器按这个口径对账）
  useEffect(() => {
    const onPaletteKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "k") {
          event.preventDefault();
          setPaletteOpen((open) => !open);
        }
      }
    };
    window.addEventListener("keydown", onPaletteKey);
    return () => window.removeEventListener("keydown", onPaletteKey);
  }, []);

  const currentNav = NAV_ITEMS.find((item) => item.key === tab) ?? NAV_ITEMS[0]!;

  const paletteActions = useMemo(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: `nav-${item.key}`,
        label: item.label,
        hint: "跳转",
        run: () => setTab(item.key),
      })),
      {
        id: "focus-mode",
        label: focusMode ? "退出专注模式" : "进入专注模式",
        hint: "编辑器",
        run: () => {
          setTab("editor");
          setFocusMode((prev) => !prev);
        },
      },
      { id: "shortcuts", label: "快捷键一览", hint: "帮助", run: () => setShortcutsOpen(true) },
    ],
    [focusMode],
  );

  useEffect(() => {
    // snapshot.root 变化 = 打开了另一个项目：重新检测该项目的编辑日志
    void api()
      .recovery.list()
      .then((entries) => setRecovery(entries))
      .catch(() => undefined);
    // 同时读取本次打开项目时检出的「上次会话异常退出」与快照新鲜度（脏快照提示）
    void api()
      .session.status()
      .then((status) => setSession(status.abnormalExit ? status : null))
      .catch(() => undefined);
  }, [snapshot.root]);

  const restoreEntry = (entry: RecoveryEntry) => {
    void (async () => {
      // 第 13 轮复核修复：面板条目可能已过期——进入项目后该章又被编辑并保存（journal 已被保存
      // 成功清除），或内容已与磁盘一致被自愈清除。恢复前用同一检测逻辑复核：
      // 条目已失效则不再恢复，避免把过期内容载入编辑器、经自动保存覆盖更新版本的正文。
      let fresh: RecoveryEntry[];
      try {
        fresh = await api().recovery.list();
      } catch {
        return; // 检测失败：不冒险恢复（面板保持原样，下次进入项目自动重试）
      }
      const hit = fresh.find((item) => item.path === entry.path);
      if (!hit) {
        setRecovery(fresh); // 同步为最新列表（过期条目随之移除）
        return;
      }
      // 投递到收件箱 → 编辑器载入该章节时取出（脏态呈现，随后自动保存落盘）
      putPendingRecovery(hit.path, hit.body);
      setRecovery(fresh.filter((item) => item.path !== hit.path));
      setRecoveryFocus({ path: hit.path, tick: Date.now() });
      setTab("editor");
    })();
  };

  const discardEntry = async (entry: RecoveryEntry) => {
    try {
      await api().recovery.discard(entry.path);
    } catch {
      /* 丢弃失败不阻塞面板更新（journal 文件仍保留，下次进入项目会再提示） */
    }
    setRecovery((prev) => prev.filter((item) => item.path !== entry.path));
  };

  const openCardInArchive = (path: string) => {
    setArchiveFocus({ path, tick: Date.now() });
    setTab("archive");
  };

  useEffect(() => {
    if (!focusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode]);

  // 离开编辑器页时退出专注模式（避免其他页处于无导航状态）
  useEffect(() => {
    if (tab !== "editor") setFocusMode(false);
  }, [tab]);

  return (
    <div
      className={
        (focusMode ? "project-screen focus-mode" : "project-screen") +
        (tab === "editor" ? " editor-mode" : "")
      }
    >
      {/* R173-UI：**分组导航 rail**——五域分组，可折叠为图标态（用户级记忆）。
          `.tab` 类名与文字保留：预演 131 步按文字找 `.tab` ⇒ DOM 重构不换名，助跳零改动。 */}
      <nav className={"tabs" + (navCollapsed ? " nav-collapsed" : "")} aria-label="页面导航">
        <div className="rail-brand" aria-hidden="true">
          <YushuIcon name="book-open" size={18} />
        </div>
        {DOMAINS.map((domain) => (
          <div className="nav-domain" key={domain.id}>
            <div className="nav-domain-label">{domain.label}</div>
            {domain.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={tab === item.key ? "tab on" : "tab"}
                data-nav-key={item.key}
                title={item.label}
                aria-current={tab === item.key ? "page" : undefined}
                onClick={() => setTab(item.key)}
              >
                <YushuIcon name={item.icon} />
                <span className="tab-label">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <button
            type="button"
            className="nav-tool"
            aria-label="打开命令面板（Ctrl+K）"
            title="命令面板（Ctrl+K）"
            onClick={() => setPaletteOpen(true)}
          >
            <YushuIcon name="command" />
          </button>
          <button
            type="button"
            className="nav-tool"
            aria-expanded={!navCollapsed}
            aria-label={navCollapsed ? "展开导航" : "折叠导航"}
            title={navCollapsed ? "展开导航" : "折叠导航"}
            onClick={toggleNav}
          >
            <YushuIcon name={navCollapsed ? "panel-left-open" : "panel-left-close"} />
          </button>
        </div>
      </nav>
      <div className="project-main">
        <div className="context-bar">
          <span className="context-title">{currentNav.label}</span>
          <span className="spacer" />
          <button
            type="button"
            className="link"
            aria-label="打开命令面板（Ctrl+K）"
            onClick={() => setPaletteOpen(true)}
          >
            <YushuIcon name="search" /> 命令面板
          </button>
          {/* R157：键盘在哪 —— 真按钮（键盘也能到 ⇒ 键盘债 0） */}
          <button
            type="button"
            className="shortcut-trigger"
            aria-expanded={shortcutsOpen}
            onClick={() => setShortcutsOpen((open) => !open)}
          >
            键盘在哪
          </button>
        </div>
        <div className="tab-body">
        {shortcutsOpen && <ShortcutPanel onClose={() => setShortcutsOpen(false)} />}
        {session?.abnormalExit && (
          <div className="session-banner">
            <div className="recovery-title">
              检测到上次会话未正常退出（开始于 {session.abnormalExit.startedAt.replace("T", " ").slice(0, 19)}）
            </div>
            <div className="muted">
              {session.snapshotStale || !session.lastSnapshot
                ? "最近快照早于上次会话退出（或无快照），可能不含崩溃前的最后修改；如发现内容缺失，可在「项目文件 → 本地快照」回退，或检查章节旁的 .conflict-*.md 旁路文件。"
                : `最近快照 ${session.lastSnapshot.createdAt.replace("T", " ").slice(0, 19)} 可在「项目文件 → 本地快照」整体回退。`}
            </div>
          </div>
        )}
        {recovery.length > 0 && (
          <div className="recovery-banner">
            <div className="recovery-title">
              检测到 {recovery.length} 份崩溃前的未保存编辑（编辑日志 .yushu/recovery）
            </div>
            <ul>
              {recovery.map((entry) => (
                <li key={entry.path}>
                  <span className="muted">
                    {entry.path} · {entry.wordCount} 字 · {entry.updatedAt.replace("T", " ").slice(0, 19)}
                  </span>
                  <span className="spacer" />
                  <button type="button" onClick={() => restoreEntry(entry)}>
                    恢复
                  </button>
                  <button type="button" onClick={() => void discardEntry(entry)}>
                    丢弃
                  </button>
                </li>
              ))}
            </ul>
            <div className="muted">恢复 = 载入编辑器并自动保存（仅当内容与磁盘不一致时提示，绝不静默覆盖）</div>
          </div>
        )}
        {tab === "workbench" && <GenesisView onNavigate={(next) => setTab(next as Tab)} />}
        {tab === "outline" && <OutlineView />}
        {tab === "editor" && (
          <ChapterEditorView
            onOpenCard={openCardInArchive}
            focusMode={focusMode}
            onToggleFocus={setFocusMode}
            recoveryFocus={recoveryFocus}
            libraryFocus={libraryFocus}
          />
        )}
        {tab === "library" && (
          <LibraryView
            onOpen={(path) => {
              setLibraryFocus({ path, tick: Date.now() });
              setTab("editor");
            }}
          />
        )}
        {tab === "ai" && <AiView />}
        {tab === "memory" && <MemoryView />}
        {tab === "rules" && <RulesView onOpenCard={openCardInArchive} />}
        {tab === "export" && <ExportView />}
        {tab === "archive" && <ArchiveView focusCardPath={archiveFocus} />}
        {tab === "stats" && <StatsView />}
        {tab === "files" && <ProjectView snapshot={snapshot} />}
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
    </div>
  );
}