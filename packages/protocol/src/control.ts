/**
 * Desktop control channel — the only crossing between the platform shell
 * (Tauri Rust / Electron main) and the in-host desktop-shell Cordis plugin.
 *
 * Direction: the shell runs a loopback HTTP server (random port, random
 * per-launch token) before spawning `dsh`; the dsh process receives
 * DSH_DESKTOP_CONTROL_URL / DSH_DESKTOP_CONTROL_TOKEN via env; the
 * desktop-shell plugin inside the host calls these endpoints. Everything is
 * loopback-only and token-gated.
 *
 * The endpoints live here as string constants so the Tauri routes, the
 * Electron routes and the plugin client can never disagree.
 */
import type { HostEndpoint, Profile } from './bridge';

export const CONTROL_PROTOCOL_VERSION = 1 as const;

export const CONTROL_URL_ENV = 'DSH_DESKTOP_CONTROL_URL';
export const CONTROL_TOKEN_ENV = 'DSH_DESKTOP_CONTROL_TOKEN';
export const CONTROL_TOKEN_HEADER = 'x-dsh-desktop-control';

export const CONTROL_TIMEOUT_MS = 10_000;
export const CONTROL_EVENTS_LONGPOLL_MS = 25_000;

export const CONTROL_ENDPOINTS = {
  hello: '/v0/hello',
  webviewAttach: '/v0/webview/attach',
  hostStop: '/v0/host/stop',
  hostRestart: '/v0/host/restart',
  events: '/v0/events',
} as const satisfies Record<string, `/${string}`>;

/** Plugin → shell: announce the host process after mount. */
export interface ControlHello {
  pid: number;
  webPort: number;
  profile: string;
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
}

/** Plugin → shell: ask the shell to load a loopback URL in the web view. */
export interface ControlAttachWebView {
  url: string;
}

/** Shell → plugin, delivered via long-poll on GET /v0/events. */
export type ControlEvent =
  | { type: 'window-close' }
  | { type: 'shutdown' };

export interface ControlEventBatch {
  events: ControlEvent[];
}

/** Body of POST /v0/host/restart when it succeeds. */
export interface ControlHostEndpoint {
  port: number;
  url: string;
}

/**
 * The `desktopRuntime` Cordis service surface provided by the in-host
 * desktop-shell plugin (ctx.provide('desktopRuntime', ...)). Every method is
 * a thin HTTP call into the platform shell's control server, so the platform
 * layer only ever implements the three primitives plus trivial queries.
 */
export interface SpawnOptions {
  profile?: string;
}

export interface DesktopRuntimeService {
  spawnHost(opts?: SpawnOptions): Promise<HostEndpoint>;
  killHost(): Promise<void>;
  restartHost(opts?: SpawnOptions): Promise<HostEndpoint>;
  attachWebView(url: string): Promise<void>;
  getProfile(): Promise<Profile>;
  onWindowClose(cb: () => void): () => void;
}
