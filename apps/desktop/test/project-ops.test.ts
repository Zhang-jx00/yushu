import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OUTLINE_PATH,
  PROJECT_CONFIG_PATH,
  WORLD_CONFIG_PATH,
  parseOutline,
  parseProjectConfig,
  parseWorldConfig,
  readChapterFile,
} from "@yushu/world-engine";
import {
  buildFusionPreview,
  buildPackCatalog,
  createOutlineChapter,
  createProject,
  generateOutline,
  listCards,
  readCardDoc,
  readOutlineState,
  writeCardDoc,
  writeOutline,
} from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-project-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

describe("派系包目录与融合预演", () => {
  it("目录包含内置派系包与四维词表，且内置包 lint 通过", async () => {
    const catalog = await buildPackCatalog();
    expect(catalog.packs.map((p) => p.id)).toContain("xuanhuan-xitong");
    expect(catalog.wordlist.channel).toContain("男频");
    expect(catalog.wordlist.romance).toContain("无女主");
    const builtin = catalog.packs.find((p) => p.id === "xuanhuan-xitong");
    expect(builtin?.lint.ok).toBe(true);
  });

  it("融合预演返回四维并集且 ready=true", async () => {
    const preview = await buildFusionPreview(["xuanhuan-xitong"]);
    expect(preview.ready).toBe(true);
    expect(preview.genreAxes.world).toEqual(["玄幻"]);
    expect(preview.genreAxes.technique).toEqual(["系统流"]);
    expect(preview.added.length).toBeGreaterThan(0);
  });

  it("未知派系包给出明确错误", async () => {
    await expect(buildFusionPreview(["not-exist-pack"])).rejects.toThrowError(/找不到派系包/);
  });
});

describe("createProject 落盘", () => {
  it("写入 world.yaml 与 project.toml，且可解析回读", async () => {
    const snapshot = await createProject({
      dir,
      title: "天启界",
      packIds: ["xuanhuan-xitong"],
      axes: AXES,
    });
    const paths = snapshot.tree.map((t) => t.path);
    expect(paths).toEqual(expect.arrayContaining([WORLD_CONFIG_PATH, PROJECT_CONFIG_PATH]));

    const world = parseWorldConfig(await readFile(join(dir, WORLD_CONFIG_PATH), "utf8"));
    expect(world.title).toBe("天启界");
    expect(world.genre_axes.channel).toEqual(["男频"]);
    expect(world.genre_axes.romance_mode_default).toBe("无女主");

    const config = parseProjectConfig(await readFile(join(dir, PROJECT_CONFIG_PATH), "utf8"));
    expect(config.project.name).toBe("天启界");
    expect(config.genre.packs).toEqual(["xuanhuan-xitong"]);
    expect(config.genre.world).toEqual(["玄幻"]);
  });

  it("重复创建同一目录被拒绝", async () => {
    await createProject({ dir, title: "A", packIds: ["xuanhuan-xitong"], axes: AXES });
    await expect(
      createProject({ dir, title: "B", packIds: ["xuanhuan-xitong"], axes: AXES }),
    ).rejects.toThrowError(/已存在御书项目/);
  });

  it("空项目名 / 空派系包选择被拒绝", async () => {
    await expect(
      createProject({ dir, title: "  ", packIds: ["xuanhuan-xitong"], axes: AXES }),
    ).rejects.toThrowError(/项目名不能为空/);
    await expect(createProject({ dir, title: "x", packIds: [], axes: AXES })).rejects.toThrowError(
      /至少选择一个派系包/,
    );
  });
});

