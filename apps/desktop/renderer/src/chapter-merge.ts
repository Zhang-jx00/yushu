/**
 * 章节三方合并（M2 / T2-6 完整版）：
 * base（上次已知磁盘内容）× local（编辑器当前）× remote（磁盘最新）→ 行级 diff3。
 *
 * - 双方改动落在不同区域 → **干净合并**（自动写回，不再冻结）；
 * - 改动重叠且结果不同 → **冲突**：输出 `<<<<<<< / ||||||| / ======= / >>>>>>>` 标记块，
 *   绝不猜测、绝不静默选边——由调用方维持"冻结 + 人工处置"路径；
 * - 保守判定：零宽插入与相邻改动视为重叠（拿不准就报冲突，交给人工）；
 * - 纯函数、零依赖；行尾 CRLF 归一为 LF（与产品其余口径一致）。
 *
 * diff 实现：行级 Myers（O(ND)，D 有上限）——常见的"本地续写 + 外部小改"差异很小，
 * 快且准；差异超限（大段重写）回退为"整段替换"单块（更保守：大概率报冲突，不会误合并）。
 */

export interface MergeResult {
  /** true = 无冲突（text 为合并结果） */
  clean: boolean;
  /** 冲突处数（clean 时为 0） */
  conflicts: number;
  /** 合并结果（冲突时含标记块，可用于旁路留档） */
  text: string;
}

interface SideHunk {
  /** base 中的起止行号（[baseStart, baseEnd)，零宽 = 纯插入） */
  baseStart: number;
  baseEnd: number;
  /** 替换后的行 */
  lines: string[];
}

interface TaggedHunk extends SideHunk {
  side: "local" | "remote";
}

/** Myers 差异搜索上限（超过则回退整段替换；上限同时约束内存：trace 规模 ~ O(limit²)） */
const DIFF_LIMIT = 1000;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * 合并输入归一（判定口径）：CRLF → LF；并去掉行尾连续换行。
 * 行尾换行是序列化细节（写回经 serializeCard 会补回单个换行），不参与合并判定——
 * 否则「编辑器内容无尾换行 × 磁盘内容有尾换行」会在文末多出/少掉一行空行，
 * 与"文末追加"类改动落在同一位置被保守判成冲突（实测暴露的假冲突）。
 */
function canonicalizeForMerge(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * 行级 Myers diff：返回把 `a` 变成 `b` 的替换块列表（连续增删合并为一个块）。
 * 端点检测到限制内无路径 → 回退为「[0, len(a)) 全部替换为 b」单块。
 */
export function diffLines(a: string[], b: string[]): SideHunk[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ baseStart: 0, baseEnd: 0, lines: b.slice() }];
  if (m === 0) return [{ baseStart: 0, baseEnd: n, lines: [] }];

  // k = x - y，|k| ≤ d ≤ maxD；V 只存 maxD 范围（与文档长度无关，控制 trace 内存）
  const maxD = Math.min(DIFF_LIMIT, n + m);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!; // 垂直（插入 b）
      } else {
        x = v[offset + k - 1]! + 1; // 水平（删除 a）
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) {
    // 超出差异上限（大段重写）：整段替换单块（保守；不会误判为干净合并）
    return [{ baseStart: 0, baseEnd: n, lines: b.slice() }];
  }

  type Op = "=" | "+" | "-";
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) {
      prevK = k + 1; // 垂直（插入）
    } else {
      prevK = k - 1; // 水平（删除）
    }
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push("+");
      y -= 1;
    } else {
      ops.push("-");
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x -= 1;
    y -= 1;
  }
  ops.reverse();

  // 编辑脚本 → 替换块（连续 -/+ 合并；纯 + 为零宽插入）
  const hunks: SideHunk[] = [];
  let aPos = 0;
  let bPos = 0;
  let pendingStart = -1;
  let pendingEnd = -1;
  const pendingLines: string[] = [];
  const flush = () => {
    if (pendingStart < 0) return;
    hunks.push({ baseStart: pendingStart, baseEnd: pendingEnd, lines: pendingLines.slice() });
    pendingStart = -1;
    pendingEnd = -1;
    pendingLines.length = 0;
  };
  for (const op of ops) {
    if (op === "=") {
      flush();
      aPos += 1;
      bPos += 1;
      continue;
    }
    if (pendingStart < 0) pendingStart = aPos;
    if (op === "-") {
      aPos += 1;
      pendingEnd = aPos;
    } else {
      pendingLines.push(b[bPos]!);
      bPos += 1;
      if (pendingEnd < 0) pendingEnd = pendingStart; // 纯插入：零宽
    }
  }
  flush();
  return hunks;
}

