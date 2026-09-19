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
