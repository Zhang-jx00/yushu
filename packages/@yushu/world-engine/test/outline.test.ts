import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "@yushu/schema";
import {
  OUTLINE_API_VERSION,
  OUTLINE_DOC_ID,
  OUTLINE_PATH,
  OutlineError,
  createChapterDraft,
  createEmptyOutline,
  createOutlineFromTemplate,
  normalizeOutline,
  outlineStats,
  parseOutline,
  parseOutlineTemplate,
  readChapterFile,
  serializeChapterFile,
  serializeOutline,
  templateActs,
  templateChaptersPerVolume,
  templateVolumeCount,
  type Outline,
} from "@yushu/world-engine";

/** 与 packs/xuanhuan-xitong/outlines/three-act-upgrade.yaml 同构的内联模板 */
const TEMPLATE_TEXT = `apiVersion: yushu.outlines/v1
id: three-act-upgrade
title: 三幕升级骨架
description: 一键生成的骨架
template:
  act1:
    name: 起
    desc: 废柴开局 → 金手指觉醒
    chapters_hint: 10-20
  act2:
    name: 承
    desc: 逐卷扩大地图与对手
    chapters_hint: 60% 总篇幅
  act3:
    name: 合
    desc: 回收主线承诺与伏笔
volume_template:
  suggested_volumes: 3-6
  per_volume:
    climax: 卷末大高潮
    hook: 卷末抛出下一卷舞台的悬念
    checklist: [本卷伏笔回收率, 爽点密度]
notes: 章纲细纲化到七要素
`;

function template() {
  return parseOutlineTemplate(TEMPLATE_TEXT);
}

describe("大纲模板解析（T1-11）", () => {
  it("解析幕结构与默认规模", () => {
    const t = template();
    expect(t.id).toBe("three-act-upgrade");
    expect(templateActs(t).map((a) => a.name)).toEqual(["起", "承", "合"]);
    expect(templateVolumeCount(t)).toBe(3); // "3-6" 取下限
    expect(templateChaptersPerVolume(t)).toBe(10); // "10-20" 取下限；"60% 总篇幅"不参与
    expect(t.notes).toContain("七要素");
  });

  it("apiVersion 不符 / 缺 template 时给出明确错误", () => {
    expect(() => parseOutlineTemplate("apiVersion: yushu.outlines/v2\nid: x\n")).toThrow(OutlineError);
    expect(() =>
      parseOutlineTemplate("apiVersion: yushu.outlines/v1\nid: x\n"),
    ).toThrowError(/缺少 template/);
  });
});

describe("模板一键生成三级大纲（T1-11）", () => {
  it("默认 3 卷 × 10 章骨架，卷按三幕分配，生成≠写死", () => {
    const outline = createOutlineFromTemplate({
      projectTitle: "天启界",
      template: template(),
      sourceRef: "xuanhuan-xitong/three-act-upgrade",
    });
    expect(outline.apiVersion).toBe(OUTLINE_API_VERSION);
    expect(outline.id).toBe(OUTLINE_DOC_ID);
    expect(outline.source_template).toBe("xuanhuan-xitong/three-act-upgrade");
    expect(outline.master.title).toBe("天启界");
    expect(outline.master.acts.map((a) => a.name)).toEqual(["起", "承", "合"]);
    expect(outlineStats(outline)).toEqual({ volumes: 3, chapters: 30 });
    expect(outline.volumes.map((v) => v.act)).toEqual(["起", "承", "合"]);
    expect(outline.volumes[0]?.title).toBe("第1卷·起");
    expect(outline.volumes[0]?.chapters[0]?.title).toBe("第1章（待拟题）");
    expect(outline.volumes[0]?.chapters[0]?.brief).toEqual({
      who: "",
      where: "",
      goal: "",
      obstacle: "",
      turn: "",
      result: "",
      hook: "",
    });
    expect(outline.volumes[0]?.climax).toBe("卷末大高潮");
    expect(outline.volumes[0]?.checklist).toContain("爽点密度");
    expect(outline.volumes[0]?.id.startsWith("vol-")).toBe(true);
    expect(outline.volumes[0]?.chapters[0]?.id.startsWith("co-")).toBe(true);
  });

  it("自定义卷数 6 时中幕占 4 卷；自定义每卷章数为 2", () => {
    const outline = createOutlineFromTemplate({
      projectTitle: "天启界",
      template: template(),
      volumeCount: 6,
      chaptersPerVolume: 2,
    });
    expect(outlineStats(outline)).toEqual({ volumes: 6, chapters: 12 });
    expect(outline.volumes.map((v) => v.act)).toEqual(["起", "承", "承", "承", "承", "合"]);
    expect(outline.volumes[1]?.chapters.map((c) => c.idx)).toEqual([1, 2]);
  });

  it("序列化-解析往返一致；非法文本被 schema 拦截", () => {
    const outline = createOutlineFromTemplate({ projectTitle: "天启界", template: template() });
    expect(parseOutline(serializeOutline(outline))).toEqual(outline);
    expect(() => parseOutline("apiVersion: yushu.outline/v2\nid: outline-main\n")).toThrow(
      SchemaValidationError,
    );
  });

  it("空项目名被拒绝", () => {
    expect(() =>
      createOutlineFromTemplate({ projectTitle: "  ", template: template() }),
    ).toThrowError(/项目名/);
  });

  it("空白大纲：默认三幕、零卷", () => {
    const outline = createEmptyOutline("天启界");
    expect(outline.volumes).toEqual([]);
    expect(outline.master.acts.map((a) => a.name)).toEqual(["起", "承", "合"]);
  });
});

