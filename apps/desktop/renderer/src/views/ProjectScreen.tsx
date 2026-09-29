import { useState } from "react";
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

/** 项目主容器：七个标签页，跨页保留状态；实体提及可跨页跳转到档案（T2-2） */
export function ProjectScreen({ snapshot }: { snapshot: ProjectSnapshot }) {
  const [tab, setTab] = useState<Tab>("workbench");
  const [archiveFocus, setArchiveFocus] = useState<{ path: string; tick: number } | null>(null);

  const openCardInArchive = (path: string) => {
    setArchiveFocus({ path, tick: Date.now() });
    setTab("archive");
  };

  return (
    <div className="project-screen">
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
        {tab === "editor" && <ChapterEditorView onOpenCard={openCardInArchive} />}
        {tab === "ai" && <AiView />}
        {tab === "export" && <ExportView />}
        {tab === "archive" && <ArchiveView focusCardPath={archiveFocus} />}
        {tab === "files" && <ProjectView snapshot={snapshot} />}
      </div>
    </div>
  );
}