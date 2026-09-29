import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 路径基准（dist/main/*.js → apps/desktop → 仓库根） */

export const moduleDir = dirname(fileURLToPath(import.meta.url));
export const appRoot = join(moduleDir, "..", "..");
export const repoRoot = join(appRoot, "..", "..");

/** 内置派系包目录（开发期直接读仓库 packs/；打包期将改为 resources，M1 暂不处理） */
export const packsRoot = join(repoRoot, "packs");