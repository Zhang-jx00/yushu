// 御书 renderer 开发脚本：启动 Vite dev server，并拉起 Electron 指向该地址。
// 用法：pnpm --filter @yushu/desktop dev（会先编译主进程，再执行本脚本）
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createServer } from "vite";

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
});
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error("[dev] Vite dev server 未返回地址");
  process.exit(1);
}
console.log(`[dev] renderer dev server: ${url}`);
console.log("[dev] 启动 Electron（关闭窗口即退出）…");

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

child.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});