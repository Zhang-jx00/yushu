import { existsSync } from "node:fs";
import { join } from "node:path";
import { countWords } from "@yushu/core";
import {
  OUTLINE_PATH,
  cardPath,
  chapterPath,
  createChapterDraft,
  createEmptyOutline,
  createSettingCard,
  emptyBrief,
  normalizeOutline,
  parseOutline,
  readChapterFile,
  serializeCardFile,
  serializeChapterFile,
  serializeOutline,
  type Outline,
  type OutlineVolume,
} from "@yushu/world-engine";
import { ProjectGateway } from "./file-gateway.js";
import { createProject } from "./project-ops.js";

/**
 * 性能夹具 synth-1m（M2 / T2-10；docs/03 §14 性能预算的百万字合成项目）：
 *
 * - **确定性**：文本由固定种子伪随机生成（同 seed 同输出），便于对照与回归；
 * - **合法项目**：复用产品自身的 createProject / serialize* 写盘（world.yaml / project.toml / 大纲 /
 *   章节 / 设定卡全部走真实格式），打开、索引、导出等链路与真实项目一致；
 * - **字数口径**：countWords（去空白字符数，与导出对账一致）；目标 1,000,000 字 ±单章粒度；
 * - **大章靶子**：`megaChars` 额外生成一个大章（T2-4 长文性能优化靶子，非预算门禁项）；
 * - **幂等复用**：目录已有项目（world/world.yaml 存在）→ 直接扫描统计并复用（二次运行免重建）。
 */

export interface SynthFixtureOptions {
  dir: string;
  /** 目标总正文字数（countWords 口径；默认 1,000,000） */
  targetChars?: number;
  /** 每卷章数（默认 20） */
  chaptersPerVolume?: number;
  /** 单章字数（默认 3,000） */
  chapterChars?: number;
  /** 额外大章字数（T2-4 靶子；默认 0 = 不生成） */
  megaChars?: number;
  /** 伪随机种子（默认 42） */
  seed?: number;
}

export interface SynthFixtureStats {
  reused: boolean;
  volumes: number;
  chapters: number;
  /** 实际总字数（countWords 口径，含大章） */
  totalChars: number;
  /** 大章路径（未生成时为 null） */
  megaPath: string | null;
  /** 首个草稿章节路径（编辑器 / 探针用） */
  firstChapterPath: string;
  elapsedMs: number;
}

/** 常用汉字池（确定性文本生成；约 230 字，够铺 1M 字样本） */
const CHAR_POOL =
  "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感";

/** 确定性 PRNG（mulberry32）：同 seed 序列一致（导出供测试复用，避免测试另写一份实现漂移） */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成约 targetChars 字的正文（汉字 + 中文标点；段落间 \n\n；去空白即 countWords 口径） */
export function generateFixtureBody(targetChars: number, rng: () => number): string {
  const paragraphs: string[] = [];
  let count = 0;
  while (count < targetChars) {
    const sentences = 1 + Math.floor(rng() * 3);
    let paragraph = "";
    for (let s = 0; s < sentences; s += 1) {
      const length = 8 + Math.floor(rng() * 17);
      for (let i = 0; i < length; i += 1) {
        paragraph += CHAR_POOL[Math.floor(rng() * CHAR_POOL.length)];
      }
      const roll = rng();
      paragraph += roll < 0.72 ? "。" : roll < 0.9 ? "，" : "！";
    }
    paragraphs.push(paragraph);
    count += paragraph.length;
  }
  return paragraphs.join("\n\n");
}

/** 扫描既有夹具（幂等复用）：统计卷 / 章 / 字数，识别大章与首章 */
async function inspectExisting(gateway: ProjectGateway): Promise<SynthFixtureStats | null> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snapshot) return null;
  const outline = parseOutline(snapshot.content);
  let chapters = 0;
  let totalChars = 0;
  let megaPath: string | null = null;
  let firstChapterPath = "";
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      chapters += 1;
      if (!chapter.chapter_id) continue;
      const path = chapterPath(volume.id, chapter.chapter_id);
      const doc = await gateway.readDoc(path).catch(() => null);
      if (!doc) continue;
      const body = readChapterFile(doc.content).body;
      const words = countWords(body);
      totalChars += words;
      if (!firstChapterPath) firstChapterPath = path;
      if (words >= 20_000) megaPath = path;
    }
  }
  if (chapters === 0) return null;
  return { reused: true, volumes: outline.volumes.length, chapters, totalChars, megaPath, firstChapterPath, elapsedMs: 0 };
}

/**
 * 确保 synth-1m 夹具存在（不存在则生成，存在则复用）。
 * 生成分两阶段：先构造章纲并 normalize（拿稳定 id），再逐章写正文并回填 chapter_id（双向映射）。
 */
