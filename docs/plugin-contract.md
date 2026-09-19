# desktop-shell 插件契约 / Plugin Contract

`packages/desktop-shell`（包名 `dsh-desktop-shell`）是运行在 **DSH Host 进程内** 的 Cordis 插件，是双框架共享的 DSH 侧契约。

## 导出面

```ts
export const name = 'dsh-desktop-shell';
export const inject = ['webServer'] as const;
export function apply(ctx: Context, config: unknown, options?: ApplyOptions): void;
```

`inject: ['webServer']` 保证插件只在官方 web server 服务存在后挂载。

## ctx.desktopRuntime 服务面

```ts
interface DesktopRuntimeService {
  spawnHost(opts?: SpawnOptions): Promise<HostEndpoint>;   // {port, url}
  killHost(): Promise<void>;
  restartHost(opts?: SpawnOptions): Promise<HostEndpoint>;
  attachWebView(url: string): Promise<void>;
  getProfile(): Promise<Profile>;
  onWindowClose(cb: () => void): () => void;               // 返回退订函数
}
```

实现 = `ControlClient`（`src/control-client.ts`）：每个方法一次 loopback HTTP 调用（`x-dsh-desktop-control` token 头）到平台壳控制服务器。`onWindowClose` 经 `GET /v0/events` 长轮询分发 `window-close` 事件。

## 对原目标文本的三处事实修正（已对齐上游源码验证）

| 目标文本写法 | 上游事实（@deepseek-ai/cordis 4.0.2 / ddefc45f） | 本项目落地 |
|---|---|---|
| `ctx.set('desktopRuntime', …)` | `ctx.set` 仅提供者 fiber 可用（`vendor/cordis/src/reflect.ts:15-46`） | `ctx.provide('desktopRuntime', …)` |
| `ctx.on('ready', …)` | vendored cordis **不存在**通用 ready 事件 | `inject: ['webServer']` + `apply()` 内立即宣告（webServer 就绪是挂载前提，apply 即 ready 点） |
| 插件直接实现 spawnHost | 插件在 Host 内无法 spawn 自己的宿主进程 | 插件只做 HTTP 客户端；三原语实现在平台壳控制服务器 |

## cordis.patch.yml 语义

```yaml
- insert:
    - id: desktop-shell
      name: dsh-desktop-shell
```

- 注入方式：平台壳 spawn 时传 `--patch <此文件>`（launcher flag，位于 `--profile` 之后、app flags 之前）；**不修改用户 cordis.patch.yml**。
- 有意不 patch `web-runtime` 行：ready-line（`dsh web: …`）由 web-app bundle 打印，是 sidecar 的唯一就绪契约；浏览器抑制用 `--no-open` 完成。
- 记住 patch 的叠加规则：按 `id` 定位、整行 config 替换、后层覆盖前层。

## 降级模式

`DSH_DESKTOP_CONTROL_URL` / `DSH_DESKTOP_CONTROL_TOKEN` 缺失（用户手跑 `dsh web`）→ 提供桩服务，任何调用抛 `ControlUnavailableError` 并提示需要 shell env；`getProfile()` 仍返回 env 里可得的 profile 名。

## 测试与真实验证

- `packages/desktop-shell/test/plugin.test.ts`：4 例（降级桩、hello/attach 请求形状与 token 头、window-close 事件分发）。
- `packages/testkit/bin/mock-dsh.mjs` 用 **真 @deepseek-ai/cordis** 加载 **真插件**，Electron clean-boot smoke 全链路验证 hello + 事件泵。
