import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@yushu/core": resolve("./packages/@yushu/core/src/index.ts"),
      "@yushu/schema": resolve("./packages/@yushu/schema/src/index.ts"),
      "@yushu/genre-engine": resolve("./packages/@yushu/genre-engine/src/index.ts"),
      "@yushu/world-engine": resolve("./packages/@yushu/world-engine/src/index.ts"),
      "@yushu/llm": resolve("./packages/@yushu/llm/src/index.ts"),
      "@yushu/memory": resolve("./packages/@yushu/memory/src/index.ts"),
      "@yushu/export": resolve("./packages/@yushu/export/src/index.ts"),
      "@yushu/search": resolve("./packages/@yushu/search/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
  },
});