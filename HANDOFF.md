# HANDOFF.md — dsh-desktop 交接文档

> 时间盒：2026-09-20 01:40–09:00 +08:00 冲刺产物。本文档优先于记忆：所有"如何跑/为什么这样/还差什么"以这里为准。
> 项目性质：**非官方** DSH 桌面壳，MIT，与 DeepSeek 无隶属关系。上游 DSH 为 developer preview（"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"）。

## 0. 30 秒速览

- **Electron 壳在本机完整跑通**：`pnpm smoke:clean-boot:electron` PASS（真窗口 → 真 mock-dsh → 官方格式 ready-line → 真 Cordis+真插件控制通道 hello → WebView 挂载 → 干净退出零残留）。
- **Tauri 壳代码完整但未编译**（本机无 cargo/MSVC——已实测确认，非假设）；契约已用脚本机器 diff（14 命令逐字一致），CI 三平台矩阵会跑 clippy/test/build + DSH_E2E 生命周期测试。
- 全仓 `pnpm build` 0 错误、`pnpm test` 9 组测试文件全过、`pnpm audit:contract` 4/4。
- Pin：DSH `0.1.5-rc.2`（npm）/ 上游 HEAD `0.1.6-alpha.2 @ ddefc45f`（侦察与事实标准来源）；Cordis `4.0.2`。

## 1. 如何跑 / How to run

```bash
pnpm i                      # node >= 20, pnpm 10.15（packageManager 已固定）
pnpm build && pnpm test && pnpm audit:contract
pnpm smoke:clean-boot:electron
pnpm dev:electron           # 无 DSH_BIN 时 UI 显示错误面板 + 指引
```

| 场景 | 做法 |
|---|---|
| 装了官方 DSH | `npm i -g @deepseek-ai/dsh@0.1.5-rc.2` 后直接 `pnpm dev:electron`（PATH 找 `dsh`；或 `DSH_BIN=$(which dsh)`） |
| 没装官方 DSH | `DSH_BIN=<repo>/packages/testkit/bin/mock-dsh.mjs pnpm dev:electron` |
| Tauri 前端开发 | `pnpm dev:tauri`（vite:1420，浏览器预览） |
| Tauri 完整壳 | 需 Rust + MSVC + WebView2：`pnpm dev:tauri:shell`；打包 `pnpm dist:tauri:*` |
| Electron 打包 | `pnpm dist:electron:mac|windows|linux`（electron-builder） |
| 契约变更 | 改 `packages/protocol/src/bridge.ts` → `pnpm audit:contract` 会指名缺谁 |

**DSH_BIN 解析契约**（两平台逐字一致）：`.mjs/.cjs/.js` → node 执行（Electron 内 `ELECTRON_RUN_AS_NODE=1`）；`.cmd/.bat` → `cmd /d /s /c`；否则直接执行；未设 → PATH 找 `dsh`。参数固定 `--profile <p> --patch <packages/desktop-shell/cordis.patch.yml> --port 0 --no-open`。

**profile**：位于 `$DSH_HOME/profiles/<name>`（默认 `~/.dsh`）。空目录时壳自举默认 profile（`dsh-desktop-electron` / `dsh-desktop-tauri`，bundles = dsh-base + dsh-web-app，镜像官方 initProfile）。CLI 拒绝 `--profile desktop`（官方 Electron 专属）——不要用这个名字。插件注入走 `--patch` overlay，不修改用户 cordis.patch.yml。

**DSH_SMOKE 契约**：`DSH_SMOKE=1` + `DSH_SMOKE_OUT=<path>` 下，壳走真实窗口/托盘/sidecar 路径，三条件（running + hello + attached）齐备写报告并退出 0；90s 超时带 errors 退出 1。

## 2. 完成状态 / 完成标准对照

| 完成标准（目标原文） | 状态 | 证据 |
|---|---|---|
| 两框架均可 `pnpm dev` 启动，WebView 加载 DSH Web UI | ✅ Electron 本机实测；Tauri 代码完整待编译 | smoke 报告 `port=52483 hello=true attached=true`；Tauri 同构代码 + CI |
| desktop-shell 插件经 cordis.patch.yml 加载，ctx.desktopRuntime 可用 | ✅ | mock-dsh 用真 cordis 加载真插件；`--patch` 参数在 spawn argv；插件测试 4/4 |
| 系统托盘（显示/隐藏、数据目录、重启 Host、退出） | ✅ | `apps/desktop-electron/src/main/tray.ts`、`src-tauri/src/tray.rs` 菜单同构 |
| Profile 解析 + last-known-good 持久化 | ✅ | launcher 自举 + desktop-state.json 原子写（tmp+rename）；测试覆盖 |
| 两框架 DesktopBridge 签名逐字一致 | ✅ 机器强制 | `pnpm audit:contract` 4/4；`satisfies DesktopBridge`；protocol 类型级 Exact 断言 |
| README 架构/构建/与官方关系 | ✅ | README.md（中英）+ docs/architecture.md |
| HANDOFF.md 完成/未完成/如何跑/风险/下一步 | ✅ | 本文档 |
| 未完成项 `// TODO(reason)` | ✅ | updater×2、打包态 patch 路径、tauri 首编译（均有原因注释） |

