# DSH Desktop 双框架并发开发 — PLAN.md

> 时间盒：2026-09-20 01:40 → 09:00 +08:00。本文档是第一阶段（只读侦察）的产出，
> 也是后续所有实现的事实依据。侦察对象：官方 `deepseek-ai/deepseek-harness`、
> `tesesonfire/dsh-tauri-desktop`、`anywhere-labs/dsh-desktop`（浅克隆于 `.refs/`，已 ignore）。

## 0. 版本 Pin（升级 = 显式改这里，禁止 pnpm update 隐式升级）

| 组件 | Pin | 证据 |
|---|---|---|
| DeepSeek Harness (DSH) | `@deepseek-ai/dsh` **0.1.6-alpha.2** @ commit `ddefc45f` | `.refs/deepseek-harness/package.json`、git HEAD |
| Cordis | `@deepseek-ai/cordis` **4.0.2**（DSH vendored fork） | `vendor/cordis/package.json` |
| Tauri | `tauri 2.x`（Cargo.lock 实锁 2.11.x 系列） | 参考库 Cargo.lock |
| Electron | `electron ^3x`（安装时锁定 exact） | 官方 desktop 用 43.3.0 / next 44.0.0，本项目用 npm 最新 stable 3x |
| Node | `>=20`（本机 24.21.0） | — |
| pnpm | `10.15.0`（packageManager 字段） | 本机已装 |

## 1. 官方事实标准（来自 deepseek-harness 源码，非猜测）

### 1.1 CLI 与 ready-line（sidecar 解析的唯一契约）
- `dsh web` ≡ `dsh --profile web`（launcher 把第一个非 flag、非 `plugin` 的词展开为 `--profile`）。`apps/cli/src/args.ts:186-189`
- 默认监听 `http://127.0.0.1:3080`；`--port 0` → OS 选空闲端口。`packages/bundle/web-app/cordis.patch.yml:134-142`
- `--no-open` 禁止自动开浏览器（由 web bundle 的 startup 插件解析）。`packages/bundle/web-app/src/startup.ts:46-61`
- flag 顺序：launcher flag（`--profile`、`--patch`、`--dump-config`）在前；第一个不被 launcher 认识的 token 之后全部交给内层 app。`args.ts:5-11`
- **ready-line 精确格式**（打印点 `packages/bundle/web-app/src/index.ts:271`，官方 e2e 锁定正则 `apps/cli/tests/built-bin.e2e.ts:787`）：

  ```
  dsh web: http://127.0.0.1:<port>/?token=<base64url>
  ```

  `?token=` 是每进程 32 字节随机凭证，**必须原样交给 WebView，不得剥掉**（换取 30 天 HMAC cookie）。带 LAN 时追加 ` (LAN: http://<ip>:<port>/?token=...)`。`--no-open` 下无第二行。
- 就绪语义：该行只在 Loader 树 settle + required-entry 审计通过后打印一次；SIGTERM → 退出码 0，SIGINT → 130。`apps/cli/src/profile-boot.ts:287-291`
- `--host 0.0.0.0` 被 web-startup 显式拒绝（LAN 不支持）→ 桌面壳永不传它。`startup.ts:74-76`
- **`--profile desktop` 被 CLI 拒绝**（官方 Electron 专属，`args.ts:73-77`）→ 本项目 profile 名用 `dsh-desktop-tauri` / `dsh-desktop-electron`。

### 1.2 Cordis 插件机制（修正目标文本的三处偏差）
- 包名 `@deepseek-ai/cordis`（vendored fork v4.0.2），插件形态：`name` / `Config`(Standard Schema) / `inject` / `apply(ctx, config)`。`vendor/cordis/src/registry.ts:92-133`
- **注册服务用 `ctx.provide(name, value)`**（返回 disposer）；`ctx.set` 仅提供者 fiber 可用。目标文本中的 `ctx.set('desktopRuntime', ...)` 落地为 `ctx.provide('desktopRuntime', ...)`。`vendor/cordis/src/reflect.ts:15-46`
- **无通用 `ctx.on('ready')` 事件**（vendored cordis 中不存在）→ 目标文本中 `ctx.on('ready', ...)` 落地为：插件 `apply()` 内直接 await 依赖服务（`inject: ['webServer']` 保证 webServer 就绪后才挂载），然后发起控制通道注册。
- 服务消失会卸载依赖插件、恢复后重启（inject 不是一次性检查）。`docs/cordis-tutorial/03-services.md:76`

