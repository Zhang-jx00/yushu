import { useEffect, useState } from "react";
import type { ProjectSnapshot } from "../../../src/shared/ipc";
import { AiView } from "./AiView";
import { ArchiveView } from "./ArchiveView";
import { ChapterEditorView } from "./ChapterEditorView";
import { ExportView } from "./ExportView";
import { GenesisView } from "./GenesisView";
import { OutlineView } from "./OutlineView";
import { ProjectView } from "./ProjectView";

type Tab = "workbench" | "outline" | "editor" | "ai" | "export" | "archive" | "files";

const TABS: { key: Tab; label: string }[] = [
  { key: "workbench", label: "起源工作台" },
  { key: "outline", label: "三级大纲" },
  { key: "editor", label: "编辑器" },
  { key: "ai", label: "AI 副驾" },
  { key: "export", label: "导出与自查" },
  { key: "archive", label: "世界观档案" },
  { key: "files", label: "项目文件" },
];

/** 项目主容器：七个标签页，跨页保留状态；实体提及可跨页跳转到档案（T2-2）；无干扰专注模式（T2-3 切片 A） */
export function ProjectScreen({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tab, setTab] = useState<Tab>("workbench");
  const [archiveFocus, setArchiveFocus] = useState<{ path: string; tick: number } | null>(null);
  /** 无干扰（专注）模式：隐藏顶栏 / 标签栏 / 侧栏与提及面板，只留正文；Esc 退出 */
  const [focusMode, setFocusMode] = useState(false);

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
        {tab === "workbench" && <GenesisView />}
        {tab === "outline" && <OutlineView />}
        {tab === "editor" && (
          <ChapterEditorView onOpenCard={openCardInArchive} focusMode={focusMode} onToggleFocus={setFocusMode} />
        )}
        {tab === "ai" && <AiView />}
        {tab === "export" && <ExportView />}
        {tab === "archive" && <ArchiveView focusCardPath={archiveFocus} />}
        {tab === "files" && <ProjectView snapshot={snapshot} />}
      </div>
    </div>
  );
}