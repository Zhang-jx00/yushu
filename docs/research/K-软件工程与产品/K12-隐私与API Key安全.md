# K12-隐私与API Key安全

> 类别：K-软件工程与产品 ｜ 世界构建金字塔层级：工程层 · 软件工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究本地优先桌面写作工具在"数据主权归用户"（docs/01 §6）承诺下的安全边界：本地凭据保护、Electron 运行时加固、外部内容与导入文件的隔离、插件权限模型、数据库加密取舍与卸载净卸载。边界划分：K06 研究插件系统的功能扩展点与权限模型，本领域只定义其安全约束；K13 研究性能，本领域关注安全代价；I09 涉及存量稿件导入，本领域提供导入安全要求。核心问题：API Key 如何在本地既可用又不易被明文窃取；Electron 的攻击面如何收敛；用户导入的 TXT/DOCX/ZIP 如何不成为攻击入口；"卸载即净卸载"如何被验证。

## 2. 核心知识框架

1. **本地凭据加密与 OS 密钥链**。Electron `safeStorage` 是主进程模块，用 OS 密码学保护本地字符串：macOS 走 Keychain、Windows 走 DPAPI、Linux 走 libsecret/kwallet；异步 API（`encryptStringAsync`/`decryptStringAsync`）非阻塞且支持密钥轮换，官方推荐异步、同步 API 未来可能弃用。关键边界：Windows/Linux 语义只防"同机其他用户"，不防"同用户空间其他进程"；Linux 无 secret store 时回退 `basic_text`（`getSelectedStorageBackend()` 可检测），此时加密近似明文。OWASP 桌面安全 Top10 亦将"敏感数据暴露"（DA3）与"密码学误用"（DA4）列为高危。
2. **safeStorage 的真实强度**。其实现是 Chromium `OSCrypt` 的薄封装：对称层为 AES-128-CBC、IV 硬编码为 16 个空格、无认证；Linux fallback 用 PBKDF2-HMAC-SHA1、salt 固定 `"saltysalt"`、迭代 1 次——即"拿到磁盘即可解密"。因此 safeStorage 适合"防止明文落盘/顺手窥探"，不适合作为唯一防线；更高要求需自管密钥或 SQLCipher。
3. **Electron 安全基线**。官方清单要求：只加载安全内容、不启用 `nodeIntegration`、开启 `contextIsolation`、开启 `sandbox`、远程内容用 `setPermissionRequestHandler` 收口、不关闭 `webSecurity`、不启用 `allowRunningInsecureContent`/`experimentalFeatures`、用 `contextBridge` 暴露最小 preload API、避免 `@electron/remote`、使用当前版本 Electron 并评估依赖。IPC 应走通道白名单 + 参数 schema 校验，不暴露任意文件/命令能力。
4. **外部链接与导入文件安全**。攻击面来自"用户把不可信内容交给应用"：外部链接需 `shell.openExternal` 白名单（仅 http/https）并拦截 `will-navigate`/`setWindowOpenHandler`；导入 TXT/DOCX/ZIP 时需防 ① 路径穿越（Zip Slip / CWE-23：条目名含 `../` 写到目标目录外）② zip 炸弹（限制条目数与解压总量）③ 符号链接指向目录外 ④ 可执行/脚本文件落地。OWASP 恶意文件上传测试把 zip 路径与 zip 炸弹列为标准用例。
5. **SQLCipher 的权衡**。SQLCipher 为 SQLite 提供透明 AES-256 全库加密，通过 `PRAGMA key`/`rekey`、`kdf_iter` 等控制（官方 SEE 为商业版对照）。取舍：加密后仍有解密后的内存明文与密钥管理成本，其价值前提是"密钥不与库同处一地"——若密钥也明文落盘则形同虚设；对"Markdown 真源"项目，正文加密意义有限，更适合作为可选增强。
6. **卸载净卸载与隐私最小化**。docs/01 §6 要求"卸载即净卸载：用户目录外不留任何数据"。可验证口径：应用数据集中在单一目录（可支持便携模式）、卸载脚本清理注册表/计划任务/缓存/日志与 OS 密钥链条目、不留遥测。隐私影响评估应明确"收集什么/不收集什么"：默认零遥测、AI 调用仅在用户配置后发生、日志脱敏不含 Key 与正文。

