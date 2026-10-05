import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { YushuError } from "@yushu/core";
import type {
  SnapshotReasonPayload,
  SnapshotRestoreResultPayload,
  SnapshotStatePayload,
  SnapshotSummaryPayload,
  SnapshotTakeResultPayload,
  TreeEntry,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 本地快照（M2 / T2-7 切片 A：内容寻址快照；docs/03 §12 四层防丢稿防线第③层）：
 *
 * - 存储于 `.yushu/snapshots/`（派生数据：索引排除、不入 Git、不随备份网盘携带索引的约束一致）；
 * - **内容寻址 blob 去重**：blob 按内容 sha256 落 `blobs/<前2位>/<hash>`，同内容只存一份；
 * - **manifest 清单**：`manifests/snap-<时间>-<rand>.json` 记录 {路径 → blob, size, mtime}；
 * - **自动策略**：主进程每 60s 检查一次（自动快照），距上一份不足最小间隔（60s）则跳过（too_soon）；
 *   内容与最新快照完全一致则跳过（unchanged）；手动 / 恢复前快照强制生成（不受最小间隔限制）；
 * - **环形保留 20**：仅保留最新 20 份 manifest，超出部分连同"不再被引用"的 blob 一并清理；
 * - **整体回滚**：恢复前**强制**生成 pre_restore 快照（撤销窗口）；逐文件原子写回；
 *   被删除的文件重建；快照之后新增的文件**保守保留**（不删除，仅在结果中列出）；
 * - 未变文件的 blob 复用走 mtime+size 快速判定（与索引增量同思路），避免每 60s 全量读盘。
 *
 * 源文件范围：listTree 可见、扩展名在白名单内的文本文件（.md/.yaml/.yml/.toml/.txt/.json）；
 * `exports/`（可再生成的导出产物）不参与。
 */

export const SNAPSHOTS_DIR = ".yushu/snapshots";
export const SNAPSHOT_MANIFESTS_DIR = `${SNAPSHOTS_DIR}/manifests`;
export const SNAPSHOT_BLOBS_DIR = `${SNAPSHOTS_DIR}/blobs`;
/** 自动快照最小间隔（60s 一份，docs/04 T2-7） */
export const SNAPSHOT_MIN_INTERVAL_MS = 60_000;
/** 环形保留份数 */
export const SNAPSHOT_RING_KEEP = 20;

const SNAPSHOT_EXTS = new Set([".md", ".yaml", ".yml", ".toml", ".txt", ".json"]);
const SNAPSHOT_EXCLUDE_PREFIXES = ["exports/"];

export interface SnapshotManifestEntry {
  path: string;
  blob: string;
  size: number;
  mtime: string;
}

export interface SnapshotManifest {
  schema_version: number;
  id: string;
  createdAt: string;
  reason: SnapshotReasonPayload;
  entries: SnapshotManifestEntry[];
}

/** 快照源文件（扩展名白名单 + 排除前缀；listTree 已排除 .yushu/.git/node_modules 与临时文件） */
export function isSnapshotSource(path: string): boolean {
  if (SNAPSHOT_EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SNAPSHOT_EXTS.has(path.slice(dot).toLowerCase());
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeSnapshotId(nowMs: number): string {
  const iso = new Date(nowMs).toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  const rand = randomBytes(2).toString("hex");
  return `snap-${iso.slice(0, 8)}-${iso.slice(8)}-${rand}`;
}

function manifestSummary(manifest: SnapshotManifest): SnapshotSummaryPayload {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    files: manifest.entries.length,
    bytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function blobAbs(gateway: ProjectGateway, blob: string): string {
  return join(gateway.root, SNAPSHOT_BLOBS_DIR, blob.slice(0, 2), blob);
}

async function blobExists(gateway: ProjectGateway, blob: string): Promise<boolean> {
  return fs
    .access(blobAbs(gateway, blob))
    .then(() => true)
    .catch(() => false);
}

/** 原子写（tmp → rename）：崩溃不产生半截文件 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
}

async function writeBlobIfAbsent(gateway: ProjectGateway, blob: string, content: string): Promise<void> {
  if (await blobExists(gateway, blob)) return;
  await atomicWrite(blobAbs(gateway, blob), content);
}

async function readBlob(gateway: ProjectGateway, blob: string): Promise<string> {
  try {
    return await fs.readFile(blobAbs(gateway, blob), "utf8");
  } catch {
    throw new YushuError("E_SNAPSHOT_INVALID", `快照内容缺失（blob ${blob.slice(0, 12)}…）：无法恢复该版本`);
  }
}

/** 读取全部有效 manifest（损坏的跳过；按 id 倒序 = 最新在前） */
async function readManifests(gateway: ProjectGateway): Promise<SnapshotManifest[]> {
  const dirAbs = join(gateway.root, SNAPSHOT_MANIFESTS_DIR);
  const names = await fs.readdir(dirAbs).catch(() => [] as string[]);
  const manifests: SnapshotManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await fs.readFile(join(dirAbs, name), "utf8")) as SnapshotManifest;
      if (
        data &&
        typeof data.id === "string" &&
        typeof data.createdAt === "string" &&
        Array.isArray(data.entries) &&
        data.entries.every(
          (entry) =>
            entry &&
            typeof entry.path === "string" &&
            typeof entry.blob === "string" &&
            typeof entry.size === "number",
        )
      ) {
        manifests.push(data);
      }
    } catch {
      /* 损坏 manifest：跳过（不静默删） */
    }
  }
  return manifests.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 快照状态：列表（最新在前）+ blob 占用统计 */
export async function snapshotState(gateway: ProjectGateway): Promise<SnapshotStatePayload> {
  const manifests = await readManifests(gateway);
  const blobsRoot = join(gateway.root, SNAPSHOT_BLOBS_DIR);
  let blobCount = 0;
  let blobBytes = 0;
  const walk = async (dirAbs: string): Promise<void> => {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const abs = join(dirAbs, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
      } else if (dirent.isFile() && !dirent.name.endsWith(".tmp")) {
        const stat = await fs.stat(abs).catch(() => null);
        if (stat) {
          blobCount += 1;
          blobBytes += stat.size;
        }
      }
    }
  };
  await walk(blobsRoot);
  return { snapshots: manifests.map(manifestSummary), blobCount, blobBytes };
}

function sameEntries(a: SnapshotManifestEntry[], b: SnapshotManifestEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.path === b[i]!.path && entry.blob === b[i]!.blob);
}

