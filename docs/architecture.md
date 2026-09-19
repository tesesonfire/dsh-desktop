# 架构 / Architecture

## 1. 总览

DSH Desktop 是 **薄宿主**：官方 DSH runtime 原样运行（不 fork、不修改、不打补丁），平台壳只实现

1. **spawnHost** — spawn `dsh --profile <p> --patch <yml> --port 0 --no-open`（DSH_BIN 解析契约见下）
2. **killHost** — 进程树终止（Windows `taskkill /T /F` + Tauri Job Object；Unix 进程组信号）
3. **attachWebView** — 把 WebView/BrowserWindow 导航到 ready-line URL

其余能力全部经由 desktop-shell 插件的 `ctx.desktopRuntime`（Cordis 服务）回到平台壳。

## 2. 官方事实标准（ready-line 是唯一就绪契约）

来自 `deepseek-ai/deepseek-harness`（pin 0.1.6-alpha.2 @ ddefc45f）：

- `dsh web` ≡ `dsh --profile web`；`--port 0` → OS 随机端口；`--no-open` 抑制浏览器。
- ready-line（打印点 `packages/bundle/web-app/src/index.ts:271`，e2e 锁 `apps/cli/tests/built-bin.e2e.ts:787`）：

  ```
  dsh web: http://127.0.0.1:<port>/?token=<base64url>
  ```

  `?token=` 是每进程 32 字节凭证，**必须原样交给 WebView**（换取 30 天 HMAC cookie）。
- 带 LAN 时追加 ` (LAN: http://<ip>:<port>/?token=…)`（信息性，解析器剥离）。
- SIGTERM → 退出码 0；SIGINT → 130。
- 解析实现集中在 `packages/protocol/src/readyline.ts`（TS）与 `apps/desktop-tauri/src-tauri/src/sidecar.rs::parse_ready_line`（Rust，逐用例对齐 protocol 测试）。

## 3. 控制通道（唯一跨界通道）

平台壳在 spawn 之前启动 loopback HTTP server（随机端口 + 随机 32B base64url token），通过环境变量注入：

```
DSH_DESKTOP_CONTROL_URL=http://127.0.0.1:<port>
DSH_DESKTOP_CONTROL_TOKEN=<token>
```

`packages/desktop-shell`（运行在 DSH Host 进程内）读取这两个变量并提供 `ctx.desktopRuntime`；每个方法都是一次带 `x-dsh-desktop-control` 头的 HTTP 调用：

| 端点 | 方向 | 语义 |
|---|---|---|
| `POST /v0/hello` | 插件→壳 | 就绪宣告 `{pid, webPort, profile}` |
| `GET /v0/hello` | 插件→壳 | 当前 Profile |
| `POST /v0/webview/attach {url}` | 插件→壳 | 同源校验后导航 WebView（非同源 403） |
| `POST /v0/host/stop` | 插件→壳 | killHost |
| `POST /v0/host/restart` | 插件→壳 | 重启 Host，返回 `{port,url}` |
| `GET /v0/events` | 插件→壳 | 长轮询（≤25s）→ `{events:[{type:"window-close"}…]}` |

无 env（用户在终端手跑 `dsh web`）时插件降级为响亮失败的桩服务。

## 4. 启动生命周期（对齐官方阶段枚举）

```
shell-environment → control-server → profile-resolution → host-spawn
  → renderer-startup → health-commit
```

- **profile-resolution**：扫 `$DSH_HOME/profiles/*/package.json`（`dsh.profile.bundles`）；空目录时按官方 initProfile 模板自举默认 profile（`dsh-desktop-electron` / `dsh-desktop-tauri`，bundles = dsh-base + dsh-web-app）。CLI 拒绝 `--profile desktop`（官方 Electron 专属），故本项目不复用该名字。
- **health-commit**：sidecar running → 写 last-known-good（userData/desktop-state.json，原子 tmp+rename）。
- 任何阶段失败进入状态机（`HostStatus.state='error'`），壳保持存活让 UI 呈现；失败路由不崩溃。

## 5. 安全围栏

| 层 | Electron | Tauri |
|---|---|---|
| 渲染隔离 | contextIsolation/sandbox/webSecurity，partition `persist:dsh-desktop-renderer` | 严格 CSP + 最小 capability 白名单 |
| 导航 | `will-frame-navigate`/`will-redirect` origin 相等（非前缀） | `WebviewWindowBuilder::on_navigation` 同规则 |
| 新窗口 | `setWindowOpenHandler` 一律 deny；http/https/mailto → `shell.openExternal` | Tauri 默认拒绝新 webview；opener 打开外链 |
| 控制通道 | loopback + token（timingSafeEqual） | 同左（tiny_http） |
| 日志 | `token=…` 脱敏；10MB 轮转×5、7 天清理 | tracing 文件 appender |

## 6. 契约防漂移（机器强制）

`pnpm audit:contract`（`scripts/audit-contract.mjs`）审计 4 个点：

1. Electron `ipcMain.handle('bridge:<method>')` 字面量通道集合 == protocol canonical
2. Tauri `generate_handler![ipc::<method>]` == canonical
3. Tauri `#[tauri::command] fn <method>` == canonical
4. 共享前端 `invoke('<method>')` 调用点 == canonical

另有类型级双保险：protocol 的 `DESKTOP_BRIDGE_METHODS` 用 `satisfies` + 两个 `Exclude<…> extends never` 断言与接口键完全相等；两平台实现 `satisfies DesktopBridge`。

## 7. 与官方仓库的关系

- `.refs/`（gitignored）保存三个参考仓库的浅克隆，仅作只读侦察。
- 官方 desktop 的 `dsh.bundle.patch` / `dsh.client` / generation 模式被借鉴；本项目 host 进程 = 外部 `dsh` CLI 子进程（官方 Electron 是 `utilityProcess.fork` 内嵌 runner），差异记录于 HANDOFF.md。