### 1.3 Profile / Bundle / Patch
- Profile = `$DSH_HOME/profiles/<name>/`，manifest `package.json` 声明 `dsh.profile.bundles` 有序列表；用户层补丁 `cordis.patch.yml`。`packages/boot/app-boot/src/profile.ts:5-13`
- Bundle = npm 包 manifest `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。`packages/util/package-manifest/src/types.ts:28-77`
- Patch 语义：按 `id` 定位行、**整行 config 替换（不深合并）**、`insert` 插入行、后层覆盖前层。`vendor/include/src/index.ts:44-141`
- 层序：bundle 层（按 `dsh.profile.bundles` 顺序）→ profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。`apps/cli/src/profile-boot.ts:1-5,186-191`
- **本项目注入方式**：不修改用户 cordis.patch.yml；通过 `--patch <our cordis.patch.yml>` overlay 把 desktop-shell 插件行 insert 进组合树。
- `dsh plugin --profile <name> add <pkg>` = 转发给 profile 目录内 pnpm。`apps/cli/src/plugin.ts:12-25`

### 1.4 Web 客户端与 HTTP 面
- Host 提供单 HTTP 服务：`/api` 前缀 = 认证 RPC/Fetch 桥（HMAC cookie；Host/Origin 围栏只认 loopback + trustedHosts）；`/plugins/??...` combo 脚本（`window.__DSH_BOOT__` 图）；fallback seat 服务 Web UI dist。无独立 WebSocket 路由（默认组合）。认证失败 401 "dsh web authentication required; reopen the URL printed by dsh web."
- `dsh.client` manifest：`{ platform, inject?, immediately?, external? }`；`WebBootGraph { rev, entries, batches }` 注入为 `window.__DSH_BOOT__`。
- 桌面端有官方 IPC 门 `window.dshDesktopBoot.ready()/failed()`（`apps/web/src/main.ts:4-35`）——本项目 WebView 直接加载 `?token=` URL 走浏览器认证，不依赖该门。

## 2. 参考仓库差异修正（诚实记录）

- `tesesonfire/dsh-tauri-desktop` **实际结构与目标文本描述不符**：单一 Rust crate（commands/services/models/utils 四层），无 contracts/ 五份契约、无多 crate workspace、无 single-instance 插件、CSP 为 null。借鉴其有效模式：CREATE_NO_WINDOW、kill_on_drop、bind 预检、指数退避健康检查（90s deadline）、splash→app_ready、generation 计数防旧 watchdog、CI 三 OS 矩阵。其缺口（无进程树 kill、无契约审计）正是本项目要补的。
- `anywhere-labs/dsh-desktop`：Electron 43.3.0 薄宿主，Host 在 `utilityProcess.fork` 子进程；`DesktopStartupGeneration`（幂等 release、bindHost 唯一性断言）+ `ElectronShellGeneration`（集中注销监听器）；origin 相等导航围栏 + setWindowOpenHandler 全 deny + openExternal；renderer 专属访问头；阶段枚举 `electron-ready→…→health-commit`；last-known-good checkpoint。全面借鉴。
- 官方 Electron 桌面默认端口 19387（非 3080）；本项目 sidecar 用 `--port 0` 随机端口，从 ready-line 解析。

## 3. 架构：控制通道（解决"插件在 Host 内、原语在平台层"的桥接）

```
┌────────────────────────── 平台壳（Tauri Rust / Electron main）──────────────────────────┐
│  Launcher：单实例锁 → 解析 profile → 起 ControlServer(127.0.0.1:随机) → spawn dsh       │
│  env: DSH_DESKTOP_CONTROL_URL=http://127.0.0.1:<ctrlPort>                              │
│  stdout 泵：解析 ready-line `dsh web: http://127.0.0.1:<port>/?token=<tok>`             │
│  三原语（ControlServer 承载）：/v0/host/{stop,restart} /v0/webview/attach /v0/events    │
│  DesktopBridge IPC（renderer ↔ 壳）：host_* / window_* / profile_* / open_* / version   │
│  退出兜底：Tauri Drop + RunEvent::Exit / Electron before-quit → 进程树 kill              │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ HTTP loopback（唯一跨界通道）
┌──────────────────────────────────────┴───────────────────────────────────────────────┐
│  DSH Host（dsh CLI 进程，官方 runtime 原样运行，不改一行）                              │
│  组合树 = dsh-base + dsh-web-app + [--patch: desktop-shell 插件行]                     │
│  packages/desktop-shell（Cordis 插件）：                                              │
│    provide('desktopRuntime', httpClient→ControlServer)                                │
│    apply(): POST /v0/hello{pid,webPort} → 长轮询 /v0/events                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- 平台层只实现三原语：spawnHost（含重启）/ killHost（进程树）/ attachWebView；其余能力（profile 列表、打开数据目录、设置窗口）是 DesktopBridge IPC 的薄薄封装，业务逻辑零硬编码。
- loopback-only：WebView 只允许留在 ready-line 解析出的精确 origin（origin 相等判定，非前缀）；外链 http/https/mailto → 系统浏览器；其余导航一律拒绝。
- 无官方 DSH 时可运行：`packages/testkit` 提供 `mock-dsh`（用真 `@deepseek-ai/cordis` 加载真 desktop-shell 插件 + 假 webServer，输出与官方逐字一致的 ready-line）——smoke/e2e 全链路不依赖 300MB 上游安装；`DSH_BIN` 指向真 `dsh` 时同一条代码路径不变。