/**
 * 生成快照。
 * - force=false（自动）：距上一份不足 minIntervalMs 直接返回 too_soon（不扫描，省 IO）；
 * - 内容与最新快照完全一致 → unchanged（不产生新 manifest）；
 * - 变更文件重新读取并落 blob；未变文件复用 blob（mtime+size 且有 blob 才可信）。
 */
export async function takeSnapshot(
  gateway: ProjectGateway,
  reason: SnapshotReasonPayload,
  options?: { force?: boolean; now?: Date; minIntervalMs?: number; keep?: number },
): Promise<SnapshotTakeResultPayload> {
  const nowMs = options?.now?.getTime() ?? Date.now();
  const minIntervalMs = options?.minIntervalMs ?? SNAPSHOT_MIN_INTERVAL_MS;
  const manifests = await readManifests(gateway);
  const latest = manifests[0];
  if (!options?.force && latest && nowMs - Date.parse(latest.createdAt) < minIntervalMs) {
    return { outcome: "too_soon", latest: manifestSummary(latest) };
  }

  const tree = (await gateway.listTree()).filter((entry) => entry.type === "file" && isSnapshotSource(entry.path));
  const prevByPath = new Map((latest?.entries ?? []).map((entry) => [entry.path, entry]));
  const entries: SnapshotManifestEntry[] = [];
  for (const file of tree) {
    const size = file.size ?? 0;
    const mtime = file.mtime ?? "";
    const prev = prevByPath.get(file.path);
    if (prev && prev.size === size && prev.mtime === mtime && (await blobExists(gateway, prev.blob))) {
      entries.push({ path: file.path, blob: prev.blob, size, mtime });
      continue;
    }
    const doc = await gateway.readDoc(file.path);
    const blob = sha256(doc.content);
    await writeBlobIfAbsent(gateway, blob, doc.content);
    entries.push({ path: file.path, blob, size, mtime });
  }

  if (latest && sameEntries(latest.entries, entries)) {
    return { outcome: "unchanged", latest: manifestSummary(latest) };
  }
  const manifest: SnapshotManifest = {
    schema_version: 1,
    id: makeSnapshotId(nowMs),
    createdAt: new Date(nowMs).toISOString(),
    reason,
    entries,
  };
  await atomicWrite(join(gateway.root, SNAPSHOT_MANIFESTS_DIR, `${manifest.id}.json`), JSON.stringify(manifest, null, 2));
  await pruneSnapshots(gateway, options?.keep ?? SNAPSHOT_RING_KEEP);
  return { outcome: "taken", snapshot: manifestSummary(manifest), latest: manifestSummary(manifest) };
}

