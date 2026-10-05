import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  SESSION_PATH,
  beginSession,
  endSession,
  endSessionSync,
  isSnapshotStale,
  touchSession,
} from "../src/main/session-ops.js";

/**
 * 会话异常退出检测（T2-8 切片 B）：标记生命周期 / pid 守卫（同进程重开不误报）/ 心跳 / 损坏容错。
 * 判定「异常退出」= 上次 state=active 且 pid ≠ 当前进程。
 */

let dir: string;
let gateway: ProjectGateway;

const SESSION_ABS = () => join(dir, SESSION_PATH);

async function readMarker(): Promise<Record<string, unknown> | null> {
  return readFile(SESSION_ABS(), "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => null);
}

async function writeMarker(data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(SESSION_ABS()), { recursive: true });
  await writeFile(SESSION_ABS(), JSON.stringify(data), "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-session-"));
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("会话异常退出检测（T2-8 切片 B）", () => {
  it("首开无历史：不报异常；标记为 active 且 pid 为当前进程", async () => {
    const result = await beginSession(gateway, new Date("2026-10-05T10:00:00.000Z"));
    expect(result.abnormalExit).toBeNull();
    const marker = await readMarker();
    expect(marker).toMatchObject({
      state: "active",
      pid: process.pid,
      startedAt: "2026-10-05T10:00:00.000Z",
      lastSeenAt: "2026-10-05T10:00:00.000Z",
    });
  });

  it("正常退出后重开：closed 标记不报异常；active 且他进程 pid 才报异常", async () => {
    await beginSession(gateway);
    await endSession(gateway, new Date("2026-10-05T10:30:00.000Z"));
    expect((await readMarker())?.state).toBe("closed");
    expect((await beginSession(gateway)).abnormalExit).toBeNull();

    // 伪造「上次会话被强杀」：active + 旧 pid → 检出异常（含 start/lastSeen）
    await writeMarker({
      schema_version: 1,
      state: "active",
      pid: 999999,
      startedAt: "2026-10-05T09:00:00.000Z",
      lastSeenAt: "2026-10-05T09:30:00.000Z",
    });
    const detected = await beginSession(gateway);
    expect(detected.abnormalExit).toEqual({
      startedAt: "2026-10-05T09:00:00.000Z",
      lastSeenAt: "2026-10-05T09:30:00.000Z",
    });
  });

  it("同进程重开（pid 守卫）：active 标记但 pid 相同 → 不报异常（渲染层 reload 不误报）", async () => {
    await beginSession(gateway, new Date("2026-10-05T08:00:00.000Z"));
    const second = await beginSession(gateway, new Date("2026-10-05T08:05:00.000Z"));
    expect(second.abnormalExit).toBeNull();
    expect((await readMarker())?.startedAt).toBe("2026-10-05T08:05:00.000Z");
  });

  it("心跳：active 时刷新 lastSeenAt；closed 后 touch 不再改写", async () => {
    await beginSession(gateway, new Date("2026-10-05T08:00:00.000Z"));
    await touchSession(gateway, new Date("2026-10-05T08:01:00.000Z"));
    expect((await readMarker())?.lastSeenAt).toBe("2026-10-05T08:01:00.000Z");

    await endSession(gateway, new Date("2026-10-05T08:02:00.000Z"));
    await touchSession(gateway, new Date("2026-10-05T08:03:00.000Z"));
    expect((await readMarker())?.lastSeenAt).toBe("2026-10-05T08:02:00.000Z");
  });

  it("损坏标记：按无历史会话处理（不报异常、下次写入覆盖）；endSession 无标记时为无操作", async () => {
    await writeMarker({ garbage: true });
    expect((await beginSession(gateway)).abnormalExit).toBeNull();
    expect((await readMarker())?.state).toBe("active");
    await endSession(gateway); // 正常置 closed
    await rm(SESSION_ABS(), { force: true });
    await expect(endSession(gateway)).resolves.toBeUndefined(); // 缺失：无操作不抛
  });

  it("endSessionSync（before-quit 同步路径）：active → closed；缺失 / 损坏不抛", async () => {
    await beginSession(gateway);
    endSessionSync(gateway, new Date("2026-10-05T11:00:00.000Z"));
    expect(await readMarker()).toMatchObject({ state: "closed", lastSeenAt: "2026-10-05T11:00:00.000Z" });

    await rm(SESSION_ABS(), { force: true });
    expect(() => endSessionSync(gateway)).not.toThrow();
    await writeMarker({ broken: 1 });
    expect(() => endSessionSync(gateway)).not.toThrow();
  });

  it("脏快照判定：无异常恒 false；无快照 / 快照早于 lastSeenAt 为 true", () => {
    const exit = { startedAt: "2026-10-05T09:00:00.000Z", lastSeenAt: "2026-10-05T09:30:00.000Z" };
    const snap = (createdAt: string) => ({ id: "s", createdAt, reason: "auto" as const, files: 1, bytes: 1 });
    expect(isSnapshotStale(null, snap("2026-10-05T09:29:00.000Z"))).toBe(false);
    expect(isSnapshotStale(exit, null)).toBe(true);
    expect(isSnapshotStale(exit, snap("2026-10-05T09:29:00.000Z"))).toBe(true);
    expect(isSnapshotStale(exit, snap("2026-10-05T09:31:00.000Z"))).toBe(false);
  });
});