/** 保守重叠判定：区间相交，或零宽插入落在另一区间端点（含相邻）时视为重叠 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (aStart === aEnd && bStart === bEnd) return aStart === bStart;
  if (aStart === aEnd) return aStart >= bStart && aStart <= bEnd;
  if (bStart === bEnd) return bStart >= aStart && bStart <= aEnd;
  return aStart < bEnd && bStart < aEnd;
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 把某一侧的 hunks 应用到 base[clusterStart, clusterEnd)：返回该区间的替换结果 */
function applySide(
  base: string[],
  clusterStart: number,
  clusterEnd: number,
  hunks: SideHunk[],
): string[] {
  const out: string[] = [];
  let pos = clusterStart;
  for (const hunk of hunks) {
    out.push(...base.slice(pos, hunk.baseStart));
    out.push(...hunk.lines);
    pos = hunk.baseEnd;
  }
  out.push(...base.slice(pos, clusterEnd));
  return out;
}

/**
 * 三方合并：干净合并返回 { clean: true, text }；有冲突返回 { clean: false, conflicts, text }。
 */
export function merge3(baseText: string, localText: string, remoteText: string): MergeResult {
  const base = splitLines(canonicalizeForMerge(baseText));
  const local = splitLines(canonicalizeForMerge(localText));
  const remote = splitLines(canonicalizeForMerge(remoteText));

  const tagged: TaggedHunk[] = [
    ...diffLines(base, local).map((hunk) => ({ ...hunk, side: "local" as const })),
    ...diffLines(base, remote).map((hunk) => ({ ...hunk, side: "remote" as const })),
  ];
  if (tagged.length === 0) {
    return { clean: true, conflicts: 0, text: baseText.replace(/\r\n/g, "\n").replace(/\n+$/, "") };
  }
  tagged.sort((p, q) => p.baseStart - q.baseStart || p.baseEnd - q.baseEnd);

  // 聚类：保守重叠（零宽插入贴边也算）→ 同簇必须整体协商
  const clusters: { start: number; end: number; items: TaggedHunk[] }[] = [];
  for (const hunk of tagged) {
    const last = clusters[clusters.length - 1];
    if (last && overlaps(last.start, last.end, hunk.baseStart, hunk.baseEnd)) {
      last.end = Math.max(last.end, hunk.baseEnd);
      last.items.push(hunk);
    } else {
      clusters.push({ start: hunk.baseStart, end: hunk.baseEnd, items: [hunk] });
    }
  }

  const out: string[] = [];
  let pos = 0;
  let conflicts = 0;
  for (const cluster of clusters) {
    out.push(...base.slice(pos, cluster.start));
    const localHunks = cluster.items.filter((item) => item.side === "local");
    const remoteHunks = cluster.items.filter((item) => item.side === "remote");
    const baseSeg = base.slice(cluster.start, cluster.end);
    if (localHunks.length > 0 && remoteHunks.length > 0) {
      const localSeg = applySide(base, cluster.start, cluster.end, localHunks);
      const remoteSeg = applySide(base, cluster.start, cluster.end, remoteHunks);
      if (linesEqual(localSeg, remoteSeg)) {
        out.push(...localSeg); // 双方做出一致改动：直接采用
      } else {
        conflicts += 1;
        out.push(
          "<<<<<<< 本地（编辑器）",
          ...localSeg,
          "||||||| 基础（上次保存）",
          ...baseSeg,
          "=======",
          ...remoteSeg,
          ">>>>>>> 磁盘（外部改动）",
        );
      }
    } else if (localHunks.length > 0) {
      out.push(...applySide(base, cluster.start, cluster.end, localHunks));
    } else {
      out.push(...applySide(base, cluster.start, cluster.end, remoteHunks));
    }
    pos = cluster.end;
  }
  out.push(...base.slice(pos));

  const text = out.join("\n");
  return { clean: conflicts === 0, conflicts, text };
}