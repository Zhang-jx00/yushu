import { promises as fs, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SessionAbnormalExitPayload,
  SnapshotSummaryPayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 会话标记与异常退出检测（M2 / T2-8 切片 B；docs/04 "启动检测未完成写入与脏快照"）：
 *
 * - 打开项目（attachProject）时写入 `.yushu/session.json`（state=active，含主进程 pid）；
 * - 正常退出（关闭窗口 → app.quit 的 before-quit、或切换 / 关闭项目）写 state=closed；
 * - 启动时若发现 `state=active` 且 **pid 与当前进程不同** → 上次会话异常退出（崩溃 / 被强杀）。
 *   同进程重复打开（渲染层 reload、同进程切换项目再切回）不算异常——pid 守卫避免误报；
 * - 快照循环（60s）顺带刷新 lastSeenAt（心跳），供「脏快照」提示：若最近快照早于
 *   上次会话的最后可见时间，说明快照可能不含崩溃前的最后一段修改（提示走本地快照回退）；
 * - session.json 是诊断辅助数据：位于 `.yushu/`（索引排除、不入 Git），损坏按"无历史会话"处理。
 */

export const SESSION_PATH = ".yushu/session.json";

interface SessionFile {
  schema_version: number;
  state: "active" | "closed";
  pid: number;
  startedAt: string;
  lastSeenAt: string;
}

export interface SessionOpenResult {
  /** 上次会话异常退出的信息（无异常 / 无历史会话时为 null） */
  abnormalExit: SessionAbnormalExitPayload | null;
}

function isValidSession(data: unknown): data is SessionFile {
  const file = data as SessionFile;
  return (
    Boolean(file) &&
    typeof file === "object" &&
    (file.state === "active" || file.state === "closed") &&
    typeof file.pid === "number" &&
    typeof file.startedAt === "string" &&
    typeof file.lastSeenAt === "string"
  );
}

async function readSessionFile(gateway: ProjectGateway): Promise<SessionFile | null> {
  try {
    const data = JSON.parse(await fs.readFile(join(gateway.root, SESSION_PATH), "utf8")) as unknown;
    return isValidSession(data) ? data : null;
  } catch {
    return null; // 缺失 / 损坏：按"无历史会话"处理（不静默删文件，下次写入覆盖）
  }
}

async function writeSessionFile(gateway: ProjectGateway, file: SessionFile): Promise<void> {
  const abs = join(gateway.root, SESSION_PATH);
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await fs.rename(tmp, abs);
}

/**
 * 打开项目时调用：检测上次会话是否异常退出，并写入本次 active 标记。
 * 判定「异常」需同时满足 state=active 且 pid ≠ 当前进程——同进程重开（reload）不误报。
 */
export async function beginSession(gateway: ProjectGateway, now?: Date): Promise<SessionOpenResult> {
  const at = (now ?? new Date()).toISOString();
  const prev = await readSessionFile(gateway);
  const abnormalExit =
    prev && prev.state === "active" && prev.pid !== process.pid
      ? { startedAt: prev.startedAt, lastSeenAt: prev.lastSeenAt }
      : null;
  await writeSessionFile(gateway, {
    schema_version: 1,
    state: "active",
    pid: process.pid,
    startedAt: at,
    lastSeenAt: at,
  });
  return { abnormalExit };
}

/** 心跳（随快照循环 60s 调用）：仅刷新 active 会话的 lastSeenAt */
export async function touchSession(gateway: ProjectGateway, now?: Date): Promise<void> {
  const file = await readSessionFile(gateway);
  if (!file || file.state !== "active") return;
  file.lastSeenAt = (now ?? new Date()).toISOString();
  await writeSessionFile(gateway, file);
}

/** 正常退出（关闭项目 / before-quit）：把 active 会话标记为 closed */
export async function endSession(gateway: ProjectGateway, now?: Date): Promise<void> {
  const file = await readSessionFile(gateway);
  if (!file || file.state !== "active") return;
  file.state = "closed";
  file.lastSeenAt = (now ?? new Date()).toISOString();
  await writeSessionFile(gateway, file);
}

/**
 * 进程退出路径专用（before-quit 不能等待异步）：同步读写原子落盘（小文件，退出路径可接受）。
 * 失败静默——退出路径不允许被诊断数据阻塞。
 */
export function endSessionSync(gateway: ProjectGateway, now?: Date): void {
  try {
    const abs = join(gateway.root, SESSION_PATH);
    const data = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (!isValidSession(data) || data.state !== "active") return;
    data.state = "closed";
    data.lastSeenAt = (now ?? new Date()).toISOString();
    const tmp = `${abs}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, abs);
  } catch {
    /* 退出路径：诊断数据落盘失败不阻塞退出 */
  }
}

/**
 * 「脏快照」判定（纯函数，供状态通道与单测）：最近快照早于上次会话的最后可见时间
 * （或无任何快照）→ 快照可能不含崩溃前的最后修改。
 */
export function isSnapshotStale(
  abnormalExit: SessionAbnormalExitPayload | null,
  lastSnapshot: SnapshotSummaryPayload | null,
): boolean {
  if (!abnormalExit) return false;
  if (!lastSnapshot) return true;
  return lastSnapshot.createdAt < abnormalExit.lastSeenAt;
}