**测试计数**：protocol 6、desktop-shell 4、ui 21、core 2、llm-sdk 3、mcp-client 2（真子进程 MCP server）、session-store 1、desktop-electron 30（含真进程树 kill、真 mock-dsh sidecar）、desktop-tauri 1 → **9 组 70 测试全绿**。

## 3. 未完成 / TODO（全部有代码内标注）

| 项 | 位置 | 原因 | 建议 |
|---|---|---|---|
| Tauri 首次 `cargo check`/`cargo test` | apps/desktop-tauri/src-tauri | 本机无 Rust/MSVC（实测：无 link.exe、无 VS） | 装 VS Build Tools + rustup 后先 `cargo clippy -D warnings`；CI 已配三 OS 矩阵 |
| 打包态 `--patch` 路径 | electron sidecar.ts / tauri sidecar.rs | MVP 只解析 monorepo 内路径 | 打包时把 cordis.patch.yml 复制进 resources 并加打包态解析分支 |
| updater 验证 | electron index.ts / tauri Cargo | 无发布源（签名产物 + latest.yml/latest.json） | 建 GitHub Releases 后设 `DSH_UPDATE_URL` / updater 配置 |
| 尾随 `dsh web` 第二行（`opening the default browser`）| 无需处理 | `--no-open` 已抑制 | — |
| Tailwind / Zustand / TanStack | — | MVP 用零依赖 CSS + hooks；技术表为愿景，砍单保可运行 | UI 复杂化时再引入 |
| 官方 DSH 真机联调 | — | npm 发布版 0.1.5-rc.2 与侦察 HEAD 0.1.6-alpha.2 可能有细微 ready-line 差异 | 装官方包跑一次 `pnpm smoke:clean-boot:electron`（DSH_BIN 指真 dsh）即回归 |

## 4. 关键风险与已验证事实

1. **ready-line 协议漂移** = 最高风险。缓解：解析集中在 protocol 单点 + mock/单测锁定 + HANDOFF 升级流程。升级步骤：改 PLAN.md §0 pin → `pnpm i` → `DSH_BIN=$(which dsh) pnpm smoke:clean-boot:electron` → `pnpm test`。
2. **进程残留**：双平台 tree-kill（taskkill /T /F + Tauri Job Object + Unix 进程组）+ before-quit/Drop 兜底 + smoke 后孤儿扫描。Electron 路径已实测零残留。
3. **两框架行为漂移**：audit:contract 机器强制；新增桥方法必须同步 4 处（protocol、ipc.ts、ipc.rs、ui bridge）——审计脚本会指名。
4. **loopback-only**：origin 相等判定（非前缀）在两平台实现并测试；外链 http/https/mailto → 系统浏览器，其余一律拒绝。
5. **控制通道安全**：loopback + 32B 随机 token 头（timingSafeEqual），无 token 403。

## 5. 与目标文本的偏差（均为侦察后的事实修正）

- `ctx.set` → `ctx.provide`；`ctx.on('ready')` 不存在 → inject + apply（详见 docs/plugin-contract.md）。
- `--profile desktop` 被 CLI 拒绝 → 自有 profile 名。
- 参考库 dsh-tauri-desktop 实际结构与目标文本描述不符（无 contracts/ 多 crate）→ 本项目自建契约 + 机器审计，借鉴其有效模式（CREATE_NO_WINDOW、kill_on_drop、splash 节奏、CI 矩阵）。
- Electron 官方桌面用 utilityProcess 内嵌 runner；本项目按目标要求 spawn 外部 `dsh` CLI 子进程（mock-dsh 可替换为真 dsh，同一路径）。
- 槽位 S 组/T 组/E 组/V 组 50 槽以 3 个并行实现代理 + 主线程映射执行（槽位是调度概念；映射表见 PLAN.md §6）。

## 6. 下一步建议（优先级序）

1. 有 Rust 工具链的机器：`cargo clippy -D warnings` → `cargo test` → `pnpm dev:tauri:shell` 跑通 Tauri clean-boot（预期主要问题在 tauri API 细节，代码已按 .refs/dsh-tauri-desktop 2.11.5 对照）。
2. 安装官方 `@deepseek-ai/dsh` 做一次真机 smoke（mock → real 仅 DSH_BIN 一个变量）。
3. 建 GitHub Releases：接入两个 updater + 打包产物。
4. 把 desktop-shell 插件发布为 npm 包，profile 走 `dsh plugin add` 安装（当前 --patch overlay 已可用）。
5. advanced/compatibility 桌面框架模式（官方 36px frame / root slot 接管）——本期砍单。