## 3. 可转化为产品规则的关键实践

1. API Key 用 `safeStorage.encryptStringAsync` 加密后落盘 → 凭据文件只存密文 + 元信息；明文永不写入配置/日志。
2. Linux 回退检测 → 启动时 `getSelectedStorageBackend()==='basic_text'` 即提示"当前系统密钥环不可用，凭据仅弱保护"，并允许改用主密码派生密钥。
3. Electron 加固基线 → 所有窗口 `contextIsolation:true, sandbox:true, nodeIntegration:false`；preload 只经 `contextBridge` 暴露白名单 API。
4. CSP 与导航收口 → 设严格 CSP；拦截 `will-navigate`/`setWindowOpenHandler`，`openExternal` 仅放行 http/https 白名单。
5. IPC 白名单 + 参数校验 → 通道名枚举化，入参用 JSON Schema 校验，高危能力（写任意路径、执行命令）不出现在 IPC。
6. 导入安全网关 → 解包前：拒绝含 `..` 的条目与符号链接、限制条目数/解压总量/单文件大小、仅允许文本型扩展名落地。
7. 插件权限声明式 → 插件 manifest 声明权限（fs 范围、网络域、可用 IPC），运行时按最小权限授予，危险 API 隔离在独立进程（与 K06 联动）。
8. SQLCipher 可选开关 → 默认不加密索引库；开启时从 safeStorage 保护的密钥派生，禁止密钥与库同目录明文存放。
9. 卸载净卸载清单 → 安装器/卸载器与便携模式共用一份"数据位置清单"，卸载后逐项校验为空。
10. 隐私影响评估 → 内置"数据地图"页面：列出本地数据位置、外发请求目标、日志范围，默认零遥测。

## 4. 信息来源

1. [官方文档] Electron Security — https://www.electronjs.org/docs/latest/tutorial/security — 官方安全清单：contextIsolation/sandbox/nodeIntegration/webSecurity/setPermissionRequestHandler 与版本/依赖要求。
2. [官方文档] safeStorage — https://www.electronjs.org/docs/latest/api/safe-storage — 平台密钥源（Keychain/DPAPI/libsecret）、异步 API 与 `basic_text` 回退检测。
3. [官方文档] Electron Context Isolation — https://www.electronjs.org/docs/latest/tutorial/context-isolation — preload + contextBridge 隔离边界与最小暴露原则。
4. [官方文档] OWASP Desktop App Security Top 10 — https://owasp.org/www-project-desktop-app-security-top-10/ — DA3 敏感数据暴露 / DA4 密码学误用 / DA5 授权 / DA6 配置错误 / DA9 已知漏洞组件。
5. [技术文章] Cracking Open the Electron safeStorage Black Box — https://chenguangliang.com/en/posts/blog169_electron-credential-storage-security/ — safeStorage = OSCrypt 薄封装：AES-128-CBC、硬编码 IV、Linux `saltysalt`/迭代 1 的弱回退。
6. [规范标准] CWE-23: Relative Path Traversal (Zip Slip) — https://cwe.mitre.org/data/definitions/23.html — 归档条目名含 `../` 导致越界写入的成因、后果与缓解。
7. [技术文章] Zip Slip: Archive Extraction Path Traversal — https://appsecbrief.com/articles/zip-slip-archive-extraction-path-traversal-java-python-nodejs-go/ — 安全解压实现（校验落点、拒绝 `..`、限制条目数/大小）。
8. [官方文档] SQLCipher API — https://www.zetetic.net/sqlcipher/sqlcipher-api/ — PRAGMA key/rekey/kdf_iter/cipher_migrate 与透明全库加密能力。
9. [技术文章] OWASP Testing: Test Upload of Malicious Files — https://wiki.owasp.org/index.php/Test_Upload_of_Malicious_Files_(OTG-BUSLOGIC-016) — 恶意文件上传测试用例：zip 路径与 zip 炸弹。

