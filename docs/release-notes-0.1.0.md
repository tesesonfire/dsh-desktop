# Release notes — dsh-desktop 0.1.0 (2026-09-20)

首个可交接版本：双框架（Tauri 2 + Electron）共享契约层的 DSH 桌面壳。

## 新增

- **共享契约层（冻结）**：`packages/protocol`（DesktopBridge 14 方法 / 控制通道 / ready-line 单点解析）、`packages/desktop-shell`（Cordis 插件 `dsh-desktop-shell` + cordis.patch.yml）。
- **Electron 薄宿主**（本机完整验证）：单实例锁、control server、sidecar（DSH_BIN 契约）、ShellGeneration、托盘、14 个 IPC 通道、CSP、导航围栏、日志轮转、DSH_SMOKE 全链路 clean-boot 通过。
- **Tauri 2 壳**（代码完整，本机无 Rust 工具链未编译，CI 三平台矩阵验证）：同构 sidecar/控制通道/托盘/IPC/导航围栏，Windows Job Object + taskkill /T 双兜底，图标生成器。
- **机器强制防漂移**：`pnpm audit:contract`（4 审计点）+ `satisfies DesktopBridge` 类型断言。
- **mock-dsh**：字节级兼容官方 ready-line + 真 @deepseek-ai/cordis + 真插件，无上游安装时全链路可测。
- **clean-boot smoke**：`pnpm smoke:clean-boot:electron|tauri`（真窗口 + 官方格式 ready line + 控制 hello + WebView 挂载 + 零残留断言）。
- 共享包骨架：core（官方会话事件词汇的类型化 façade）、llm-sdk（对齐官方 Message/ToolSchema + OpenAI 兼容流式解析）、mcp-client（stdio transport + initialize/list/call 真进程测试）、session-store（node:sqlite 迁移链）。

## 已知限制

- Tauri 未在本机编译（无 cargo/MSVC）；`cargo check` 是它的第一道真实闸门（CI 已配）。
- electron-updater / tauri-plugin-updater 已接线但无发布源，不可验证（TODO(release-infra)）。
- 打包脚本存在（electron-builder.yml / tauri bundle targets）但产物未在本机构建。