## 4. 共享契约（两框架逐字一致，机器强制）

`packages/protocol/src/bridge.ts` 定义 `DesktopBridge`（16 方法）+ `HostStatus` + `Profile` + 控制通道端点常量。
**防漂移机制**（比参考库更进一步）：
1. `pnpm audit:contract` — Vitest 静态扫描 Electron `ipcMain.handle(` 注册表、Tauri `generate_handler!` 清单与 `#[tauri::command]` 函数集、渲染端调用点，与 protocol 的 canonical 列表 diff，不一致即 fail（无需 cargo 即可审计 Rust 源）。
2. 两平台实现层 `satisfies DesktopBridge` 类型断言。
3. 事件通道常量（`dsh:state` / `dsh:log`）双端引用同一常量。

## 5. 环境能力矩阵（本机实测 2026-09-20 01:50）

| 能力 | 状态 | 影响 |
|---|---|---|
| Node 24.21 / npm 11.19 | ✅ | — |
| pnpm 10.15 | ✅（npm -g 安装） | workspace 可跑 |
| npm registry / GitHub | ✅ 200 | Electron 可装可跑 |
| crates.io | curl 403（CF 拦 curl，cargo 未验证） | Tauri 依赖解析未验证 |
| Rust / cargo | ❌ 未安装 | Tauri 无法本地编译 |
| MSVC 链接器 | ❌ 无 Visual Studio（link.exe 命中为 Git 自带） | Tauri 链接不可能，不擅自装 GB 级 VS |
| WebView2 运行时 | ✅ 153.0.4234.32 | 用户侧 Tauri 构建的前提已具备 |

**结论**：Electron = 本机完整验证路径（build + test + clean-boot smoke）；Tauri = 完整代码 + 契约审计 + CI 矩阵验证（本地只做 Rust 源级静态审计），HANDOFF.md 如实标注"未编译"。

## 6. 50 槽位分配表

