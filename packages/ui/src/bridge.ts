/**
 * Dual-platform bridge detection and event subscription.
 *
 * Resolution order (first match wins):
 *  1. `window.dshDesktop` — Electron preload injection. The preload exposes a
 *     flat `{ invoke(method, ...args), onState(cb), onLog(cb) }` object; method
 *     names passed to `invoke` are exactly the DESKTOP_BRIDGE_METHODS names.
 *  2. `window.__TAURI__` — Tauri 2 with `app.withGlobalTauri = true`. Commands
 *     are invoked via `__TAURI__.core.invoke(cmd, args)`; all 18 commands take
 *     either no argument or a single named-object argument.
 *  3. Otherwise `getDesktopBridge()` throws.
 */
import { BRIDGE_EVENTS } from '@dsh-desktop/protocol';
import type {
  BridgeEvents,
  DesktopBridge,
  DesktopSettings,
  HostEndpoint,
  HostStatus,
  InstalledPlugin,
  Profile,
} from '@dsh-desktop/protocol';

export type BridgeLogEntry = BridgeEvents['dsh:log'];
export type Unsubscribe = () => void;

/**
 * Contract the Electron preload must satisfy via contextBridge. Preload authors
 * should import this type instead of re-declaring `window.dshDesktop`, so the
 * global Window augmentation below stays the only one in the workspace.
 */
export interface ElectronPreloadApi {
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  /** May return an unsubscribe function; a missing one is tolerated. */
  onState(listener: (status: HostStatus) => void): unknown;
  onLog(listener: (entry: BridgeLogEntry) => void): unknown;
}

/** Minimal structural typing for the Tauri `withGlobalTauri` global. */
export interface TauriEventLike {
  payload: unknown;
}

export interface TauriGlobalLike {
  core: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  event: {
    listen(event: string, handler: (ev: TauriEventLike) => void): Promise<() => void>;
  };
}

declare global {
  interface Window {
    /** Injected by the Electron preload (contextBridge.exposeInMainWorld). */
    dshDesktop?: ElectronPreloadApi;
    /** Injected by Tauri 2 when `app.withGlobalTauri` is enabled. */
    __TAURI__?: TauriGlobalLike;
  }
}

function detectPreload(): ElectronPreloadApi | null {
  if (typeof window === 'undefined') return null;
  return window.dshDesktop ?? null;
}

function detectTauri(): TauriGlobalLike | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__ ?? null;
}

function unavailableError(): Error {
  return new Error(
    'DSH Desktop bridge unavailable: expected window.dshDesktop (Electron preload) or '
    + 'window.__TAURI__ (Tauri withGlobalTauri) on window. 检测不到桌面壳桥接，'
    + '此界面必须由 DSH Desktop 平台壳加载。',
  );
}

/**
 * Returns the DesktopBridge for the current platform. Detection is cheap and
 * intentionally NOT memoized, so test doubles can swap the global freely.
 */
export function getDesktopBridge(): DesktopBridge {
  const preload = detectPreload();
  if (preload) return createElectronBridge(preload);
  const tauri = detectTauri();
  if (tauri) return createTauriBridge(tauri);
  throw unavailableError();
}

/**
 * Human-readable message for a rejected bridge call. Bridge rejections may be
 * Error instances, DOMExceptions or plain strings depending on the platform.
 */
