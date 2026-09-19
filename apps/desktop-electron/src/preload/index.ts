/**
 * Preload — the ONLY surface the renderer gets. Sandboxed (no node), CJS
 * bundle; exposes a single allow-listed invoke plus the two push channels.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_EVENTS, DESKTOP_BRIDGE_METHODS } from '@dsh-desktop/protocol';

const allowedMethods: ReadonlySet<string> = new Set(DESKTOP_BRIDGE_METHODS);

export interface DshDesktopPreload {
  invoke: (method: string, ...args: unknown[]) => Promise<unknown>;
  onState: (callback: (status: unknown) => void) => () => void;
  onLog: (callback: (entry: { level: 'info' | 'warn' | 'error'; line: string }) => void) => () => void;
}

const api: DshDesktopPreload = {
  invoke: (method, ...args) => {
    // Allow-list before the channel string is ever built: a renderer cannot
    // probe arbitrary ipcMain channels by name.
    if (!allowedMethods.has(method)) {
      return Promise.reject(new Error(`dshDesktop.invoke: unknown bridge method ${method}`));
    }
    return ipcRenderer.invoke(`bridge:${method}`, ...args);
  },
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown): void => callback(status);
    ipcRenderer.on(BRIDGE_EVENTS.state, listener);
    return () => ipcRenderer.removeListener(BRIDGE_EVENTS.state, listener);
  },
  onLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: { level: 'info' | 'warn' | 'error'; line: string }): void => callback(entry);
    ipcRenderer.on(BRIDGE_EVENTS.log, listener);
    return () => ipcRenderer.removeListener(BRIDGE_EVENTS.log, listener);
  },
};

contextBridge.exposeInMainWorld('dshDesktop', api);
