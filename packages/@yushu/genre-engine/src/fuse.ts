import { basename, extname, relative } from "node:path";
import type { GenreAxes } from "@yushu/core";
import { ELEVEN_PIECE_KEYS, type LoadedPack } from "./types.js";

export interface FuseAdded {
  piece: string;
  /** 相对包目录的文件引用 */
  ref: string;
  /** 来源包 id */
  pack: string;
}

export interface FuseOverridden {
  piece: string;
  /** 冲突的基线名（同名判定） */
  name: string;
  /** 各包引用（顺序即选择顺序） */
  refs: { pack: string; ref: string }[];
  /** 暂定胜出者（选择顺序靠后者，待用户确认） */
  winner: string;
}

export interface FuseConflict {
  kind: string;
  severity: "error" | "warn";
  message: string;
  packs: string[];
}

/** 融合预演报告：新增 / 覆盖 / 冲突三类；未确认不得写入 project.toml（docs/03 §8.3） */
export interface FusionPreviewReport {
  packs: string[];
  genre_axes: GenreAxes;
  added: FuseAdded[];
  overridden: FuseOverridden[];
  conflicts: FuseConflict[];
  /** 无 error 级冲突方可进入"用户确认 → 写入项目配置" */
  ready: boolean;
}

function emptyAxes(): GenreAxes {
  return { channel: [], world: [], technique: [], tone: [] };
}

/**
 * 多包融合预演（纯计算，不落盘）。
 * 消解优先级（G06）：user overrides > pack 显式声明 > 引擎默认；一切冲突显式提示。
 */
export function fuse(packs: LoadedPack[]): FusionPreviewReport {
  const conflicts: FuseConflict[] = [];
  const added: FuseAdded[] = [];
  const overridden: FuseOverridden[] = [];
  const axes = emptyAxes();
  const romanceModes: { pack: string; value: string }[] = [];

  if (packs.length === 0) {
    conflicts.push({
      kind: "empty-selection",
      severity: "error",
      message: "未选择任何派系包",
      packs: [],
    });
    return { packs: [], genre_axes: axes, added: [], overridden, conflicts, ready: false };
  }

  const parts = packs.map((p) => ({
    id: p.manifest.metadata.id,
    dir: p.dir,
    axes: p.manifest.genre_axes,
  }));

  // 四维并集（同维多选合法；重复词去重保留首次出现顺序）
  for (const part of parts) {
    for (const axis of ["channel", "world", "technique", "tone"] as const) {
      for (const value of part.axes?.[axis] ?? []) {
        if (!axes[axis].includes(value)) axes[axis].push(value);
      }
    }
    const romance = part.axes?.romance_mode_default;
    if (romance) romanceModes.push({ pack: part.id, value: romance });
  }
  const distinctRomance = [...new Set(romanceModes.map((r) => r.value))];
  if (distinctRomance.length > 1) {
    conflicts.push({
      kind: "romance-mode-conflict",
      severity: "warn",
      message: `感情线形态声明不一致（${romanceModes.map((r) => `${r.pack}:${r.value}`).join(" / ")}），需用户择一`,
      packs: romanceModes.map((r) => r.pack),
    });
  } else if (distinctRomance.length === 1) {
    axes.romance_mode_default = distinctRomance[0] as GenreAxes["romance_mode_default"];
  }

  // 显式冲突声明（双向检查）
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const a = packs[i]!;
      const b = packs[j]!;
      const aId = parts[i]!.id;
      const bId = parts[j]!.id;
      const hit =
        a.manifest.fusions?.conflicts_with?.find((c) => c.pack === bId) ??
        b.manifest.fusions?.conflicts_with?.find((c) => c.pack === aId);
      if (hit) {
        conflicts.push({
          kind: "pack-explicit-conflict",
          severity: "error",
          message: `${aId} 与 ${bId} 声明互斥：${hit.reason}`,
          packs: [aId, bId],
        });
      }
    }
  }

  // 件套汇总 + 同名覆盖检测（同名 = 同一件套下的同名文件）
  const byPieceName = new Map<string, { pack: string; ref: string }[]>();
  for (const pack of packs) {
    const packId = pack.manifest.metadata.id;
    for (const key of ELEVEN_PIECE_KEYS) {
      if (key === "evolution") continue;
      const files = pack.resolvedFiles[key] ?? [];
      for (const file of files) {
        const ref = relative(pack.dir, file).split("\\").join("/");
        added.push({ piece: key, ref, pack: packId });
        const name = basename(ref, extname(ref));
        const mapKey = `${key}::${name}`;
        const list = byPieceName.get(mapKey) ?? [];
        list.push({ pack: packId, ref });
        byPieceName.set(mapKey, list);
      }
    }
  }
  for (const [mapKey, refs] of byPieceName) {
    const [piece = "", name = ""] = mapKey.split("::");
    const packIds = new Set(refs.map((r) => r.pack));
    if (packIds.size > 1) {
      overridden.push({
        piece,
        name,
        refs,
        winner: refs[refs.length - 1]!.pack,
      });
      conflicts.push({
        kind: "piece-name-collision",
        severity: "warn",
        message: `件套「${piece}」存在同名元素「${name}」，覆盖关系待用户确认（暂定胜出：${refs[refs.length - 1]!.pack}）`,
        packs: [...packIds],
      });
    }
  }

  return {
    packs: parts.map((p) => p.id),
    genre_axes: axes,
    added,
    overridden,
    conflicts,
    ready: !conflicts.some((c) => c.severity === "error"),
  };
}