export async function ensureSynthFixture(options: SynthFixtureOptions): Promise<SynthFixtureStats> {
  const t0 = Date.now();
  const dir = options.dir;
  const targetChars = options.targetChars ?? 1_000_000;
  const chaptersPerVolume = options.chaptersPerVolume ?? 20;
  const chapterChars = options.chapterChars ?? 3_000;
  const megaChars = options.megaChars ?? 0;
  const seed = options.seed ?? 42;

  let gateway = new ProjectGateway(dir);
  const existing = await inspectExisting(gateway);
  if (existing) {
    return { ...existing, elapsedMs: Date.now() - t0 };
  }

  await createProject({
    dir,
    title: "性能夹具·百万字",
    packIds: ["xuanhuan-xitong"],
    axes: {
      channel: ["男频"],
      world: ["玄幻"],
      technique: ["系统流"],
      tone: ["爽文"],
      romance_mode_default: "无女主",
    },
  });
  gateway = new ProjectGateway(dir);

  // 阶段一：章纲骨架（含每章计划字数，按序与 normalize 后一一对应）
  const outline: Outline = createEmptyOutline("性能夹具·百万字");
  outline.volumes = [];
  const planned: number[] = [];
  const totalChapters = Math.max(1, Math.ceil(targetChars / chapterChars));
  let remaining = targetChars;
  let chapterSeq = 0;
  for (let v = 0; v < Math.ceil(totalChapters / chaptersPerVolume); v += 1) {
    const volume: OutlineVolume = {
      id: "",
      title: `第 ${v + 1} 卷 性能样本`,
      act: outline.master.acts[0]?.name ?? "起",
      desc: "",
      chapters: [],
    };
    outline.volumes.push(volume);
    for (let c = 0; c < chaptersPerVolume && remaining > 0; c += 1) {
      chapterSeq += 1;
      const chars = Math.min(chapterChars, remaining);
      remaining -= chars;
      planned.push(chars);
      volume.chapters.push({
        id: "",
        idx: c + 1,
        title: `第 ${chapterSeq} 章 性能样本`,
        brief: emptyBrief(),
        scene_ids: [],
      });
    }
  }
  if (megaChars > 0) {
    const lastVolume = outline.volumes[outline.volumes.length - 1]!;
    planned.push(megaChars);
    lastVolume.chapters.push({
      id: "",
      idx: lastVolume.chapters.length + 1,
      title: `第 ${lastVolume.chapters.length + 1} 章 大章靶子`,
      brief: emptyBrief(),
      scene_ids: [],
    });
  }

  // 阶段二：normalize（补 id）→ 逐章写正文（frontmatter word_count 同步）→ 回填 chapter_id
  const normalized = normalizeOutline(outline);
  const rng = makeRng(seed);
  let totalChars = 0;
  let chapters = 0;
  let megaPath: string | null = null;
  let firstChapterPath = "";
  let planIndex = 0;
  for (const volume of normalized.volumes) {
    for (const chapter of volume.chapters) {
      const chars = planned[planIndex] ?? chapterChars;
      planIndex += 1;
      const body = generateFixtureBody(chars, rng);
      const draft = createChapterDraft({
        volume: volume.id,
        idx: chapter.idx,
        title: chapter.title,
        outlineRef: chapter.id,
      });
      const path = chapterPath(volume.id, draft.id);
      const words = countWords(body);
      await gateway.writeDoc(path, serializeChapterFile({ ...draft, word_count: words }, body));
      chapter.chapter_id = draft.id;
      chapters += 1;
      totalChars += words;
      if (!firstChapterPath) firstChapterPath = path;
      if (words >= 20_000) megaPath = path;
    }
  }

  // 设定卡（少量；让索引实体链路与真实项目一致）
  const cards = [
    { type: "character", name: "夹具主角", layer: "characters", body: "## 问卷回答\n\n- **出身**：性能测试世界的主角样本。\n" },
    { type: "character", name: "夹具配角", layer: "characters", body: "## 问卷回答\n\n- **出身**：性能测试世界的配角样本。\n" },
    { type: "law", name: "夹具法则", layer: "laws", body: "## 说明\n\n- 性能夹具用法则卡（不参与门禁，仅保证链路真实）。\n" },
  ] as const;
  for (const item of cards) {
    const card = createSettingCard({ type: item.type, name: item.name, layer: item.layer });
    await gateway.writeDoc(cardPath(card.type, card.id), serializeCardFile(card, item.body));
  }

  await gateway.writeDoc(OUTLINE_PATH, serializeOutline(normalized));

  return {
    reused: false,
    volumes: normalized.volumes.length,
    chapters,
    totalChars,
    megaPath,
    firstChapterPath,
    elapsedMs: Date.now() - t0,
  };
}

/** 夹具是否已存在（供探针快速判断，不做全量统计） */
export function synthFixtureExists(dir: string): boolean {
  return existsSync(join(dir, "world", "world.yaml"));
}