import type { DesktopBridge, HostStatus } from '@dsh-desktop/protocol';

/**
 * Test double for DesktopBridge. The spread of a Partial makes overridden
 * members optional in the inferred type, so the result asserts the full
 * interface once — this is the only sanctioned cast in the test suite.
 */
export function makeFakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    host_start: async () => ({ port: 3080, url: 'http://127.0.0.1:3080/?token=test' }),
    host_stop: async () => undefined,
    host_restart: async () => ({ port: 3080, url: 'http://127.0.0.1:3080/?token=test' }),
    host_status: async (): Promise<HostStatus> => ({ state: 'stopped' }),
    window_show: async () => undefined,
    window_hide: async () => undefined,
    window_focus: async () => undefined,
    window_open_settings: async () => undefined,
    profile_list: async () => [
      { name: 'web', path: '/home/user/.dsh/profiles/web', bundles: ['dsh-web-app'] },
      { name: 'dsh-desktop-tauri', path: '/home/user/.dsh/profiles/dsh-desktop-tauri', bundles: ['dsh-web-app'] },
    ],
    profile_current: async () => ({
      name: 'web',
      path: '/home/user/.dsh/profiles/web',
      bundles: ['dsh-web-app'],
    }),
    profile_switch: async () => undefined,
    open_data_dir: async () => undefined,
    open_external: async () => undefined,
    get_app_version: async () => '0.1.0',
    ...overrides,
  } as DesktopBridge;
}

/** Flushes pending microtasks/timers (used for Tauri listen() resolution). */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