## 5. 对御书设计的启示

**数据结构建议：凭据存储结构（本地加密，永不明文）**

```yaml
# .yushu/secrets.enc.json —— 密文由 safeStorage 保护，明文仅在内存
version: 1
backend: os_keychain          # os_keychain | basic_text | master_password
keys:
  - id: openai-main
    provider: openai
    label: "OpenAI 主账号"
    ciphertext: "base64:..."   # safeStorage.encryptStringAsync(apiKey)
    created_at: 2026-09-29T10:00:00+08:00
    last_used: null
    verify: {ok: true, at: "..."}   # 启动时解密 + 最小探测结果
  - id: local-ollama
    provider: ollama
    label: "本地 Ollama"
    ciphertext: null            # 本地模型无需密钥
```

```yaml
# 插件 manifest 的权限声明（与 K06 联动）
id: genre-pack.guixu
permissions:
  fs:  {read: ["packs/**"], write: ["packs/**"]}    # 仅包内读写
  net: {domains: ["api.example.com"], methods: [GET]}
  ipc: ["settings.get", "entity.create"]            # 白名单通道
  exec: none                                        # 禁止执行外部命令
```

**导入安全网关默认参数**
```yaml
import_guard:
  reject_path_traversal: true        # 含 ".." 或绝对路径的归档条目
  follow_symlink: false
  max_entries: 5000
  max_uncompressed_bytes: 209715200  # 200 MiB
  max_single_file_bytes: 20971520    # 20 MiB
  allowed_ext: [".txt", ".md", ".docx", ".json", ".yaml"]
```

**校验规则建议**
- `key-plaintext-detected`：配置/日志/项目文件中出现疑似明文 Key（正则 `sk-`、`Bearer `、32+ 随机串） → error，阻断并提示改用凭据库。
- `electron-insecure-window`：任一 `BrowserWindow` 的 `contextIsolation/sandbox/nodeIntegration` 非安全值 → error（构建期静态检查）。
- `csp-missing`：渲染窗口未配置 CSP 或生产环境含 `unsafe-eval` → error。
- `ipc-unwhitelisted-channel`：IPC 注册通道不在枚举白名单内 → error。
- `import-traversal-entry`：归档条目名解析后越出目标目录 → error，拒绝该归档。
- `import-zip-bomb`：解压总量或条目数超限 → error，中止并提示。
- `plugin-permission-escalation`：插件调用未声明权限的 API → error，记录并阻断（与 K06 联动）。
- `uninstall-residue`：卸载脚本运行后数据位置清单仍有残留 → error（发布前验证）。

**功能建议**
- 凭据管理页：只显示"已配置/未配置 + 最后使用时间"，查看明文须二次验证，支持一键轮换与失效测试。
- 安全状态自检：启动时给出"窗口隔离 / CSP / IPC / 密钥后端 / 明文扫描"五项绿灯（与 K13 性能自检共用面板）。
- 导入预检对话框：解压前展示"将解压 N 个文件 / 最大单文件 / 可疑条目"，可疑项默认不落地。
- 数据地图：列出本地数据目录、日志、外发域名与凭据位置，支撑"零遥测"承诺。

**AI 提示词建议**
- 「导入分章纠错」：对导入文本做分章与清洗建议，但输出不含任何密钥/路径信息（避免把本地结构写进提示词与日志）。
- 「隐私回执」：把本次 AI 调用的外发字段（系统提示是否含设定卡、是否含正文片段）整理成可读回执，供用户审计（与 J13 联动）。

## 6. 领域内子主题备忘（可选）

- 主密码方案（不再依赖 OS 密钥链）：Argon2/PBKDF2 派生 + 启动解锁流程。
- 应用签名与自动更新（Windows Authenticode / macOS 公证）对 safeStorage 稳定性的影响。
- 崩溃日志与遥测的脱敏梯度（默认关闭、可开、字段级最小化）。
- 便携模式（U 盘运行）与"用户目录外不留痕"的兼容性。
- 第三方插件沙箱化运行（独立 utilityProcess + 资源限额，与 K13 联动）。