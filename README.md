# DSH Desktop

**非官方** DeepSeek Harness（DSH）桌面壳 —— 双框架（Tauri 2 与 Electron）共享同一契约层，行为等价。MIT 协议，与 DeepSeek 无隶属关系。

**Unofficial** desktop shell for DeepSeek Harness (DSH) — two desktop frameworks (Tauri 2 and Electron) sharing one contract layer with equivalent behavior. MIT licensed; not affiliated with DeepSeek.

> ⚠️ **DSH 处于 developer preview**：上游 README 明确声明 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"。本项目 pin `@deepseek-ai/dsh@0.1.5-rc.2`（npm 最新发布；上游仓库 HEAD 为 0.1.6-alpha.2 @ `ddefc45f`）。升级 = 显式修改 PLAN.md §0 并重验 ready-line 契约，**禁止 pnpm update 隐式升级**。

## 架构一览 / Architecture at a glance

```
┌────────────────── 平台壳（Tauri Rust / Electron main）──────────────────┐
│ 单实例锁 → ControlServer(127.0.0.1:随机) → spawn dsh → ready-line 解析 │
│ 三原语：spawnHost / killHost(进程树) / attachWebView                    │
│ DesktopBridge IPC：14 个方法，两框架逐字一致（audit:contract 机器强制） │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP loopback + token（唯一跨界通道）
┌───────────────────────────────┴───────────────────────────────────────┐
│ DSH Host（官方 runtime 原样运行，不改一行）                             │
│ packages/desktop-shell（Cordis 插件）→ ctx.provide('desktopRuntime')   │
└───────────────────────────────────────────────────────────────────────┘
```

- **不 fork / 不修改 / 不补丁官方 DSH runtime**。平台壳只做 shell、进程生命周期、窗口、托盘、端口分配、恢复、更新与插件装配。
- **一切皆插件**：desktop-shell 通过 `--patch` overlay（`packages/desktop-shell/cordis.patch.yml`）注入 DSH 组合树，不改用户 cordis.patch.yml。
- **loopback-only**：WebView 只允许停留在 ready-line 解析出的精确 origin（origin 相等判定）；外部 http/https/mailto 一律系统浏览器。
- **零孤儿进程**：Windows `taskkill /T /F`（Tauri 另有 Job Object KILL_ON_JOB_CLOSE），Unix 进程组 SIGTERM→SIGKILL，before-quit / Drop 双重兜底，`scripts/check-orphan-processes.mjs` 验收。

## 快速开始 / Quick start

```bash
pnpm i                # pnpm >= 10, node >= 20
pnpm build            # 所有包（protocol → desktop-shell → ui → 两平台）
pnpm test             # 全部 9 组 vitest 测试
pnpm audit:contract   # DesktopBridge 契约审计（4 个审计点）
pnpm smoke:clean-boot:electron   # 真窗口全链路（DSH_SMOKE=1 + mock-dsh）
pnpm smoke:clean-boot:tauri      # 有 Rust+MSVC 的机器上真正跑，否则优雅 SKIP
pnpm dev:electron     # 启动 Electron 壳（无 DSH_BIN 时进入错误面板并给出指引）
pnpm dev:tauri        # 仅前端（vite:1420）；完整壳：pnpm dev:tauri:shell（需 cargo）
```

运行真实 DSH：

```bash
npm i -g @deepseek-ai/dsh@0.1.5-rc.2   # 或
export DSH_BIN=$(which dsh)             # 平台壳自动解析；未设时 PATH 查找
pnpm dev:electron
```

未安装 DSH 时，`DSH_BIN` 指向 `packages/testkit/bin/mock-dsh.mjs`（字节级兼容 ready-line + 真 Cordis + 真插件）即可跑通全链路开发与测试。

## 目录 / Layout

```
apps/desktop-tauri/       Tauri 2 壳：src/（React，共享 ui）+ src-tauri/（Rust）
apps/desktop-electron/    Electron 薄宿主：src/main + src/preload + src/renderer
packages/protocol/        单一真相源：DesktopBridge / 控制通道 / ready-line 解析
packages/desktop-shell/   DSH Cordis 插件（ctx.desktopRuntime）+ cordis.patch.yml
packages/ui/              两框架共享 React 组件（DesktopRoot/StartupProgress/…）
packages/core|llm-sdk|mcp-client|session-store/  官方模型的类型化骨架
packages/testkit/         mock-dsh CLI 与 fixture
scripts/                  audit-contract / smoke-clean-boot / check-orphan-processes
docs/                     architecture / plugin-contract / release notes
PLAN.md                   50 槽位并发开发计划与官方事实标准
HANDOFF.md                交接文档（完成/未完成/如何跑/风险/下一步）
```

## 关键文档 / Key documents

- [PLAN.md](./PLAN.md) — 决策记录、官方事实标准、50 槽位分配
- [HANDOFF.md](./HANDOFF.md) — 交接状态与验证证据
- [docs/architecture.md](./docs/architecture.md) — 控制通道、生命周期、安全围栏
- [docs/plugin-contract.md](./docs/plugin-contract.md) — Cordis 插件契约与对目标文本的修正

## 安全 / Security

- 渲染进程 `contextIsolation` / `sandbox` / `nodeIntegration:false` / `webSecurity`（Electron）；Tauri 严格 CSP + 最小 capability 白名单。
- 控制通道仅 loopback + 随机 token header（`x-dsh-desktop-control`）。
- 日志对所有 `token=…` 脱敏。
