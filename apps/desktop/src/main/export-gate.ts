/* SPDX-License-Identifier: Apache-2.0 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { YushuError } from "@yushu/core";

/**
 * 导出目标的「票据闸门」（M3 / T3-14 后半，R101）。
 *
 * 与 R77 的导入闸门是同一族问题、同一个答案：**路径不出主进程**。
 * 迁移包要写到项目**之外**的目录，如果通道签名是 `run(targetDir: string)`，
 * 那么任何能往渲染层注入代码的东西都能拿它把文件写进 `~`、写进别的项目、或覆盖别人的稿子——
 * 红线 5 就被从背面拆掉了。所以渲染层只持有一张票：**目录由原生对话框结果登记，之后只回传票号**。
 *
 * 与导入闸门的两处不同：这里登记的是**目录**不是文件（导入那边反过来：目录要拒），
 * 并且不设字节上限（导出量由项目本身决定），但设 TTL 与"一次性解析后即失效由调用方决定"——
 * 这里选择**不**一次消费：预览与落笔要用同一张票，所以只靠 TTL 与显式 revoke 收口。
 */

/** 票据默认有效期：10 分钟——够"选目录 → 看清单 → 确认导出"，不够被长期复用 */
export const EXPORT_TARGET_TTL_MS = 10 * 60 * 1000;

export interface PickedTargetDir {
  ticket: string;
  /** 只显示用的目录名：绝对路径不外传（迁移包会被发给别人，本机路径是隐私） */
  name: string;
  /** 目录里现有条目数（0 = 空目录；非空也允许，因为导出写的是新子目录） */
  entries: number;
}

interface TicketRecord {
  path: string;
  name: string;
  issuedAt: number;
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

export class ExportTargetGate {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? EXPORT_TARGET_TTL_MS;
  }

  /** 主进程拿到原生对话框的结果后调用：必须存在且是目录，才发一张票 */
  async register(path: string): Promise<PickedTargetDir> {
    if (typeof path !== "string" || path.trim() === "") {
      throw new YushuError("E_EXPORT_TICKET", "没有选中导出目标目录（对话框被取消或路径为空）");
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      // 错误里只给名字不给路径：这句话会被抄进面板、也可能被抄进日志与截图
      throw new YushuError("E_EXPORT_TICKET", `读不到目标目录「${baseName(path)}」，可能已被移动或删除`);
    }
    if (!info.isDirectory()) {
      throw new YushuError("E_EXPORT_TICKET", `「${baseName(path)}」不是目录：迁移包要导出到一个空（或任意）目录里`);
    }
    const ticket = randomBytes(16).toString("hex");
    this.tickets.set(ticket, { path, name: baseName(path), issuedAt: Date.now() });
    return { ticket, name: baseName(path), entries: 0 };
  }

  /** 凭票取绝对路径（只在主进程内部使用）；过期即作废 */
  resolve(ticket: string, now = Date.now()): string {
    const record = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
    if (record === undefined) throw new YushuError("E_EXPORT_TICKET", "票据无效或已撤销（请重新选择导出目标目录）");
    if (now - record.issuedAt > this.ttlMs) {
      this.tickets.delete(ticket);
      throw new YushuError("E_EXPORT_TICKET", "票据已过期（超过 10 分钟），请重新选择导出目标目录");
    }
    return record.path;
  }

  /** 换目录或用户放弃时作废 */
  revoke(ticket: string): void {
    this.tickets.delete(ticket);
  }

  /** 当前有效票数（只给测试与诊断用） */
  size(): number {
    return this.tickets.size;
  }
}

/** 进程内单例：对话框与导出通道共用一本票 */
export const exportTargets = new ExportTargetGate();
