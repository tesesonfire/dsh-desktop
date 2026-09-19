# desktop-tauri 前端（Frontend）

本目录是 Tauri 壳的渲染进程前端：一个极薄的挂载层，全部 UI 与桥接逻辑在
`packages/ui`（`@dsh-desktop/ui`）。Rust 侧（`src-tauri/`）归 Tauri 平台代理维护。

## tauri.conf.json 如何消费这套前端

`src-tauri/tauri.conf.json` 必须按以下方式指向本目录（字段名对齐 Tauri 2）：

```json
{
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true
  }
}
```

- `frontendDist: "../dist"` — `vite.config.ts` 的 `outDir: 'dist'` 输出。生产/打包模式
  由 Tauri 直接嵌入这些静态文件；`base: './'` 保证自定义协议根相对路径可加载。
- `devUrl: "http://localhost:1420"` — 开发模式 WebView 加载 vite dev server；
  `vite.config.ts` 固定 `port: 1420, strictPort: true`，端口被占用时直接失败而不是静默换端口。
- **`app.withGlobalTauri` 必须为 `true`** — `packages/ui` 的桥接检测依赖
  `window.__TAURI__`（`withGlobalTauri` 注入的全局对象，命令走
  `__TAURI__.core.invoke(cmd, args)`，事件走 `__TAURI__.event.listen`）。
  缺少它时 UI 会显示"无法连接桌面壳 / Desktop shell not found"。

## CSP

`index.html` 的 meta 声明了严格 CSP（禁 `unsafe-eval`）。注意 `connect-src`
必须保留 `ipc:` 与 `http://ipc.localhost`：Tauri v2 在 Windows/WebView2 上的
IPC 请求走 `http://ipc.localhost`。若 Rust 侧用 `tauri.conf.json` 的 `security.csp`
覆盖响应头，需保持同一策略。

## 启动流（与 Electron 壳共用契约）

1. 主窗口加载本前端，`packages/ui` 的 `DesktopRoot` 挂载。
2. `getDesktopBridge()` 命中 `window.__TAURI__` → 14 个桥接命令全部经
   `core.invoke` 调用 `src-tauri/src/ipc.rs` 中的同名 `#[tauri::command]`
   （`profile_switch` 参数为 `{ name }`，`open_external` 为 `{ url }`，其余无参）。
3. Host 状态变为 `running` 后，Rust 壳负责把**整个窗口**导航到 ready-line 解析出的
   Host URL（含 `?token=`），前端只显示"界面即将加载"提示，不内嵌 Web UI。
4. 设置窗口复用同一 bundle，以 `#settings`（或 `?view=settings`）打开。
