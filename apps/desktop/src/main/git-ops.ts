import * as fs from "node:fs";
import { join } from "node:path";
import { YushuError } from "@yushu/core";
import type {
  GitChangePayload,
  GitCommitEntryPayload,
  GitCommitResultPayload,
  GitRollbackResultPayload,
  GitStatePayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { isSnapshotSource, takeSnapshot } from "./snapshot-ops.js";

/**
 * Git 版本管理（M2 / T2-7 切片 B；docs/04：isomorphic-git 集成，一次批量改动 = 一次提交，可整体回滚）。
 *
 * - 仓库位于项目根（`.git/`，纯本地、不经网络；isomorphic-git 以 Node fs 适配器操作，无原生依赖）；
 * - **惰性加载**：isomorphic-git 仅在首次 Git 操作时动态 import——启动路径（冷启动）不为未用 Git 的
 *   用户付出模块解析成本（perf 回归对比暴露启动加载影响后改为惰性，报告见 docs/assets/perf/）；
 * - **纳入范围**：内容白名单（与快照一致，`isSnapshotSource`）且排除 `.yushu/`（作者操作数据不入 Git）、
 *   `exports/`（导出产物）、`node_modules/`、`.git/`——与索引 / 快照同一口径；
 * - **一次批量改动 = 一次提交**：面板列全部变更（新增 / 修改 / 删除）→ 勾选语义即"全部"，一次 commit；
 * - **整体回滚（K10）**：把工作区文件回滚到指定提交的内容——**不改写历史**（HEAD 不动，回滚本身成为
 *   新的待提交改动）；回滚前强制 `pre_restore` 快照（失败即阻断，撤销窗口恒在）；提交中存在而磁盘缺失
 *   的文件重建、内容不同的写回、磁盘上该提交不存在的文件**保守保留**（列出不删除，与快照恢复同语义）；
 * - 串行队列：同一仓库的写操作（init / commit / rollback）主进程内串行，避免 `.git/index` 争用（K04 精神）；
 * - 作者身份：优先仓库 / 全局 git 配置 `user.name` / `user.email`；未配置时降级为内置默认并写入**仓库级**配置
 *   （只在缺失时写，不覆盖用户配置；如实记录在 docs）。
 */

/** 不入 Git 的路径前缀（与索引 / 快照口径一致；`.yushu/` 是作者操作数据） */
export const GIT_EXCLUDES = [".yushu/", ".git/", "node_modules/", "exports/"];

/**
 * 写进项目根 `.gitignore` 的行（`.git/` 由 git 自身处理，无需列）。
 * 与 GIT_EXCLUDES 同源但**不含** `.git/`——那是 git 的内部目录，写进 ignore 文件反而误导。
 */
export const PROJECT_GITIGNORE_LINES = [".yushu/", "exports/", "node_modules/"];

/**
 * 补齐项目根 `.gitignore`：保留用户既有内容与注释，只追加缺失行；幂等（重复调用不改字节）。
 *
 * 为什么要落成文件，而不是只在结果侧用 `isGitPath` 过滤：
 * ① **遍历成本与竞态**——isomorphic-git 的 `statusMatrix` 先走完整棵树再由 map 判定，命中 ignore 的目录
 *    会被**整棵剪掉**（不再 stat 其中文件）；单靠结果过滤则仍会 stat `.yushu/` 里的 SQLite `-wal` / `-shm`
 *    侧车，这类文件在扫描中途消失就抛 `ENOENT ... lstat`（e2e 实测撞到过一次）。
 * ② **安全口径要能被外部 git 复用**——应用内的过滤只在御书自己提交时生效；用户用命令行 / 其它客户端
 *    `git add .` 时，`.yushu/secrets.json`（凭据库密文）与索引库会被一起提交。写进 `.gitignore`
 *    后，"派生物与凭据不入 Git" 成为仓库自身的事实（K12 / T3-14）。
 */
async function ensureGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  let text = "";
  try {
    text = await fs.promises.readFile(path, "utf8");
  } catch {
    text = ""; // 尚不存在：按空文件处理
  }
  const present = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
  const missing = PROJECT_GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  await fs.promises.writeFile(path, `${base}${missing.join("\n")}\n`, "utf8");
}

/** 内置默认作者（用户未配置 git 身份时的降级；仅写入仓库级配置，不碰全局） */
export const GIT_DEFAULT_AUTHOR = { name: "御书作者", email: "yushu@local" } as const;