describe("设定卡 CRUD（T1-6 / T1-7 / T1-9）", () => {
  async function newProjectGateway(): Promise<ProjectGateway> {
    await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
    return new ProjectGateway(dir);
  }

  it("写入后可被 listCards 读到，路径按 type 归档", async () => {
    const gateway = await newProjectGateway();
    const result = await writeCardDoc(gateway, {
      card: { type: "character", name: "林渊", layer: "characters" },
      body: "## 问卷回答\n\n- **出身**：边城少年\n",
    });
    expect(result.path.startsWith("world/cards/character/char-")).toBe(true);

    const cards = await listCards(gateway);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("林渊");
    expect(cards[0]?.type).toBe("character");
    expect(cards[0]?.layer).toBe("characters");
  });

  it("重复新建同一卡冲突；携带 baseHash 可更新", async () => {
    const gateway = await newProjectGateway();
    const created = await writeCardDoc(gateway, {
      card: { type: "law", name: "灵气法则", layer: "laws" },
      body: "",
    });
    await expect(
      writeCardDoc(gateway, {
        path: created.path,
        card: { type: "law", name: "灵气法则", layer: "laws" },
        body: "重复创建",
      }),
    ).rejects.toMatchObject({ code: "E_DOC_CONFLICT" });

    const read = await readCardDoc(gateway, created.path);
    const updated = await writeCardDoc(gateway, {
      path: created.path,
      baseHash: read.hash,
      card: { ...read.card, name: "灵气与代价" },
      body: "更新后的正文",
    });
    expect(updated.hash).not.toBe(read.hash);
    const reread = await readCardDoc(gateway, created.path);
    expect(reread.card.name).toBe("灵气与代价");
    expect(reread.body).toBe("更新后的正文\n");
  });

  it("扩展卡校验：境界条目缺必填项被阻断，合法数据通过并透传告警", async () => {
    const gateway = await newProjectGateway();

    await expect(
      writeCardDoc(gateway, {
        card: {
          type: "realm-system",
          id: "law-realm-system",
          name: "境界体系",
          layer: "laws",
          extensions: { realms: [{ name: "练气", tier: 1 }] },
        },
        body: "",
      }),
    ).rejects.toMatchObject({ code: "E_CARD_EXT_INVALID" });

    const ok = await writeCardDoc(gateway, {
      card: {
        type: "realm-system",
        id: "law-realm-system",
        name: "境界体系",
        layer: "laws",
        extensions: {
          realms: [{ name: "练气", tier: 1, lifespan: 120, combat_power: 10 }],
          mystery: true,
        },
      },
      body: "",
    });
    expect(ok.warnings.some((w) => w.includes("mystery"))).toBe(true);
  });

  it("空名称被拒绝", async () => {
    const gateway = await newProjectGateway();
    await expect(
      writeCardDoc(gateway, { card: { type: "character", name: "  " }, body: "" }),
    ).rejects.toThrowError(/名称不能为空/);
  });
});

