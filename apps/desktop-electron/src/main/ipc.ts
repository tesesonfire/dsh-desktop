/**
 * DesktopBridge IPC — the renderer <-> platform-shell surface.
 *
 * Audit format (scripts/audit-contract.mjs scans this file): every handler is
 * registered on a LITERAL channel string `bridge:<method>` and the method set
 * is `satisfies DesktopBridge`-checked against @dsh-desktop/protocol, so the
 * registry can never drift from the contract or from the Tauri twin.
 *
 * Push channels are BRIDGE_EVENTS ('dsh:state' / 'dsh:log') — the same
 * constants the preload forwards to the renderer.
 */
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import {
  BRIDGE_EVENTS,
  DESKTOP_BRIDGE_METHODS,
  type DesktopBridge,
  type DesktopSettings,
  type HostEndpoint,
  type HostStatus,
  type InstalledPlugin,
  type Profile,
} from '@dsh-desktop/protocol';
import type { DshSidecar } from './sidecar';
import type { Launcher } from './launcher';
import type { ShellGeneration } from './shell';
import type { SettingsStore } from './settings-store';

export interface DesktopBridgeDeps {
  sidecar: DshSidecar;
  generation: ShellGeneration;
  launcher: Launcher;
  openSettings: () => void;
  userDataDir: string;
  settingsStore: SettingsStore;
  /** Read-only plugin inventory of the current profile (dsh.bundle/client manifests). */
  pluginList: () => InstalledPlugin[];
  /** Collect + write the diagnostics report; returns the written file path. */
  exportDiagnostics: () => { path: string };
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Subscribe to (already masked) main-process log lines for the 'dsh:log' push channel. */
  logOnLine: (subscriber: (entry: { level: 'info' | 'warn' | 'error'; line: string }) => void) => () => void;
  /** Manual host_start re-arms the crash supervisor after a give-up. */
  onHostStart?: () => void;
}

/** Bridge surface implementation, type-checked against the canonical contract. */
function createBridge(deps: DesktopBridgeDeps): DesktopBridge {
  return {
    host_start: (): Promise<HostEndpoint> => {
      deps.onHostStart?.();
      return deps.sidecar.spawn();
    },
    host_stop: async (): Promise<void> => {
      await deps.sidecar.stop();
    },
    host_restart: (): Promise<HostEndpoint> => deps.sidecar.restart(),
    host_status: async (): Promise<HostStatus> => deps.sidecar.status,

    window_show: async (): Promise<void> => {
      deps.generation.show();
    },
    window_hide: async (): Promise<void> => {
      deps.generation.hide();
    },
    window_focus: async (): Promise<void> => {
      deps.generation.focus();
    },
    window_open_settings: async (): Promise<void> => {
      deps.openSettings();
    },

    profile_list: async (): Promise<Profile[]> => deps.launcher.listProfiles(),
    profile_current: async (): Promise<Profile> => deps.launcher.getCurrentProfile(),
    profile_switch: async (name: string): Promise<void> => {
      await deps.launcher.switchProfile(name);
    },

    open_data_dir: async (): Promise<void> => {
      await shell.openPath(deps.userDataDir);
    },
    open_external: async (url: string): Promise<void> => {
      // Fence: only these schemes may leave the app; everything else is a
      // renderer bug or an injection attempt.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`open_external: not a valid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
        throw new Error(`open_external: scheme not allowed: ${parsed.protocol}`);
      }
      await shell.openExternal(parsed.href);
    },
    get_app_version: async (): Promise<string> => app.getVersion(),

    settings_get: async (): Promise<DesktopSettings> => deps.settingsStore.get(),
    settings_set: async (patch: Partial<DesktopSettings>): Promise<DesktopSettings> => {
      const next = deps.settingsStore.set(patch);
      // Zoom applies to the live webContents; the other keys are read at
      // window close/mount time.
      deps.generation.setZoom(next.zoomFactor);
      return next;
    },
    plugin_list: async (): Promise<InstalledPlugin[]> => deps.pluginList(),
    diagnostics_export: async (): Promise<{ path: string }> => deps.exportDiagnostics(),
  };
}

export interface BridgeIpcRegistration {
  unregister: () => void;
}

export function registerDesktopBridgeIpc(deps: DesktopBridgeDeps): BridgeIpcRegistration {
  const bridge = createBridge(deps);

  // Literal channel names — the contract audit greps for exactly these.
  ipcMain.handle('bridge:host_start', () => bridge.host_start());
  ipcMain.handle('bridge:host_stop', () => bridge.host_stop());
  ipcMain.handle('bridge:host_restart', () => bridge.host_restart());
  ipcMain.handle('bridge:host_status', () => bridge.host_status());
  ipcMain.handle('bridge:window_show', () => bridge.window_show());
  ipcMain.handle('bridge:window_hide', () => bridge.window_hide());
  ipcMain.handle('bridge:window_focus', () => bridge.window_focus());
  ipcMain.handle('bridge:window_open_settings', () => bridge.window_open_settings());
  ipcMain.handle('bridge:profile_list', () => bridge.profile_list());
  ipcMain.handle('bridge:profile_current', () => bridge.profile_current());
  ipcMain.handle('bridge:profile_switch', (_event, name: string) => bridge.profile_switch(name));
  ipcMain.handle('bridge:open_data_dir', () => bridge.open_data_dir());
  ipcMain.handle('bridge:open_external', (_event, url: string) => bridge.open_external(url));
  ipcMain.handle('bridge:get_app_version', () => bridge.get_app_version());
  ipcMain.handle('bridge:settings_get', () => bridge.settings_get());
  ipcMain.handle('bridge:settings_set', (_event, patch: Partial<DesktopSettings>) => bridge.settings_set(patch));
  ipcMain.handle('bridge:plugin_list', () => bridge.plugin_list());
  ipcMain.handle('bridge:diagnostics_export', () => bridge.diagnostics_export());

  const sendToAll = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  const onSidecarState = (status: HostStatus): void => {
    sendToAll(BRIDGE_EVENTS.state, status);
  };
  const onLogLine = (entry: { level: 'info' | 'warn' | 'error'; line: string }): void => {
    sendToAll(BRIDGE_EVENTS.log, entry);
  };

  deps.sidecar.on('state', onSidecarState);
  const unsubscribeLog = deps.logOnLine(onLogLine);

  return {
    unregister: () => {
      deps.sidecar.off('state', onSidecarState);
      unsubscribeLog();
      for (const method of DESKTOP_BRIDGE_METHODS) {
        ipcMain.removeHandler(`bridge:${method}`);
      }
    },
  };
}