type GitApi = (typeof import("isomorphic-git"))["default"];

let gitPromise: Promise<GitApi> | null = null;

/** 惰性加载 isomorphic-git（首次 Git 操作时解析模块；此后复用） */
function loadGit(): Promise<GitApi> {
  gitPromise ??= import("isomorphic-git").then((mod) => mod.default);
  return gitPromise;
}

/** 该路径是否纳入 Git（内容白名单由 isSnapshotSource 另行判定） */
export function isGitPath(path: string): boolean {
  return !GIT_EXCLUDES.some((prefix) => path.startsWith(prefix));
}

/** 仓库写操作串行队列（init / commit / rollback；与 withSnapshotLock 同模式） */
let gitQueue: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitQueue.then(fn, fn);
  gitQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRepo(dir: string): boolean {
  return fs.existsSync(join(dir, ".git"));
}

/** statusMatrix 行 → 变更类型（[head, workdir] 语义见 isomorphic-git 文档；未变返回 null） */
function classifyChange(head: number, workdir: number): GitChangePayload["state"] | null {
  if (head === 0 && workdir === 0) return null;
  if (workdir === 0) return "deleted";
  if (head === 0) return "new";
  if (head === 1 && workdir === 1) return null;
  return "modified";
}

/** 工作区变更（按路径升序；已按口径过滤——内容白名单 + 排除目录） */
async function listChanges(git: GitApi, dir: string): Promise<GitChangePayload[]> {
  const rows = await git.statusMatrix({ fs, dir, filter: (path) => isGitPath(path) });
  const changes: GitChangePayload[] = [];
  for (const row of rows) {
    const path = row[0];
    if (!isGitPath(path) || !isSnapshotSource(path)) continue;
    const state = classifyChange(row[1], row[2]);
    if (state) changes.push({ path, state });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveAuthor(git: GitApi, dir: string): Promise<{ name: string; email: string }> {
  const name = await git.getConfig({ fs, dir, path: "user.name" }).catch(() => undefined);
  const email = await git.getConfig({ fs, dir, path: "user.email" }).catch(() => undefined);
  return {
    name: typeof name === "string" && name.trim() !== "" ? name : GIT_DEFAULT_AUTHOR.name,
    email: typeof email === "string" && email.trim() !== "" ? email : GIT_DEFAULT_AUTHOR.email,
  };
}

/** 仓库级作者配置兜底（只在缺失时写；不覆盖用户既有配置） */
async function ensureAuthorConfig(git: GitApi, dir: string): Promise<void> {
  const name = await git.getConfig({ fs, dir, path: "user.name" }).catch(() => undefined);
  if (typeof name !== "string" || name.trim() === "") {
    await git.setConfig({ fs, dir, path: "user.name", value: GIT_DEFAULT_AUTHOR.name }).catch(() => undefined);
  }
  const email = await git.getConfig({ fs, dir, path: "user.email" }).catch(() => undefined);
  if (typeof email !== "string" || email.trim() === "") {
    await git.setConfig({ fs, dir, path: "user.email", value: GIT_DEFAULT_AUTHOR.email }).catch(() => undefined);
  }
}

/** 最近提交（新→旧；空仓库 / 无提交时返回空数组） */
async function listLog(git: GitApi, dir: string, depth = 20): Promise<GitCommitEntryPayload[]> {
  try {
    const entries = await git.log({ fs, dir, depth });
    return entries.map((entry) => ({
      oid: entry.oid,
      shortOid: entry.oid.slice(0, 10),
      message: entry.commit.message.trim(),
      author: entry.commit.author.name,
      timestamp: entry.commit.author.timestamp * 1000,
    }));
  } catch {
    return [];
  }
}

async function gitStateLocked(git: GitApi, gateway: ProjectGateway): Promise<GitStatePayload> {
  const dir = gateway.root;
  if (!isRepo(dir)) {
    return { initialized: false, branch: null, head: null, changes: [], log: [] };
  }
  const branch = await git.currentBranch({ fs, dir, fullname: false }).catch(() => undefined);
  const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
  return {
    initialized: true,
    branch: typeof branch === "string" && branch !== "" ? branch : null,
    head: headOid ? headOid.slice(0, 10) : null,
    changes: await listChanges(git, dir),
    log: await listLog(git, dir),
  };
}

/** Git 状态（未初始化 / 分支 / HEAD / 变更 / 最近提交） */
export function gitState(gateway: ProjectGateway): Promise<GitStatePayload> {
  return withGitLock(async () => gitStateLocked(await loadGit(), gateway));
}

/** 初始化仓库（`main` 分支；幂等——已存在时不重建，但仍补齐 `.gitignore`（老项目可能缺）） */
export function gitInit(gateway: ProjectGateway): Promise<GitStatePayload> {
  return withGitLock(async () => {
    const git = await loadGit();
    const dir = gateway.root;
    if (!isRepo(dir)) {
      await git.init({ fs, dir, defaultBranch: "main" });
      await ensureAuthorConfig(git, dir);
    }
    await ensureGitignore(dir);
    return gitStateLocked(git, gateway);
  });
}

/** 提交全部变更（一次批量改动 = 一次提交；无变更给出可操作错误） */
export function gitCommit(gateway: ProjectGateway, message: string): Promise<GitCommitResultPayload> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed === "") {
    return Promise.reject(new YushuError("E_INVALID_INPUT", "提交信息不能为空"));
  }
  if (trimmed.length > 200) {
    return Promise.reject(new YushuError("E_INVALID_INPUT", "提交信息过长（≤200 字）"));
  }
  return withGitLock(async () => {
    const git = await loadGit();
    const dir = gateway.root;
    if (!isRepo(dir)) {
      throw new YushuError("E_GIT_NOT_INIT", "Git 仓库尚未初始化：请先点击「初始化仓库」");
    }
    const changes = await listChanges(git, dir);
    if (changes.length === 0) {
      throw new YushuError("E_GIT_NO_CHANGES", "没有可提交的改动（工作区已干净）");
    }
    for (const change of changes) {
      if (change.state === "deleted") await git.remove({ fs, dir, filepath: change.path });
      else await git.add({ fs, dir, filepath: change.path });
    }
    const author = await resolveAuthor(git, dir);
    const oid = await git.commit({ fs, dir, message: trimmed, author });
    return { oid, shortOid: oid.slice(0, 10), message: trimmed, files: changes.length };
  });
}