/** 环形保留：仅留最新 keep 份 manifest；删除不再被任何保留 manifest 引用的 blob */
export async function pruneSnapshots(gateway: ProjectGateway, keep = SNAPSHOT_RING_KEEP): Promise<number> {
  const manifests = await readManifests(gateway);
  const pruned = manifests.slice(keep);
  const dirAbs = join(gateway.root, SNAPSHOT_MANIFESTS_DIR);
  for (const manifest of pruned) {
    await fs.rm(join(dirAbs, `${manifest.id}.json`), { force: true }).catch(() => undefined);
  }
  // 原子写崩溃残留的 .tmp：无内容可言，直接清理
  const names = await fs.readdir(dirAbs).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith(".json.tmp")) await fs.rm(join(dirAbs, name), { force: true }).catch(() => undefined);
  }
  // 保留 manifest 引用集合 → 清理孤儿 blob
  const referenced = new Set(manifests.slice(0, keep).flatMap((manifest) => manifest.entries.map((entry) => entry.blob)));
  const blobsRoot = join(gateway.root, SNAPSHOT_BLOBS_DIR);
  const walk = async (dirAbs2: string): Promise<void> => {
    const dirents = await fs.readdir(dirAbs2, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const abs = join(dirAbs2, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
      } else if (dirent.isFile() && !dirent.name.endsWith(".tmp") && !referenced.has(dirent.name)) {
        await fs.rm(abs, { force: true }).catch(() => undefined);
      }
    }
  };
  await walk(blobsRoot);
  return pruned.length;
}

/**
 * 整体回滚到指定快照：
 * ① 强制生成 pre_restore 快照（撤销窗口；内容未变时以现有最新一份为回滚锚点）；
 * ② 逐文件原子写回（被删文件重建；写回不经 baseHash——恢复是显式整体回滚语义，
 *    由 UI 二次确认 + ① 共同兜底）；
 * ③ 快照之后新增的文件保守保留，仅在结果中列出。
 */
export async function restoreSnapshot(
  gateway: ProjectGateway,
  id: string,
): Promise<SnapshotRestoreResultPayload> {
  const manifests = await readManifests(gateway);
  const target = manifests.find((manifest) => manifest.id === id);
  if (!target) {
    throw new YushuError("E_SNAPSHOT_INVALID", `快照不存在或已损坏：${id}`);
  }
  const pre = await takeSnapshot(gateway, "pre_restore", { force: true });
  const preRestoreId = pre.snapshot?.id ?? pre.latest?.id ?? "";
  const preRestoreTaken = pre.outcome === "taken";

  let restoredFiles = 0;
  let recreatedFiles = 0;
  for (const entry of target.entries) {
    const content = await readBlob(gateway, entry.blob);
    const existed = await gateway.exists(entry.path);
    await gateway.restoreDoc(entry.path, content);
    if (existed) restoredFiles += 1;
    else recreatedFiles += 1;
  }

  const known = new Set(target.entries.map((entry) => entry.path));
  const extraFiles = (await gateway.listTree())
    .filter((entry: TreeEntry) => entry.type === "file" && isSnapshotSource(entry.path) && !known.has(entry.path))
    .map((entry) => entry.path);

  return { id, preRestoreId, preRestoreTaken, restoredFiles, recreatedFiles, extraFiles };
}

/**
 * 自动快照循环（主进程）：打开项目即检查一次（建立基线），此后每 intervalMs 检查；
 * 单飞（上一轮未结束则跳过本轮）；失败不影响使用（下个周期重试）；定时器 unref 不阻塞退出。
 */
export class SnapshotLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly take: () => Promise<void>,
    private readonly intervalMs = SNAPSHOT_MIN_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): "idle" | "running" {
    return this.running ? "running" : "idle";
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.take();
    } catch {
      /* 快照失败不打断使用：下个周期自动重试（快照非真源，缺失不影响写作） */
    } finally {
      this.running = false;
    }
  }
}