调度规则：S 组先行冻结契约 → T/E 并行 → V 收口。04:10 检查点：Electron 为主验证路径；Tauri 若主干未通降级为"代码完整 + CI 验证"（事实上因本机无 Rust 工具链已按此执行）。

### 共享层 S1–S10
| 槽位 | 任务 | 产出 |
|---|---|---|
| S1 | protocol 包 | packages/protocol：bridge.ts（DesktopBridge/HostStatus/Profile）、control.ts（控制通道端点）、events.ts；契约审计测试 |
| S2 | core 包 | packages/core：SessionService/AgentRuntime 骨架（不自研 runtime，薄封装上游会话模型） |
| S3 | ui 包 | packages/ui：StartupProgress、ErrorPanel、TrayMenu 描述、共享主题 |
| S4 | llm-sdk 包 | 多 provider 类型封装骨架（对齐官方 Message/ToolSchema 类型） |
| S5 | mcp-client 包 | stdio + SSE transport 骨架 |
| S6 | session-store 包 | SQLite schema + 迁移骨架（drizzle/kysely-free，纯 SQL） |
| S7 | desktop-shell 插件 | packages/desktop-shell：provide desktopRuntime、控制通道客户端、cordis.patch.yml |
| S8 | 测试工具 | packages/testkit：mock-dsh、fixture、契约 fixture |
| S9 | 脚本 | scripts/smoke-clean-boot.mjs、scripts/check-orphan-processes.mjs、audit:contract |
| S10 | 文档骨架 | README.md（中英）、docs/architecture.md、docs/plugin-contract.md、HANDOFF.md |

### Tauri 平台层 T1–T18
| 槽位 | 任务 | 产出文件（apps/desktop-tauri/src-tauri/） |
|---|---|---|
| T1 | 脚手架 | Cargo.toml、tauri.conf.json、build.rs、capabilities/default.json |
| T2 | sidecar | src/sidecar.rs：spawn `dsh --profile <p> --patch <yml> --port 0 --no-open`、ready-line 解析（正则对齐官方 e2e） |
| T3 | 进程树 kill | src/proc_kill.rs：Windows `taskkill /T /F`、Unix setsid 进程组 SIGTERM→SIGKILL、Drop 兜底 |
| T4 | 窗口管理 | src/shell.rs：ShellGeneration（幂等 release）、窗口状态持久化 |
| T5 | 托盘 | src/tray.rs：显示/隐藏、打开数据目录、重启 Host、退出 |
| T6 | 单实例 | tauri-plugin-single-instance 接线 |
| T7 | IPC 命令 | src/ipc.rs：DesktopBridge 全部 16 命令 + satisfies 审计 |
| T8 | 导航策略 | src/nav_policy.rs：on_navigation origin 相等、外链 opener |
| T9 | CSP | tauri.conf.json 严格 CSP（无 unsafe-eval） |
| T10 | Capability | 最小权限白名单 core:default + window/tray 必需项 |
| T11 | 启动进度页 | apps/desktop-tauri/src/：spawn→probe→ready 三阶段（复用 packages/ui） |
| T12 | 设置窗口 | src/settings_window.rs |
| T13 | 日志 | tracing + 文件轮转（tracing-appender） |
| T14 | 自动更新 | tauri-plugin-updater 接线（GitHub Releases；本地不可验证，标 TODO） |
| T15 | 打包脚本 | tauri.conf bundle targets：dmg/msi/nsis/appimage/deb |
| T16 | 单元测试 | ready-line 解析、proc_kill、nav_policy 的 cargo test |
| T17 | 集成测试 | src-tauri/tests/lifecycle.rs（门控 DSH_E2E=1） |
| T18 | 文档 | apps/desktop-tauri/README.md |

