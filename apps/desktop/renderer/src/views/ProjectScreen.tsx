import { useEffect, useState } from "react";
import type { ProjectSnapshot, RecoveryEntry } from "../../../src/shared/ipc";
import { api } from "../api";
import { putPendingRecovery } from "../recovery-inbox";
import { AiView } from "./AiView";
import { ArchiveView } from "./ArchiveView";
import { ChapterEditorView } from "./ChapterEditorView";
import { ExportView } from "./ExportView";
import { GenesisView } from "./GenesisView";
import { OutlineView } from "./OutlineView";
import { ProjectView } from "./ProjectView";
import { StatsView } from "./StatsView";

type Tab = "workbench" | "outline" | "editor" | "ai" | "export" | "archive" | "files" | "stats";

const TABS: { key: Tab; label: string }[] = [
  { key: "workbench", label: "起源工作台" },
  { key: "outline", label: "三级大纲" },
  { key: "editor", label: "编辑器" },
  { key: "ai", label: "AI 副驾" },
  { key: "export", label: "导出与自查" },
  { key: "archive", label: "世界观档案" },
  { key: "stats", label: "码字统计" },
  { key: "files", label: "项目文件" },
];

/** 项目主容器：八个标签页，跨页保留状态；实体提及可跨页跳转到档案（T2-2）；无干扰专注模式（T2-3 切片 A） */
export function ProjectScreen({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tab, setTab] = useState<Tab>("workbench");
  const [archiveFocus, setArchiveFocus] = useState<{ path: string; tick: number } | null>(null);
  /** 无干扰（专注）模式：隐藏顶栏 / 标签栏 / 侧栏与提及面板，只留正文；Esc 退出 */
  const [focusMode, setFocusMode] = useState(false);
  /** 崩溃恢复（T2-8 切片 A）：进入项目（或切换项目）时检测编辑日志与磁盘不一致的未保存编辑 */
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
  const [recoveryFocus, setRecoveryFocus] = useState<{ path: string; tick: number } | null>(null);

  useEffect(() => {
    // snapshot.root 变化 = 打开了另一个项目：重新检测该项目的编辑日志
    void api()
      .recovery.list()
      .then((entries) => setRecovery(entries))
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
    <div className={focusMode ? "project-screen focus-mode" : "project-screen"}>
      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? "tab on" : "tab"}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="tab-body">
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
        {tab === "workbench" && <GenesisView />}
        {tab === "outline" && <OutlineView />}
        {tab === "editor" && (
          <ChapterEditorView
            onOpenCard={openCardInArchive}
            focusMode={focusMode}
            onToggleFocus={setFocusMode}
            recoveryFocus={recoveryFocus}
          />
        )}
        {tab === "ai" && <AiView />}
        {tab === "export" && <ExportView />}
        {tab === "archive" && <ArchiveView focusCardPath={archiveFocus} />}
        {tab === "stats" && <StatsView />}
        {tab === "files" && <ProjectView snapshot={snapshot} />}
      </div>
    </div>
  );
}