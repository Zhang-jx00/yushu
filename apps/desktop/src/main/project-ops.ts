import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { YushuError, type EntityBase, type GenreAxes, type WorldConfig } from "@yushu/core";
import {
  ROMANCE_MODES,
  WORDLIST,
  fuse,
  lintPack,
  loadPack,
  loadSchemaExtensions,
  validateExtensionCard,
  type LoadedPack,
} from "@yushu/genre-engine";
import {
  OUTLINE_PATH,
  PROJECT_CONFIG_PATH,
  SETTING_CARD_FORMAT_VERSION,
  WORLD_CONFIG_PATH,
  cardPath,
  chapterPath,
  createChapterDraft,
  createEmptyOutline,
  createOutlineFromTemplate,
  createProjectConfig,
  createSettingCard,
  createWorldConfig,
  normalizeOutline,
  parseOutline,
  parseOutlineTemplate,
  parseProjectConfig,
  parseWorldConfig,
  readCardFile,
  readChapterFile,
  serializeCardFile,
  serializeChapterFile,
  serializeOutline,
  serializeProjectConfig,
  serializeWorldConfig,
  templateActs,
  templateChaptersPerVolume,
  templateVolumeCount,
  type Outline,
  type OutlineTemplate,
} from "@yushu/world-engine";
import type {
  AxisValues,
  CardReadResult,
  CardSummary,
  CardWritePayload,
  CardWriteResult,
  CreateProjectPayload,
  FusionPreview,
  OutlineChapterDraftResult,
  OutlineCreateChapterPayload,
  OutlineDocPayload,
  OutlineGeneratePayload,
  OutlineMutateResult,
  OutlineState,
  OutlineTemplateSummary,
  OutlineWritePayload,
  PackCatalog,
  PackSummary,
  ProjectSnapshot,
  WorldSummary,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { packsRoot } from "./paths.js";
import { takePreDestructiveSnapshot } from "./snapshot-ops.js";

/**
 * 项目级业务操作（纯 Node，无 Electron 依赖；可被 IPC 路由与测试直接复用）。
 * 对应 M1 的 T1-3/T1-4/T1-5：派系包目录、融合预演、项目落盘。
 */

/** 扫描内置派系包目录并加载 */
export async function scanPacks(): Promise<{ dir: string; pack: LoadedPack }[]> {
  const found: { dir: string; pack: LoadedPack }[] = [];
  const entries = await fs.readdir(packsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(packsRoot, entry.name);
    if (!existsSync(join(dir, "pack.yaml"))) continue;
    found.push({ dir, pack: loadPack(dir) });
  }
  return found;
}

export async function loadPacksByIds(ids: string[]): Promise<LoadedPack[]> {
  const scanned = await scanPacks();
  const byId = new Map(scanned.map((item) => [item.pack.manifest.metadata.id, item.pack]));
  const packs: LoadedPack[] = [];
  for (const id of ids) {
    const pack = byId.get(id);
    if (!pack) {
      throw new YushuError("E_PACK_NOT_FOUND", `找不到派系包：${id}`);
    }
    packs.push(pack);
  }
  return packs;
}

export function summarizePack(pack: LoadedPack): PackSummary {
  const lint = lintPack(pack);
  return {
    id: pack.manifest.metadata.id,
    name: pack.manifest.metadata.name,
    version: pack.manifest.metadata.version,
    license: pack.manifest.metadata.license,
    genreAxes: pack.manifest.genre_axes as unknown as AxisValues,
    lint: {
      ok: lint.ok,
      errors: lint.issues.filter((i) => i.severity === "error").length,
      warnings: lint.issues.filter((i) => i.severity === "warn").length,
      messages: lint.issues.slice(0, 6).map((i) => `[${i.rule}] ${i.message}`),
    },
  };
}

/** 派系包目录 + 四维词表（向导数据源） */
export async function buildPackCatalog(): Promise<PackCatalog> {
  const scanned = await scanPacks();
  return {
    wordlist: {
      channel: [...WORDLIST["channel"]!],
      world: [...WORDLIST["world"]!],
      technique: [...WORDLIST["technique"]!],
      tone: [...WORDLIST["tone"]!],
      romance: [...ROMANCE_MODES],
    },
    packs: scanned.map((item) => summarizePack(item.pack)),
  };
}

/** 融合预演（未确认前不落库；ready=false 表示存在 error 级冲突） */
export async function buildFusionPreview(packIds: string[]): Promise<FusionPreview> {
  const packs = await loadPacksByIds(packIds);
  const report = fuse(packs);
  return {
    packs: report.packs,
    genreAxes: report.genre_axes as unknown as AxisValues,
    added: report.added,
    overridden: report.overridden,
    conflicts: report.conflicts,
    ready: report.ready,
  };
}

/**
 * 创建项目落盘：world/world.yaml（世界真源）+ project.toml（含融合预演确认记录）。
 * 注意：存在 error 级融合冲突时拒绝创建（docs/03 §8.3）。
 */
export async function createProject(payload: CreateProjectPayload): Promise<ProjectSnapshot> {
  const { dir, title, packIds, axes } = payload;
  if (!title.trim()) {
    throw new YushuError("E_INVALID_INPUT", "项目名不能为空");
  }
  if (packIds.length === 0) {
    throw new YushuError("E_INVALID_INPUT", "至少选择一个派系包");
  }

  const report = await buildFusionPreview(packIds);
  if (!report.ready) {
    const details = report.conflicts
      .filter((c) => c.severity === "error")
      .map((c) => `${c.kind}: ${c.message}`)
      .join("；");
    throw new YushuError("E_FUSION_NOT_READY", `融合存在未解决的冲突，禁止落库：${details}`);
  }

  await fs.mkdir(dir, { recursive: true });
  if (existsSync(join(dir, "world", "world.yaml"))) {
    throw new YushuError("E_PROJECT_EXISTS", "该目录已存在御书项目（world/world.yaml 已存在）");
  }

  const gateway = new ProjectGateway(dir);
  const world = createWorldConfig({
    title: title.trim(),
    genreAxes: axes as unknown as GenreAxes,
  });
  await gateway.writeDoc(WORLD_CONFIG_PATH, serializeWorldConfig(world));

  const projectConfig = createProjectConfig({
    name: title.trim(),
    packIds,
    axes,
    conflicts: report.conflicts.map((c) => ({
      kind: c.kind,
      severity: c.severity,
      message: c.message,
    })),
  });
  await gateway.writeDoc(PROJECT_CONFIG_PATH, serializeProjectConfig(projectConfig));

  return { root: gateway.root, tree: await gateway.listTree() };
}

/* ---------- 设定卡与世界配置（T1-6 / T1-7 / T1-9） ---------- */

/** 读取世界根配置（world/world.yaml）；不存在时返回 null */
export async function getWorldSummary(gateway: ProjectGateway): Promise<WorldSummary | null> {
  const snap = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snap) return null;
  const world: WorldConfig = parseWorldConfig(snap.content);
  return {
    id: world.id,
    title: world.title,
    layers: world.layers as unknown as Record<string, boolean>,
    genreAxes: world.genre_axes as unknown as AxisValues,
  };
}