describe("三级大纲（T1-10 / T1-11 / T1-12）", () => {
  async function newProjectGateway(): Promise<ProjectGateway> {
    await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
    return new ProjectGateway(dir);
  }

  it("模板清单来自派系包 outline_templates；初始无大纲", async () => {
    const gateway = await newProjectGateway();
    const state = await readOutlineState(gateway);
    expect(state.exists).toBe(false);
    expect(state.path).toBe(OUTLINE_PATH);
    const template = state.templates.find((item) => item.id === "xuanhuan-xitong/three-act-upgrade");
    expect(template).toBeTruthy();
    expect(template?.error).toBeUndefined();
    expect(template?.acts.map((act) => act.name)).toEqual(["起", "承", "合"]);
    expect(template?.defaultVolumeCount).toBe(3);
    expect(template?.defaultChaptersPerVolume).toBe(10);
  });

  it("一键生成骨架落盘 outline.yaml；覆盖生成必须携带 baseHash", async () => {
    const gateway = await newProjectGateway();
    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 3,
      chaptersPerVolume: 2,
    });
    expect(generated.path).toBe(OUTLINE_PATH);
    expect(generated.doc.volumes).toHaveLength(3);
    expect(generated.doc.volumes[0]?.chapters).toHaveLength(2);
    expect(generated.doc.source_template).toBe("xuanhuan-xitong/three-act-upgrade");

    const onDisk = parseOutline(await readFile(join(dir, OUTLINE_PATH), "utf8"));
    expect(onDisk.master.title).toBe("天启界");

    await expect(
      generateOutline(gateway, { templateId: "xuanhuan-xitong/three-act-upgrade", title: "天启界" }),
    ).rejects.toMatchObject({ code: "E_DOC_CONFLICT" });

    const state = await readOutlineState(gateway);
    expect(state.exists).toBe(true);
    const regenerated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 4,
      chaptersPerVolume: 1,
      baseHash: state.hash,
    });
    expect(regenerated.doc.volumes).toHaveLength(4);
  });

  it("保存大纲：章纲重排后重编号、空 ID 条目被补齐；陈旧 baseHash 被拒绝", async () => {
    const gateway = await newProjectGateway();
    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 3,
      chaptersPerVolume: 2,
    });
    const doc = generated.doc;
    const firstVolume = doc.volumes[0]!;
    const chapters = [
      ...firstVolume.chapters.slice(1),
      firstVolume.chapters[0]!,
      { ...firstVolume.chapters[0]!, id: "", title: "第三章（新）" },
    ];
    const saved = await writeOutline(gateway, {
      baseHash: generated.hash,
      doc: { ...doc, volumes: [{ ...firstVolume, chapters }, ...doc.volumes.slice(1)] },
    });
    const savedChapters = saved.doc.volumes[0]!.chapters;
    expect(savedChapters.map((chapter) => chapter.idx)).toEqual([1, 2, 3]);
    expect(savedChapters[2]?.title).toBe("第三章（新）");
    expect(savedChapters[2]?.id.startsWith("co-")).toBe(true);

    await expect(writeOutline(gateway, { baseHash: generated.hash, doc: saved.doc })).rejects.toMatchObject({
      code: "E_DOC_CONFLICT",
    });
  });

  it("细纲一键创建草稿章节：双向映射 + 重复调用幂等", async () => {
    const gateway = await newProjectGateway();
    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 3,
      chaptersPerVolume: 1,
    });
    const volume = generated.doc.volumes[0]!;
    const chapter = volume.chapters[0]!;

    const result = await createOutlineChapter(gateway, {
      volumeId: volume.id,
      chapterId: chapter.id,
      baseHash: generated.hash,
    });
    expect(result.chapterPath.startsWith(`chapters/${volume.id}/ch-`)).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.doc.volumes[0]?.chapters[0]?.chapter_id).toBe(result.chapterId);

    const parsed = readChapterFile(await readFile(join(dir, result.chapterPath), "utf8"));
    expect(parsed.chapter.outline_ref).toBe(chapter.id);
    expect(parsed.chapter.volume).toBe(volume.id);
    expect(parsed.chapter.status).toBe("draft");

    const again = await createOutlineChapter(gateway, {
      volumeId: volume.id,
      chapterId: chapter.id,
      baseHash: result.hash,
    });
    expect(again.reused).toBe(true);
    expect(again.chapterId).toBe(result.chapterId);
    expect(again.doc.volumes[0]?.chapters[0]?.chapter_id).toBe(result.chapterId);
  });

  it("空白创建：空 templateId 生成零卷大纲（不使用模板）", async () => {
    const gateway = await newProjectGateway();
    const result = await generateOutline(gateway, { templateId: "", title: "天启界" });
    expect(result.doc.volumes).toEqual([]);
    expect(result.doc.source_template).toBeUndefined();
    const onDisk = parseOutline(await readFile(join(dir, OUTLINE_PATH), "utf8"));
    expect(onDisk.master.title).toBe("天启界");
    expect(onDisk.master.acts.map((act) => act.name)).toEqual(["起", "承", "合"]);
  });

  it("未知模板 / 未知卷纲给出明确错误", async () => {
    const gateway = await newProjectGateway();
    await expect(
      generateOutline(gateway, { templateId: "nope/nope", title: "天启界" }),
    ).rejects.toThrowError(/找不到大纲模板/);

    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      chaptersPerVolume: 1,
    });
    await expect(
      createOutlineChapter(gateway, {
        volumeId: "vol-nope",
        chapterId: "co-nope",
        baseHash: generated.hash,
      }),
    ).rejects.toThrowError(/找不到卷纲/);
  });
});