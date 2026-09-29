import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * 御书 renderer 构建配置。
 * - root = renderer/，产物输出到 renderer/dist（Electron 生产模式以 file:// 加载）
 * - CSP 经 transformIndexHtml 注入：开发模式放宽以支持 Vite HMR，生产保持严格
 */

function cspPlugin(): Plugin {
  return {
    name: "yushu-csp",
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server);
      const scriptSrc = dev ? "'self' 'unsafe-inline' http://localhost:*" : "'self'";
      const connectSrc = dev ? "'self' ws://localhost:* http://localhost:*" : "'self'";
      const csp = [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        `connect-src ${connectSrc}`,
      ].join("; ");
      return html.replace("%CSP%", csp);
    },
  };
}

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react(), cspPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});