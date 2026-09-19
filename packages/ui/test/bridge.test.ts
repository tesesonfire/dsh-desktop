import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_BRIDGE_METHODS } from '@dsh-desktop/protocol';
import { getDesktopBridge, subscribeLog, subscribeState } from '../src/bridge.js';
import type { HostStatus } from '@dsh-desktop/protocol';
import { flushAsync } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDesktopBridge — Electron preload (window.dshDesktop)', () => {
  it('delegates every canonical method to invoke with the same name', async () => {
    const invoke = vi.fn(async (method: string) => ({ method }));
    vi.stubGlobal('window', {
      dshDesktop: { invoke, onState: () => () => undefined, onLog: () => () => undefined },
    });

    const bridge = getDesktopBridge();
    for (const method of DESKTOP_BRIDGE_METHODS) {
      expect(typeof bridge[method]).toBe('function');
    }
    await bridge.host_status();
    expect(invoke).toHaveBeenCalledWith('host_status');
    await bridge.profile_switch('dsh-desktop-electron');
    expect(invoke).toHaveBeenCalledWith('profile_switch', 'dsh-desktop-electron');
    await bridge.open_external('https://example.com');
    expect(invoke).toHaveBeenCalledWith('open_external', 'https://example.com');
  });

  it('passes the v1.1 methods through positionally (patch as 2nd arg)', async () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal('window', {
      dshDesktop: { invoke, onState: () => () => undefined, onLog: () => () => undefined },
    });

    const bridge = getDesktopBridge();
    await bridge.settings_get();
    expect(invoke).toHaveBeenLastCalledWith('settings_get');
    await bridge.settings_set({ closeToTray: false });
    expect(invoke).toHaveBeenLastCalledWith('settings_set', { closeToTray: false });
    await bridge.plugin_list();
    expect(invoke).toHaveBeenLastCalledWith('plugin_list');
    await bridge.diagnostics_export();
    expect(invoke).toHaveBeenLastCalledWith('diagnostics_export');
  });
});

describe('getDesktopBridge — Tauri (window.__TAURI__)', () => {
  it('maps commands to core.invoke with named-object args', async () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal('window', {
      __TAURI__: { core: { invoke }, event: { listen: vi.fn(async () => () => undefined) } },
    });

    const bridge = getDesktopBridge();
    for (const method of DESKTOP_BRIDGE_METHODS) {
      expect(typeof bridge[method]).toBe('function');
    }
    await bridge.host_start();
    expect(invoke).toHaveBeenCalledWith('host_start', undefined);
    await bridge.profile_list();
    expect(invoke).toHaveBeenCalledWith('profile_list', undefined);
    await bridge.profile_switch('dsh-desktop-tauri');
    expect(invoke).toHaveBeenCalledWith('profile_switch', { name: 'dsh-desktop-tauri' });
    await bridge.open_external('https://example.com');
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.com' });
  });

  it('passes the v1.1 commands with canonical arg shapes (settings_set uses {patch})', async () => {
    const settings = { closeToTray: true, startMinimized: false, zoomFactor: 1.25 };
    const plugins = [{ name: 'dsh-web-app', version: '0.1.0' }];
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'settings_get' || cmd === 'settings_set') return settings;
      if (cmd === 'plugin_list') return plugins;
      if (cmd === 'diagnostics_export') return { path: '/tmp/dsh-diagnostics.zip' };
      return {};
    });
    vi.stubGlobal('window', {
      __TAURI__: { core: { invoke }, event: { listen: vi.fn(async () => () => undefined) } },
    });

    const bridge = getDesktopBridge();
    await expect(bridge.settings_get()).resolves.toBe(settings);
    expect(invoke).toHaveBeenLastCalledWith('settings_get', undefined);

    // The patch must ride in a named `patch` arg to match the Rust command
    // signature — a bare object or a renamed key would break the invocation.
    await bridge.settings_set({ zoomFactor: 1.5 });
    expect(invoke).toHaveBeenLastCalledWith('settings_set', { patch: { zoomFactor: 1.5 } });

    await expect(bridge.plugin_list()).resolves.toBe(plugins);
    expect(invoke).toHaveBeenLastCalledWith('plugin_list', undefined);

    await expect(bridge.diagnostics_export()).resolves.toEqual({ path: '/tmp/dsh-diagnostics.zip' });
    expect(invoke).toHaveBeenLastCalledWith('diagnostics_export', undefined);
  });
});

describe('getDesktopBridge — unavailable', () => {
  it('throws when window has neither global', () => {
    vi.stubGlobal('window', {});
    expect(() => getDesktopBridge()).toThrow(/dshDesktop/);
  });

  it('throws when there is no window at all (SSR / tests)', () => {
    // afterEach has already removed all stubs — window is undefined here.
    expect(() => getDesktopBridge()).toThrow(/__TAURI__/);
  });
});

describe('subscribeState / subscribeLog', () => {
  it('uses onState/onLog on Electron and forwards the preload unsubscribe', () => {
    const offState = vi.fn();
    const offLog = vi.fn();
    const onState = vi.fn(() => offState);
    const onLog = vi.fn(() => offLog);
    vi.stubGlobal('window', { dshDesktop: { invoke: vi.fn(), onState, onLog } });

    const off = subscribeState(() => undefined);
    expect(onState).toHaveBeenCalledTimes(1);
    off();
    expect(offState).toHaveBeenCalledTimes(1);

    const offLogFn = subscribeLog(() => undefined);
    expect(onLog).toHaveBeenCalledTimes(1);
    offLogFn();
    expect(offLog).toHaveBeenCalledTimes(1);
  });

  it('listens on dsh:state with Tauri and forwards event payloads', async () => {
    let handler: ((ev: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_event: string, h: (ev: { payload: unknown }) => void) => {
      handler = h;
      return unlisten;
    });
    vi.stubGlobal('window', {
      __TAURI__: { core: { invoke: vi.fn() }, event: { listen } },
    });

    const seen: HostStatus[] = [];
    const off = subscribeState((status) => seen.push(status));
    expect(listen).toHaveBeenCalledWith('dsh:state', expect.any(Function));
    handler?.({ payload: { state: 'running', port: 49152 } });
    expect(seen).toEqual([{ state: 'running', port: 49152 }]);

    await flushAsync();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes when the consumer cancels before listen resolves', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn(async () => unlisten);
    vi.stubGlobal('window', {
      __TAURI__: { core: { invoke: vi.fn() }, event: { listen } },
    });

    const off = subscribeState(() => undefined);
    off();
    await flushAsync();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('listens on dsh:log with Tauri and forwards log entries', () => {
    let handler: ((ev: { payload: unknown }) => void) | undefined;
    const listen = vi.fn(async (_event: string, h: (ev: { payload: unknown }) => void) => {
      handler = h;
      return () => undefined;
    });
    vi.stubGlobal('window', {
      __TAURI__: { core: { invoke: vi.fn() }, event: { listen } },
    });

    const entries: Array<{ level: string; line: string }> = [];
    subscribeLog((entry) => entries.push(entry));
    expect(listen).toHaveBeenCalledWith('dsh:log', expect.any(Function));
    handler?.({ payload: { level: 'error', line: 'boom' } });
    expect(entries).toEqual([{ level: 'error', line: 'boom' }]);
  });
});
