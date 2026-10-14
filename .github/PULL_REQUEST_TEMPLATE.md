## 关联

Fixes #（没有对应 issue 请先开一个；纯文档改动可写「无」）

## 改了什么（一到三句）

<!-- 写「为什么」而不只是「改了什么」。例：
     `git:rollback` 之前走只读包装器，回滚后一致性结论仍指向回滚前内容——这里改成写通道。 -->

## 验证（必填，跑不过别提 PR）

| 命令 | 结果（抄真实输出里的数字） |
|---|---|
| `pnpm test` | 例：`Tests 962 passed (962)` / `Test Files 95 passed (95)` |
| `pnpm typecheck` | 例：`TC=0`（9 包 + 2 应用） |
| `pnpm --filter @yushu/desktop e2e` | 例：`E2E=0`，关键探针字段：`{...}` |
| `pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=<空目录>"` | 例：`ok=53 fail=0 抖动=0 证据缺失=0`，目录 `vNNN` |

只改引擎包、没碰桌面端时，后两项可以标「不适用（未触调用点）」——**但不要标「通过」**。

## 新写的断言能红吗（改了产品行为就必答）

- [ ] 我把这条断言对应的实现改坏跑过，它**红了并且点名**了问题；已还原
- [ ] 我复看过变异红的**原因**是产品变坏，不是路径/ENOENT/语法错这类环境问题
- 变异结果：（例：去掉封顶点名 → 1 红 / 换成 `localeCompare` → 1 红 / 未杀到：<如实写哪条、为什么>）

## 红线自检

- [ ] 真源只有 Markdown/YAML；新写入的派生物落在 `.yushu/` 或 `exports/`，且不入 Git
- [ ] AI 产物仍是候选，采纳是显式动作
- [ ] 没有明文密钥落盘或进日志；`.bak`/备份类文件也走脱敏
- [ ] 新增 IPC 通道四处同步（shared / main 的 wrap-vs-wrapWrite / preload 白名单 / renderer api）
- [ ] 排序走码点序，没有 `localeCompare`；同输入同输出
- [ ] 界面动效符合 DASHBOARD 上限（无 `infinite`、入场 ≤380ms、位移 ≤6px、缩放 ≥0.98；`prefers-reduced-motion` 关 transition 与 animation）

## 行为准则

- [ ] 我已阅读并同意遵守 [行为准则](https://github.com/Zhang-jx00/yushu/blob/main/CODE_OF_CONDUCT.md)；评审与维护按其中的四级阶梯执行

## 文档与账本

- [ ] 对应 `docs/04` 勾选与注记已当场更新（勾一个 `[x]` 必须同时写证据：测试名 / 探针字段 / 预演步号）
- [ ] `docs/06` §八 补了本轮记录
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 加了条目
- [ ] 拿不到的外部条件（真实 provider / 真实语料 / 真人试跑）**没有被声称达成**

## 截图（改了界面必附）

<!-- 预演截图落在 docs/assets/m1-preview/；这里贴与本 PR 直接相关的那一两张，并说明拍的是被断言的那一段 -->
