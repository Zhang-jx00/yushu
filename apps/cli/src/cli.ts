#!/usr/bin/env node
import { runRebuild, runSearch, runStatus } from "./commands.js";

/**
 * 御书 CLI（M1 最小版）：无头索引能力。
 * 用法：
 *   yushu rebuild <项目目录>          全量重建索引（.yushu/index.db）
 *   yushu status  <项目目录>          查看索引状态与统计
 *   yushu search  <项目目录> <关键词>  检索索引（全文块 + 实体）
 */

const USAGE = [
  "御书 CLI（M1）",
  "用法：",
  "  yushu rebuild <项目目录>          全量重建索引",
  "  yushu status  <项目目录>          查看索引状态",
  "  yushu search  <项目目录> <关键词>  检索索引",
].join("\n");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, dir, keyword] = process.argv.slice(2);
  if (!command || !dir) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  switch (command) {
    case "rebuild": {
      const result = await runRebuild(dir);
      console.log(
        JSON.stringify(
          {
            ok: true,
            dbPath: result.dbPath,
            stats: result.stats,
            skipped: result.skipped,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "status": {
      const result = runStatus(dir);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "search": {
      if (!keyword) fail("缺少关键词：yushu search <项目目录> <关键词>");
      const result = runSearch(dir, keyword);
      console.log(JSON.stringify({ ok: true, keyword, ...result }, null, 2));
      return;
    }
    default:
      fail(`未知命令：${command}\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});