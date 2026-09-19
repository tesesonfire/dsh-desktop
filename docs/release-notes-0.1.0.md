# Release notes — dsh-desktop 0.1.0 (2026-09-20)

首个可交接版本：双框架（Tauri 2 + Electron）共享契约层的 DSH 桌面壳。

## 新增

- **共享契约层（v1.1）**：`packages/protocol`（DesktopBridge **18** 方法：原 14 + settings_get/settings_set/plugin_list/diagnostics_export；控制通道；ready-line 单点解析）、`packages/desktop-shell`（Cordis 插件 `dsh-desktop-shell` + cordis.patch.yml）。
- **Electron 薄宿主**（本机完整验证）：单实例锁、control server、sidecar（DSH_BIN 契约）、ShellGeneration、托盘 v2（三组菜单：窗口/Profile radio 子菜单/工具组）、14+4 个 IPC 通道、CSP、导航围栏（origin 相等）、日志轮转（跨天修复）、**崩溃自愈重启 + 系统通知**、**设置持久化**（closeToTray/startMinimized/zoomFactor）、**插件清单**（扫 profile node_modules 的 dsh.bundle/client manifest）、**诊断导出**（token 脱敏）、**缩放快捷键**（Ctrl+=/-/0）、**打开终端**。56 测试 + clean-boot smoke（成功路径 + **失败路径**）全绿。
- **Tauri 2 壳**：Electron 全部功能的 Rust 镜像；CI 三平台矩阵验证编译/测试（GitHub Actions，仓库 `tesesonfire/dsh-desktop`）。
- **机器强制防漂移**：`pnpm audit:contract`（4 审计点 × 18 方法）+ `satisfies DesktopBridge`。
- **mock-dsh**：字节级兼容官方 ready-line + 真 Cordis + 真插件 + 失败模式（EXIT_BEFORE_READY/READY_THEN_CRASH）。
- **CI/CD**：`.github/workflows/ci.yml` — node（build/test/audit）、electron smoke（windows）、rust 三平台（clippy -D warnings/test/build + DSH_E2E 生命周期）。
- 共享包：core/llm-sdk/mcp-client/session-store 骨架 + ui 设置页三段式（Profile/外观与行为/插件与诊断）。

## 已知限制

- Tauri 首次编译由 CI 完成，本地无 Rust 工具链；编译反馈驱动了 12 处修复（缺分号、E0505 借用、u64/usize、center()、Windows Job Object FFI 不可用改为 taskkill /T 等）。
- electron-updater / tauri-plugin-updater 已接线但无发布源（TODO(release-infra)）。
- 打包脚本存在但产物未在本机构建。