### Electron 平台层 E1–E18
| 槽位 | 任务 | 产出文件（apps/desktop-electron/） |
|---|---|---|
| E1 | 脚手架 | package.json、vite 渲染构建、electron-builder.yml |
| E2 | sidecar | src/main/sidecar.ts：child_process spawn + ready-line 解析（与 Tauri 同一正则常量，源自 protocol） |
| E3 | 进程树 kill | src/main/proc-kill.ts：Windows taskkill /T /F、POSIX process.kill(-pid)、before-quit 兜底 |
| E4 | BrowserWindow | src/main/shell.ts：ShellGeneration、位置/大小记忆 |
| E5 | Tray | src/main/tray.ts：与 Tauri 同构菜单 |
| E6 | 单实例 | app.requestSingleInstanceLock() |
| E7 | IPC handler | src/main/ipc.ts：ipcMain.handle 全 16 命令 |
| E8 | 导航策略 | will-frame-navigate/will-redirect origin 相等 + setWindowOpenHandler deny + openExternal |
| E9 | CSP | 本地页 meta CSP + session.webRequest 响应头注入 |
| E10 | contextIsolation | preload contextBridge 最小 API（sandbox:true、nodeIntegration:false） |
| E11 | 启动进度页 | 复用 packages/ui StartupProgress |
| E12 | 设置窗口 | src/main/settings.ts 独立 BrowserWindow |
| E13 | 日志 | 自研文件 sink（轮转 10MB/200MB/7天，对齐官方） |
| E14 | 自动更新 | electron-updater 接线（标 TODO：无发布源不可验证） |
| E15 | 打包脚本 | electron-builder：dmg/nsis/appimage |
| E16 | 单元测试 | Vitest：ready-line 解析、proc-kill、launcher |
| E17 | 集成测试 | clean-boot smoke（真进程真窗口） |
| E18 | 文档 | apps/desktop-electron/README.md |

### 集成验证 V1–V4
| 槽位 | 任务 |
|---|---|
| V1 | scripts/smoke-clean-boot.mjs 双框架共用（--framework tauri/electron） |
| V2 | e2e happy path：启动→ready-line→WebView 加载→桌面桥命令→退出 |
| V3 | scripts/check-orphan-processes.mjs：退出后扫描 dsh/node sidecar 残留 |
| V4 | 文档一致性：两框架 README/HANDOFF 差异仅限平台事实 |

## 7. 风险清单

| 风险 | 缓解 |
|---|---|
| 无 Rust 工具链 → Tauri 不可编译验证 | 代码按参考库 Cargo.lock 版本 pin；契约审计无需 cargo；CI 矩阵（.github/workflows/ci.yml）跑 cargo clippy/test/build；HANDOFF 如实标注 |
| 上游 DSH 未安装 → 真机跑不通完整 Host | mock-dsh 走真 cordis + 真插件，验证 shell 全链路；真 DSH 仅换 DSH_BIN |
| ready-line 协议随上游变化 | 解析正则集中 protocol 单点 + mock/单测锁定；升级流程文档化（重验 e2e 正则） |
| 双框架行为漂移 | audit:contract 机器强制 + satisfies 类型 + 同一 smoke 脚本 |
| 进程残留 | taskkill /T 与进程组双实现 + before-quit/Drop 双兜底 + V3 扫描 |
| ctx.set/on('ready') 目标文本与上游事实不符 | 已修正为 provide/apply-await（见 §1.2），plugin-contract.md 记录差异 |

## 8. 里程碑节奏（剩余时间按实际钟表推进）

1. ~~01:40–02:10 侦察 + PLAN.md~~（本文件）
2. 02:10–03:10 共享层：protocol/desktop-shell/testkit/core/ui 骨架 + 契约审计
3. 03:10–04:10 两平台 MVP 主干（Electron 本机跑通 clean-boot；Tauri 代码完成）
4. 04:10–05:40 测试 + 残留检查 + 打包脚本 + CI
5. 05:40–07:10 文档 + profile 管理 + 兼容性标注
6. 07:10–08:40 blocker 修复 + feature freeze + release notes
7. 08:40–08:55 HANDOFF.md 终稿 + 完成审计