/** 列出项目内全部设定卡（world/cards 目录下的 .md）；解析失败的单卡保留在列表并带 error */
export async function listCards(gateway: ProjectGateway): Promise<CardSummary[]> {
  const tree = await gateway.listTree();
  const paths = tree
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.path.startsWith("world/cards/") &&
        entry.path.endsWith(".md"),
    )
    .map((entry) => entry.path);

  const rows: CardSummary[] = [];
  for (const path of paths) {
    try {
      const snap = await gateway.readDoc(path);
      const { card } = readCardFile(snap.content);
      rows.push({
        path,
        id: card.id,
        type: card.type,
        name: card.name,
        layer: card.layer,
        visibility: card.visibility,
        aliases: card.aliases,
      });
    } catch (err) {
      rows.push({
        path,
        id: "",
        type: "(invalid)",
        name: path.split("/").pop() ?? path,
        layer: "",
        visibility: "",
        aliases: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "zh"),
  );
}

/** 读取单张设定卡（frontmatter + 正文 + 并发 hash） */
export async function readCardDoc(gateway: ProjectGateway, path: string): Promise<CardReadResult> {
  const snap = await gateway.readDoc(path);
  const { card, body } = readCardFile(snap.content);
  return { path, card, body, hash: snap.hash };
}

async function loadProjectExtensions(gateway: ProjectGateway) {
  const snap = await gateway.readDoc(PROJECT_CONFIG_PATH).catch(() => null);
  if (!snap) return [];
  const packIds = parseProjectConfig(snap.content).genre.packs;
  if (packIds.length === 0) return [];
  const packs = await loadPacksByIds(packIds);
  return packs.flatMap((pack) => loadSchemaExtensions(pack));
}

/**
 * 写入设定卡：新建（省略 id → 引擎生成）或更新（必须携带 baseHash）。
 * 若卡片 type 命中项目派系包的 schema 扩展，先做扩展字段校验（error 阻断 / warn 透传）。
 */
export async function writeCardDoc(
  gateway: ProjectGateway,
  payload: CardWritePayload,
): Promise<CardWriteResult> {
  const input = payload.card;
  if (!input.name?.trim()) {
    throw new YushuError("E_INVALID_INPUT", "设定卡名称不能为空");
  }

  let entity: EntityBase;
  if (input.id) {
    // 显式 ID（扩展卡/编辑既有卡）：规范化默认字段后再校验
    entity = {
      id: input.id,
      type: input.type,
      layer: (input.layer ?? "characters") as EntityBase["layer"],
      name: input.name,
      aliases: input.aliases ?? [],
      refs: input.refs ?? [],
      source_chapters: input.source_chapters ?? [],
      visibility: (input.visibility ?? "hidden") as EntityBase["visibility"],
      format_version: input.format_version ?? SETTING_CARD_FORMAT_VERSION,
      ...(input.extensions ? { extensions: input.extensions } : {}),
    };
  } else {
    entity = createSettingCard({
      type: input.type,
      name: input.name,
      ...(input.layer ? { layer: input.layer as EntityBase["layer"] } : {}),
      ...(input.aliases ? { aliases: input.aliases } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.visibility ? { visibility: input.visibility as EntityBase["visibility"] } : {}),
      ...(input.extensions ? { extensions: input.extensions } : {}),
    });
  }

  const warnings: string[] = [];
  const extensions = await loadProjectExtensions(gateway);
  const matched = extensions.find((extension) => extension.id === entity.type);
  if (matched) {
    const result = validateExtensionCard(matched, entity);
    if (result.errors.length > 0) {
      throw new YushuError(
        "E_CARD_EXT_INVALID",
        `扩展字段校验失败（${matched.title ?? matched.id}）：${result.errors.join("；")}`,
      );
    }
    warnings.push(...result.warnings);
  }

  const text = serializeCardFile(entity, payload.body);
  const path = payload.path ?? cardPath(entity.type, entity.id);
  const snap = await gateway.writeDoc(path, text, payload.baseHash);
  return { path, hash: snap.hash, warnings };
}

/* ---------- 三级大纲（T1-10 / T1-11 / T1-12） ---------- */

interface DiscoveredTemplate {
  summary: OutlineTemplateSummary;
  /** 解析成功的模板本体（供一键生成使用） */
  template?: OutlineTemplate;
}

function templateStem(file: string): string {
  return basename(file).replace(/\.ya?ml$/i, "");
}

/** 扫描全部派系包的 outline_templates 件套（解析失败单列 error，不阻断其它模板） */
async function discoverOutlineTemplates(): Promise<DiscoveredTemplate[]> {
  const scanned = await scanPacks();
  const found: DiscoveredTemplate[] = [];
  for (const { pack } of scanned) {
    const packId = pack.manifest.metadata.id;
    for (const file of pack.resolvedFiles["outline_templates"] ?? []) {
      try {
        const template = parseOutlineTemplate(await fs.readFile(file, "utf8"));
        found.push({
          template,
          summary: {
            id: `${packId}/${template.id}`,
            packId,
            title: template.title ?? template.id,
            ...(template.description ? { description: template.description } : {}),
            acts: templateActs(template),
            defaultVolumeCount: templateVolumeCount(template),
            defaultChaptersPerVolume: templateChaptersPerVolume(template),
          },
        });
      } catch (err) {
        const stem = templateStem(file);
        found.push({
          summary: {
            id: `${packId}/${stem}`,
            packId,
            title: stem,
            acts: [],
            defaultVolumeCount: 3,
            defaultChaptersPerVolume: 3,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }
  return found;
}

export async function scanOutlineTemplates(): Promise<OutlineTemplateSummary[]> {
  return (await discoverOutlineTemplates()).map((item) => item.summary);
}

function toOutlinePayload(outline: Outline): OutlineDocPayload {
  return outline as unknown as OutlineDocPayload;
}

/** 读取大纲状态：outline.yaml（不存在时 exists=false）+ 可用模板清单 */
export async function readOutlineState(gateway: ProjectGateway): Promise<OutlineState> {
  const templates = await scanOutlineTemplates();
  const snap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snap) return { path: OUTLINE_PATH, exists: false, templates };
  const outline = parseOutline(snap.content);
  return {
    path: OUTLINE_PATH,
    exists: true,
    hash: snap.hash,
    doc: toOutlinePayload(outline),
    templates,
  };
}

/**
 * 一键生成大纲骨架（T1-11）。
 * 已存在大纲时必须携带 baseHash（覆盖前经用户确认）；生成后仍可任意增删改（生成≠写死）。
 * T2-8 切片 B：覆盖既有大纲属破坏性操作——写入前强制生成 `pre_destructive` 快照（撤销窗口）。
 */
export async function generateOutline(
  gateway: ProjectGateway,
  payload: OutlineGeneratePayload,
): Promise<OutlineMutateResult> {
  if (!payload.title.trim()) {
    throw new YushuError("E_INVALID_INPUT", "生成大纲需要项目名");
  }
  // 覆盖既有大纲（含空白创建分支）：先备份再覆盖；快照失败按 K10 阻断（E_SNAPSHOT_REQUIRED）
  const existing = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (existing) {
    await takePreDestructiveSnapshot(gateway);
  }
  // 空 templateId = 空白创建（不使用模板，由作者自建）
  if (!payload.templateId) {
    const empty = createEmptyOutline(payload.title);
    const snap = await gateway.writeDoc(OUTLINE_PATH, serializeOutline(empty), payload.baseHash);
    return { path: OUTLINE_PATH, hash: snap.hash, doc: toOutlinePayload(empty) };
  }
  const discovered = await discoverOutlineTemplates();
  const found = discovered.find((item) => item.summary.id === payload.templateId);
  if (!found) {
    throw new YushuError("E_TEMPLATE_NOT_FOUND", `找不到大纲模板：${payload.templateId}`);
  }
  if (!found.template) {
    throw new YushuError(
      "E_TEMPLATE_INVALID",
      `大纲模板不可用：${found.summary.error ?? payload.templateId}`,
    );
  }
  const outline = createOutlineFromTemplate({
    projectTitle: payload.title,
    template: found.template,
    sourceRef: found.summary.id,
    ...(payload.volumeCount !== undefined ? { volumeCount: payload.volumeCount } : {}),
    ...(payload.chaptersPerVolume !== undefined
      ? { chaptersPerVolume: payload.chaptersPerVolume }
      : {}),
  });
  const snap = await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outline), payload.baseHash);
  return { path: OUTLINE_PATH, hash: snap.hash, doc: toOutlinePayload(outline) };
}

/**
 * 保存大纲：先归一化（补齐缺失 ID + 重编号章序），再携带 baseHash 原子写入。
 * T2-8 切片 B：与磁盘版本对比，若本次保存**删除了卷 / 章纲**（删卷、删章、清空重建的批量替换），
 * 属破坏性操作——写入前强制 `pre_destructive` 快照（撤销窗口）；仅编辑文本 / 增补则不触发。
 */
export async function writeOutline(
  gateway: ProjectGateway,
  payload: OutlineWritePayload,
): Promise<OutlineMutateResult> {
  const normalized = normalizeOutline(payload.doc as unknown as Outline);
  const before = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (before) {
    const oldOutline = parseOutline(before.content);
    const oldVolumeIds = new Set(oldOutline.volumes.map((volume) => volume.id));
    const oldChapterIds = new Set(oldOutline.volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id)));
    const newVolumeIds = new Set(normalized.volumes.map((volume) => volume.id));
    const newChapterIds = new Set(normalized.volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id)));
    const removedVolume = [...oldVolumeIds].some((id) => !newVolumeIds.has(id));
    const removedChapter = [...oldChapterIds].some((id) => !newChapterIds.has(id));
    if (removedVolume || removedChapter) {
      await takePreDestructiveSnapshot(gateway);
    }
  }
  const snap = await gateway.writeDoc(OUTLINE_PATH, serializeOutline(normalized), payload.baseHash);
  return { path: OUTLINE_PATH, hash: snap.hash, doc: toOutlinePayload(normalized) };
}

