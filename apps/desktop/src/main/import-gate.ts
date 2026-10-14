import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

/**
 * 存量导入的「挑选闸门」（M5 / T5-7 桌面侧，R77）。
 *
 * 存在理由：红线 5 要求一切读写走 FileGateway 并拒绝绝对路径逃逸，而导入外部稿件天生要读
 * 项目目录**之外**的文件。若开一条"渲染层传路径进来"的通道，护栏就等于被拆掉——任何一段
 * 注入进渲染层的代码都能拿它去读 `~/.ssh/id_rsa` 或别的项目的稿子。
 *
 * 所以：**路径只能由主进程的原生对话框结果登记**（用户亲手选的），登记后发一张 ticket；
 * 渲染层此后只持有并回传 ticket，**永远不把路径当参数传**。闸门另加三条限制：TTL、
 * 单次可读字节上限、目录拒读。取消导入时 `revoke` 立刻作废。
 */

/** 单文件读取上限：32 MB（超长文本再考虑分段导入，不在这里放开任意大文件） */
export const IMPORT_MAX_BYTES = 32 * 1024 * 1024;

/** 票据默认有效期：10 分钟——够"预览 → 看一眼报告 → 确认入库"，不够被长期复用 */
export const IMPORT_TICKET_TTL_MS = 10 * 60 * 1000;

export interface PickedFile {
  ticket: string;
  path: string;
  bytes: number;
  name: string;
}

interface TicketRecord {
  path: string;
  issuedAt: number;
  bytes: number;
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

export class ImportGate {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? IMPORT_TICKET_TTL_MS;
  }

  /** 主进程拿到原生对话框的结果后调用：验存在、是文件、不超限，才发一张票 */
  async register(path: string): Promise<PickedFile> {
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error("E_IMPORT_PICK：没有选中任何文件");
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`E_IMPORT_PICK：读不到「${baseName(path)}」，可能已被移动或删除`);
    }
    if (!info.isFile()) throw new Error("E_IMPORT_PICK：选中的不是文件（导入只接受单个文本文件）");
    if (info.size > IMPORT_MAX_BYTES) {
      throw new Error(
        `E_IMPORT_PICK：文件 ${String(info.size)} 字节，超过上限 ${String(IMPORT_MAX_BYTES)} 字节——请拆分后再导入`,
      );
    }
    const ticket = randomBytes(16).toString("hex");
    this.tickets.set(ticket, { path, issuedAt: Date.now(), bytes: info.size });
    return { ticket, path, bytes: info.size, name: baseName(path) };
  }

  /** 凭票取字节：未知票 / 过期票一律拒；`now` 可注入，好让测试真的能测到过期分支 */
  async readTicket(ticket: string, now = Date.now()): Promise<{ path: string; bytes: Uint8Array }> {
    const record = typeof ticket === "string" ? this.tickets.get(ticket) : undefined;
    if (record === undefined) throw new Error("E_IMPORT_TICKET：票据无效或已撤销（请重新选择文件）");
    if (now - record.issuedAt > this.ttlMs) {
      this.tickets.delete(ticket);
      throw new Error("E_IMPORT_TICKET：票据已过期（超过 10 分钟），请重新选择文件");
    }
    const bytes = await readFile(record.path);
    return { path: record.path, bytes: new Uint8Array(bytes) };
  }

  /** 用户取消导入：立刻作废这张票 */
  revoke(ticket: string): void {
    this.tickets.delete(ticket);
  }

  /** 当前有效票数（只给测试与诊断用，不进任何对外文案） */
  size(): number {
    return this.tickets.size;
  }
}

/** 进程内单例：主进程对话框与导入通道共用一本票 */
export const importGate = new ImportGate();
