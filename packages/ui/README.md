# @dsh-desktop/ui

双平台（Tauri 2 + Electron）共享的 React 层：一个组件包 + 双平台桥接检测。
所有桥接类型来自 `@dsh-desktop/protocol`（`DesktopBridge` / `HostStatus` /
`Profile` / `DESKTOP_BRIDGE_METHODS` / `BRIDGE_EVENTS`），本包只消费、不重新定义。

## 组件清单

| 导出 | 说明 |
|---|---|
| `DesktopRoot` | 两框架共用的应用根组件：内部 `getDesktopBridge()`，装状态/日志两个 hook，按 `#settings` / `?view=settings` 路由到 `SettingsView`，否则渲染 `StartupProgress`；检测不到桥接时降级为错误卡片 |
| `StartupProgress` | 三阶段可视化（解析 Profile → 启动 DSH Host → Web carrier 就绪）；`stopped` 显示"启动 Host"按钮，`starting` 转圈，`running` 显示"界面即将加载"，`error` 渲染 `ErrorPanel` + 最近日志 |
| `ErrorPanel` | `{ title, message, hint? }` 纯展示错误卡片 |
| `SettingsView` | 挂载时拉 `profile_list` + `profile_current` + `get_app_version`；点选切换 profile；打开数据目录 / 显示主窗口按钮；错误就地显示 |
| `useHostStatus` | `bridge.host_status()` 初值 + `subscribeState` 订阅（事件优先于迟到的快照） |
| `useBridgeLogs` | 订阅 `dsh:log`，默认保留最近 50 行 |
| `getDesktopBridge` / `subscribeState` / `subscribeLog` | 双平台桥接与事件封装 |
| `styles.css` | 深色主题变量 + 全部 `.dsh-*` 类（无 CSS 框架），经 `@dsh-desktop/ui/styles.css` 导入 |

类型 re-export：`DesktopBridge`、`HostStatus`、`HostState`、`Profile`、
`HostEndpoint`、`BridgeEvents`、`ElectronPreloadApi` 等，应用代码从这里导入即可。

## 双平台桥接检测（getDesktopBridge）

按顺序探测 `window`，首个命中生效，都不存在则抛错：

1. **`window.dshDesktop`**（Electron）— preload 经 contextBridge 注入的扁平对象：
   `{ invoke(method, ...args), onState(cb), onLog(cb) }`。适配为 `DesktopBridge`
   时传给 `invoke` 的 method 名与接口方法名逐字一致（host_start / profile_switch / …）。
   `onState` / `onLog` 若返回函数则视为取消订阅函数，返回 undefined 也能工作。
2. **`window.__TAURI__`**（Tauri 2，需 `app.withGlobalTauri = true`）— 命令走
   `__TAURI__.core.invoke(cmd, args)`：14 个命令全部无参或单参，
   `profile_switch(name)` → `invoke('profile_switch', { name })`，
   `open_external(url)` → `invoke('open_external', { url })`；事件走
   `__TAURI__.event.listen('dsh:state' | 'dsh:log', cb)`。
3. 否则 `getDesktopBridge()` 抛错；`DesktopRoot` 内部捕获并显示"无法连接桌面壳"。

窗口全局类型由本包 `declare global` 唯一声明。Electron preload 作者请 import
`ElectronPreloadApi` 类型来核对自己的注入对象，**不要**再声明一份
`window.dshDesktop`（避免全局合并冲突）。

## 用法

```tsx
import { DesktopRoot } from '@dsh-desktop/ui';
import '@dsh-desktop/ui/styles.css';

createRoot(document.getElementById('root')!).render(<DesktopRoot />);
```

`DesktopRootProps` 另有 `bridge` / `initialStatus` 两个可选注入点（测试/嵌入用），
生产路径完全不传，走 `getDesktopBridge()`。

## 测试

`pnpm --filter @dsh-desktop/ui test` — vitest + `react-dom/server` 的
`renderToString`，纯 Node 环境（无 jsdom、无 DOM 测试库），通过 `vi.stubGlobal`
切换三种 window 形态（dshDesktop / __TAURI__ / 都没有）。

## 契约假设

`running` 状态下组件只显示"界面即将加载"：平台壳（Rust / Electron main）会把
**整个窗口**导航到 Host ready-line URL（含 `?token=`）。本包从不内嵌 Host 的
Web UI，也不自行处理导航。