/**
 * 整体回滚到指定提交（工作区语义：**不改写历史**，HEAD 不动——回滚结果成为新的待提交改动）。
 * 回滚前强制 `pre_restore` 快照（与快照恢复同一硬约束；快照失败即抛错阻断）。
 */
export function gitRollback(gateway: ProjectGateway, oid: string): Promise<GitRollbackResultPayload> {
  return withGitLock(async () => {
    const git = await loadGit();
    const dir = gateway.root;
    if (!isRepo(dir)) {
      throw new YushuError("E_GIT_NOT_INIT", "Git 仓库尚未初始化：请先点击「初始化仓库」");
    }
    if (typeof oid !== "string" || !/^[0-9a-f]{7,40}$/i.test(oid)) {
      throw new YushuError("E_INVALID_INPUT", "提交 oid 不合法");
    }
    const resolved = await git.resolveRef({ fs, dir, ref: oid }).catch(() => null);
    if (!resolved) {
      throw new YushuError("E_GIT_BAD_REF", `找不到提交 ${oid.slice(0, 10)}（可能已被清理）`);
    }

    const files = (await git.listFiles({ fs, dir, ref: resolved }))
      .filter((path) => isGitPath(path) && isSnapshotSource(path))
      .sort();
    const fileSet = new Set(files);

    // 撤销窗口：先快照（失败阻断回滚——与快照恢复 / 破坏性操作同一规则）
    const pre = await takeSnapshot(gateway, "pre_restore", { force: true });
    const preRestoreId = pre.snapshot?.id ?? pre.latest?.id ?? null;

    const diskFiles = (await gateway.listTree()).filter(
      (entry) => entry.type === "file" && isGitPath(entry.path) && isSnapshotSource(entry.path),
    );
    const kept = diskFiles.map((entry) => entry.path).filter((path) => !fileSet.has(path)).sort();

    let restored = 0;
    let recreated = 0;
    for (const path of files) {
      const { blob } = await git.readBlob({ fs, dir, oid: resolved, filepath: path });
      const content = Buffer.from(blob).toString("utf8");
      if (!(await gateway.exists(path))) {
        await gateway.restoreDoc(path, content);
        recreated += 1;
        continue;
      }
      const current = await gateway.readDoc(path);
      if (current.content === content) continue;
      await gateway.restoreDoc(path, content);
      restored += 1;
    }

    return {
      oid: resolved,
      shortOid: resolved.slice(0, 10),
      restored,
      recreated,
      kept,
      preRestoreId,
    };
  });
}