/**
 * 细纲一键创建草稿章节（T1-12）：写入 chapters/<卷>/<章>.md（frontmatter outline_ref 指回章纲），
 * 并在章纲回填 chapter_id 完成双向映射；重复调用幂等（复用既有草稿，仅补映射）。
 */
export async function createOutlineChapter(
  gateway: ProjectGateway,
  payload: OutlineCreateChapterPayload,
): Promise<OutlineChapterDraftResult> {
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const volume = outline.volumes.find((item) => item.id === payload.volumeId);
  if (!volume) {
    throw new YushuError("E_OUTLINE", `找不到卷纲：${payload.volumeId}`);
  }
  const chapter = volume.chapters.find((item) => item.id === payload.chapterId);
  if (!chapter) {
    throw new YushuError("E_OUTLINE", `找不到章纲：${payload.chapterId}`);
  }

  const draft = createChapterDraft({
    volume: volume.id,
    idx: chapter.idx,
    title: chapter.title,
    outlineRef: chapter.id,
  });
  const path = chapterPath(volume.id, draft.id);

  const existing = await gateway.readDoc(path).catch(() => null);
  const reused = existing !== null;
  if (existing) {
    // 幂等：草稿已存在则复用（校验归属，防止把别的章挂过来）
    const parsed = readChapterFile(existing.content);
    if (parsed.chapter.outline_ref !== chapter.id) {
      throw new YushuError(
        "E_DOC_CONFLICT",
        `章节草稿 ${path} 已存在且不属于当前章纲（outline_ref=${parsed.chapter.outline_ref}）`,
      );
    }
  } else {
    await gateway.writeDoc(path, serializeChapterFile(draft));
  }

  // 已回填过同一映射 → 直接返回当前状态（幂等，不产生多余写入）
  if (chapter.chapter_id === draft.id) {
    return {
      path: OUTLINE_PATH,
      hash: snap.hash,
      doc: toOutlinePayload(outline),
      chapterPath: path,
      chapterId: draft.id,
      reused,
    };
  }

  const updated: Outline = {
    ...outline,
    volumes: outline.volumes.map((item) =>
      item.id !== volume.id
        ? item
        : {
            ...item,
            chapters: item.chapters.map((c) =>
              c.id !== chapter.id ? c : { ...c, chapter_id: draft.id },
            ),
          },
    ),
  };
  const updatedSnap = await gateway.writeDoc(
    OUTLINE_PATH,
    serializeOutline(updated),
    payload.baseHash,
  );
  return {
    path: OUTLINE_PATH,
    hash: updatedSnap.hash,
    doc: toOutlinePayload(updated),
    chapterPath: path,
    chapterId: draft.id,
    reused,
  };
}