/**
 * DesktopBridge — the renderer ↔ platform-shell IPC contract.
 *
 * This file is the single source of truth. The Tauri side implements every
 * method as a `#[tauri::command]` in apps/desktop-tauri/src-tauri/src/ipc.rs;
 * the Electron side implements every method as an `ipcMain.handle` in
 * apps/desktop-electron/src/main/ipc.ts. Names, parameters and return types
 * must match verbatim. scripts/audit-contract.mjs enforces this mechanically.
 */

export type HostState = 'stopped' | 'starting' | 'running' | 'error';

export interface HostStatus {
  state: HostState;
  port?: number;
  url?: string;
  error?: string;
  startedAt?: number;
}

export interface Profile {
  name: string;
  path: string;
  bundles: string[];
}

export interface HostEndpoint {
  port: number;
  url: string;
}

/**
 * v1.1 shell preferences (persisted per-user, applied by the platform shell).
 * Both platforms must implement settings_get/settings_set with identical
 * semantics: set() validates + persists + applies, then returns the new value.
 */
export interface DesktopSettings {
  /** Window close hides to tray instead of quitting (default true). */
  closeToTray: boolean;
  /** Start with the main window hidden (tray only). */
  startMinimized: boolean;
  /** Renderer zoom factor, clamped to [0.5, 2.0]. */
  zoomFactor: number;
}

export const DESKTOP_SETTINGS_DEFAULTS: DesktopSettings = {
  closeToTray: true,
  startMinimized: false,
  zoomFactor: 1.0,
};

/** A plugin installed in the current DSH profile (scan of dsh.bundle manifests). */
export interface InstalledPlugin {
  /** npm package name, e.g. `dsh-desktop-shell`. */
  name: string;
  version: string;
  /** Patch file declared via dsh.bundle.patch, when present. */
  patchPath?: string;
  /** Web client declaration via dsh.client, when present. */
  clientPlatform?: string;
}

export interface DesktopBridge {
  // 生命周期
  host_start(): Promise<HostEndpoint>;
  host_stop(): Promise<void>;
  host_restart(): Promise<HostEndpoint>;
  host_status(): Promise<HostStatus>;

  // 窗口
  window_show(): Promise<void>;
  window_hide(): Promise<void>;
  window_focus(): Promise<void>;
  window_open_settings(): Promise<void>;

  // Profile
  profile_list(): Promise<Profile[]>;
  profile_current(): Promise<Profile>;
  profile_switch(name: string): Promise<void>;

  // 系统
  open_data_dir(): Promise<void>;
  open_external(url: string): Promise<void>;
  get_app_version(): Promise<string>;

  // v1.1 — shell settings / plugin inventory / diagnostics
  settings_get(): Promise<DesktopSettings>;
  settings_set(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  plugin_list(): Promise<InstalledPlugin[]>;
  diagnostics_export(): Promise<{ path: string }>;
}

/**
 * Canonical, runtime-usable method list. It is `satisfies`-checked against
 * keyof DesktopBridge below and both Exclude directions assert exact equality,
 * so the tuple can never drift from the interface (and vice versa) at compile
 * time. scripts/audit-contract.mjs additionally diffs the platform
 * implementations against this list at test time.
 */
export const DESKTOP_BRIDGE_METHODS = [
  'host_start',
  'host_stop',
  'host_restart',
  'host_status',
  'window_show',
  'window_hide',
  'window_focus',
  'window_open_settings',
  'profile_list',
  'profile_current',
  'profile_switch',
  'open_data_dir',
  'open_external',
  'get_app_version',
  'settings_get',
  'settings_set',
  'plugin_list',
  'diagnostics_export',
] as const satisfies readonly (keyof DesktopBridge)[];

type _NoExtraInterfaceKeys = [Exclude<keyof DesktopBridge, (typeof DESKTOP_BRIDGE_METHODS)[number]>] extends [never] ? true : false;
type _NoExtraTupleEntries = [Exclude<(typeof DESKTOP_BRIDGE_METHODS)[number], keyof DesktopBridge>] extends [never] ? true : false;
const _contractListIsExact: [_NoExtraInterfaceKeys, _NoExtraTupleEntries] = [true, true];
void _contractListIsExact;

/**
 * Events pushed from the platform shell to the renderer. Both platforms emit
 * through the channel names defined in ./events.ts.
 */
export interface BridgeEvents {
  'dsh:state': HostStatus;
  'dsh:log': { level: 'info' | 'warn' | 'error'; line: string };
}