export function bridgeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function createElectronBridge(preload: ElectronPreloadApi): DesktopBridge {
  const call = <T,>(method: string, ...args: unknown[]): Promise<T> =>
    preload.invoke(method, ...args) as Promise<T>;
  // Method names must stay identical to the DESKTOP_BRIDGE_METHODS entries —
  // scripts/audit-contract.mjs scans these call sites.
  return {
    host_start: () => call<HostEndpoint>('host_start'),
    host_stop: () => call<void>('host_stop'),
    host_restart: () => call<HostEndpoint>('host_restart'),
    host_status: () => call<HostStatus>('host_status'),
    window_show: () => call<void>('window_show'),
    window_hide: () => call<void>('window_hide'),
    window_focus: () => call<void>('window_focus'),
    window_open_settings: () => call<void>('window_open_settings'),
    profile_list: () => call<Profile[]>('profile_list'),
    profile_current: () => call<Profile>('profile_current'),
    profile_switch: (name) => call<void>('profile_switch', name),
    open_data_dir: () => call<void>('open_data_dir'),
    open_external: (url) => call<void>('open_external', url),
    get_app_version: () => call<string>('get_app_version'),
    // v1.1: the preload allow-list is built from DESKTOP_BRIDGE_METHODS, so
    // these pass through with no preload changes.
    settings_get: () => call<DesktopSettings>('settings_get'),
    settings_set: (patch) => call<DesktopSettings>('settings_set', patch),
    plugin_list: () => call<InstalledPlugin[]>('plugin_list'),
    diagnostics_export: () => call<{ path: string }>('diagnostics_export'),
  };
}

function createTauriBridge(tauri: TauriGlobalLike): DesktopBridge {
  const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    tauri.core.invoke(cmd, args) as Promise<T>;
  // Tauri command args are positional object args: profile_switch(name) is
  // invoked as { name }, open_external(url) as { url }, settings_set(patch)
  // as { patch } (parameter name must match the Rust command signature);
  // everything else is zero-arg (see apps/desktop-tauri/src-tauri/src/ipc.rs).
  return {
    host_start: () => invoke<HostEndpoint>('host_start'),
    host_stop: () => invoke<void>('host_stop'),
    host_restart: () => invoke<HostEndpoint>('host_restart'),
    host_status: () => invoke<HostStatus>('host_status'),
    window_show: () => invoke<void>('window_show'),
    window_hide: () => invoke<void>('window_hide'),
    window_focus: () => invoke<void>('window_focus'),
    window_open_settings: () => invoke<void>('window_open_settings'),
    profile_list: () => invoke<Profile[]>('profile_list'),
    profile_current: () => invoke<Profile>('profile_current'),
    profile_switch: (name) => invoke<void>('profile_switch', { name }),
    open_data_dir: () => invoke<void>('open_data_dir'),
    open_external: (url) => invoke<void>('open_external', { url }),
    get_app_version: () => invoke<string>('get_app_version'),
    settings_get: () => invoke<DesktopSettings>('settings_get'),
    settings_set: (patch) => invoke<DesktopSettings>('settings_set', { patch }),
    plugin_list: () => invoke<InstalledPlugin[]>('plugin_list'),
    diagnostics_export: () => invoke<{ path: string }>('diagnostics_export'),
  };
}

function normalizeUnsubscribe(ret: unknown): Unsubscribe {
  return typeof ret === 'function' ? (ret as Unsubscribe) : () => undefined;
}

function subscribeTauriEvent(
  tauri: TauriGlobalLike,
  event: string,
  deliver: (payload: unknown) => void,
): Unsubscribe {
  // listen() resolves asynchronously; if the consumer unsubscribes before that,
  // the resolved unlisten fn must still run (or the listener leaks).
  let disposed = false;
  let unlisten: Unsubscribe | undefined;
  void tauri.event
    .listen(event, (ev) => deliver(ev.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

/** Subscribes to HostStatus pushes on whichever platform is detected. */
export function subscribeState(cb: (status: HostStatus) => void): Unsubscribe {
  const preload = detectPreload();
  if (preload) return normalizeUnsubscribe(preload.onState(cb));
  const tauri = detectTauri();
  if (tauri) {
    return subscribeTauriEvent(tauri, BRIDGE_EVENTS.state, (payload) => cb(payload as HostStatus));
  }
  throw unavailableError();
}

/** Subscribes to host log lines on whichever platform is detected. */
export function subscribeLog(cb: (entry: BridgeLogEntry) => void): Unsubscribe {
  const preload = detectPreload();
  if (preload) return normalizeUnsubscribe(preload.onLog(cb));
  const tauri = detectTauri();
  if (tauri) {
    return subscribeTauriEvent(tauri, BRIDGE_EVENTS.log, (payload) =>
      cb(payload as BridgeLogEntry),
    );
  }
  throw unavailableError();
}
