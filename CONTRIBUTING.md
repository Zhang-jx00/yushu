# 参与贡献

先说清楚这个仓库的验收方式：**跑给我看数字**，不是「看起来对」。
提 PR 前请把下面四连跑完，并在描述里带上实测输出里的真实数字（例：`Tests 1096 passed (1096)` / `ok=56 fail=0`）。

## 四连门禁

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm --filter @yushu/desktop e2e
pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=<空目录>"
```

- 退出码要**直接取**，不要经管道看（`| tail` 会把失败变成 0）。
- 预演需要先构建渲染层：`pnpm --filter @yushu/desktop build:main && pnpm --filter @yushu/desktop build:renderer`。
  只构建主进程时，预演会报「找不到输入框」——那是构建缺失，不是产品缺陷。
- 专项探针：`kill-test`（真实强杀进程不丢稿）、`perf-test`（synth-1m 百万字性能预算）。

## 社区治理与行为准则

- 参与前请先看 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)：适用范围、不可接受的行为，
  以及被认定违规时的**四级处置阶梯**（督促 → 警告 → 临时封禁 → 永久开除）。
- 谁能合并、决定怎么留记录、商业化边界承诺在哪，见 [GOVERNANCE.md](GOVERNANCE.md)。
  一句话版本：**核心离线能力永久免费**，真源永远是仓库里的 Markdown/YAML。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 走，那里写了支持版本范围与确认/修复时限。

## 提交约定

- 一轮改动按**层次切条**：引擎包 → 桌面端（主进程 / preload / 渲染层）→ 文档与证据。没有改动的层次就不产生空提交。
- 每条提交只做一件事，信息里写清「为什么」而不只是「改了什么」。
- 不 `--no-verify`，不强推，不把 `.yushu/`、`exports/`、`dist/`、`node_modules/` 提交进版本库。
- 预演截图落在 `docs/assets/m1-preview/`，随同轮文档一起提交；截图要**看内容**再提交，别只确认文件存在。

## 三条硬规矩（都是踩过坑才写下来的）

1. **新写的断言必须先证明它能红。** 改坏产品实现跑一遍，看到它红、看到它点名，再还原。
   一条不会红的断言比没有更危险——它挂着 ✅，真出问题时所有人都以为已覆盖。
2. **没有调用点的代码不入库。** 写了函数但没人调用，要么这一轮接上，要么先不提交。
3. **文档声称不得跑在账本前面。** 勾一个 `[x]` 必须同时写下证据（测试名 / 探针字段 / 预演步号）；
   拿不到真实外部条件（provider 端点、真实语料、真人试跑）的验收项**一律不勾**，在 `docs/04` 里写明卡在哪。

## 代码风格与架构约束

- TypeScript 严格模式；`unknown` 逐层收窄，不收口到 `any`。
- 纯逻辑放 `packages/@yushu/*`，IO 与进程边界放 `apps/*`；但**数据模型的判断不跟着进程边界走**
  （例：提案的严格格式属引擎，落盘与 IPC 属桌面端）。
- 写盘一律经 `FileGateway`（原子写 + `baseHash` 并发检测）；派生区走 `writeDerived` 那扇窄门（只认 `.yushu/` 前缀），
  不用裸 `fs` 直写。
- IPC 加通道必须**四处同步**：`src/shared/ipc.ts` → `src/main/ipc.ts`（只读走 `wrap`，会改真源的走 `wrapWrite`）
  → `preload/preload.cjs` 白名单 → `renderer/src/api.ts`。仓库里有源码锁测试会当场拦住漏掉的四处。
- 排序走**码点序**（`a < b ? -1 : 1`），禁用 `localeCompare`——它依赖运行机器的区域设置，同输入会得不同输出。
- 界面动效遵守 DASHBOARD 场景上限：不写 `animation: ... infinite`，入场 ≤380ms，位移 ≤6px，缩放 ≥0.98；
  `prefers-reduced-motion` 下 `transition` 与 `animation` 都要关。展开容器按真实内容高度过渡，不许文字突现或布局跳动。

## 这个仓库目前没有的东西（别假装有的）

没有 CI 流水线、没有 lint/format 配置（所以风格靠上面的约定与 code review）、没有打包配置与代码签名、
包级 `test` 脚本（测试从根 `pnpm test` 跑，覆盖全部 9 包 + 2 应用）。
这些是 `docs/04` 里登记的缺口，不是「已完成后没写文档」。

## 提问与讨论

开 Issue 说明现象与复现步骤即可。涉及密钥、稿件原文的内容请不要贴进工单，见 [SECURITY.md](SECURITY.md)。