describe("章纲排序归一（T1-12）", () => {
  it("重排后重编号 idx；新增条目补齐空 ID", () => {
    const outline = createOutlineFromTemplate({
      projectTitle: "天启界",
      template: template(),
      chaptersPerVolume: 3,
      volumeCount: 3,
    });
    const first = outline.volumes[0]!;
    // 模拟 UI：把第 1 章移到末尾，并新增一条空 ID 的章纲与一卷空 ID 的卷纲
    const reordered: Outline = {
      ...outline,
      volumes: [
        {
          ...first,
          chapters: [...first.chapters.slice(1), first.chapters[0]!, { ...first.chapters[0]!, id: "", title: "第四章（新）" }],
        },
        ...outline.volumes.slice(1),
        {
          id: "",
          title: "第4卷·新",
          act: "合",
          desc: "",
          chapters: [{ id: "", idx: 1, title: "新卷一", brief: { who: "", where: "", goal: "", obstacle: "", turn: "", result: "", hook: "" }, scene_ids: [] }],
        },
      ],
    };
    const normalized = normalizeOutline(reordered);
    const chapters = normalized.volumes[0]!.chapters;
    expect(chapters.map((c) => c.idx)).toEqual([1, 2, 3, 4]);
    expect(chapters[3]?.title).toBe("第四章（新）");
    expect(chapters[3]?.id.startsWith("co-")).toBe(true);
    const newVolume = normalized.volumes[3]!;
    expect(newVolume.id.startsWith("vol-")).toBe(true);
    expect(newVolume.chapters[0]?.id.startsWith("co-")).toBe(true);
    expect(() => serializeOutline(normalized)).not.toThrow();
  });

  it("重复章纲 ID 被检出（拒绝写入疑似损坏的数据）", () => {
    const outline = createOutlineFromTemplate({
      projectTitle: "天启界",
      template: template(),
      chaptersPerVolume: 2,
      volumeCount: 3,
    });
    const damaged: Outline = {
      ...outline,
      volumes: [
        {
          ...outline.volumes[0]!,
          chapters: [
            outline.volumes[0]!.chapters[0]!,
            { ...outline.volumes[0]!.chapters[1]!, id: outline.volumes[0]!.chapters[0]!.id },
          ],
        },
        ...outline.volumes.slice(1),
      ],
    };
    expect(() => serializeOutline(damaged)).toThrowError(/章纲 ID 重复/);
  });
});

describe("章节草稿（T1-12 细纲→草稿章节）", () => {
  it("创建草稿：ID 幂等、字段落位、文件往返一致", () => {
    const chapter = createChapterDraft({
      volume: "vol-abc",
      idx: 1,
      title: "第一章 废物少年",
      outlineRef: "co-xyz",
    });
    expect(chapter.id.startsWith("ch-")).toBe(true);
    expect(chapter.status).toBe("draft");
    expect(chapter.outline_ref).toBe("co-xyz");
    expect(chapter.word_count).toBe(0);

    const again = createChapterDraft({
      volume: "vol-abc",
      idx: 1,
      title: "第一章 废物少年",
      outlineRef: "co-xyz",
    });
    expect(again.id).toBe(chapter.id);

    const text = serializeChapterFile(chapter, "正文草稿……\n");
    const { chapter: parsed, body } = readChapterFile(text);
    expect(parsed).toEqual(chapter);
    expect(body).toBe("正文草稿……\n");
  });

  it("空标题被拒绝；非法文件抛 schema 错误", () => {
    expect(() =>
      createChapterDraft({ volume: "vol-a", idx: 1, title: "  ", outlineRef: "co-a" }),
    ).toThrow(SchemaValidationError);
    expect(() => readChapterFile("---\nid: ch-a\n---\n")).toThrow(SchemaValidationError);
  });
});

describe("大纲文件布局", () => {
  it("大纲路径为 outline/outline.yaml", () => {
    expect(OUTLINE_PATH).toBe("outline/outline.yaml");
  });
});