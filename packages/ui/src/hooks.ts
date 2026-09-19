import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopBridge,
  DesktopSettings,
  HostStatus,
  InstalledPlugin,
} from '@dsh-desktop/protocol';
import { bridgeErrorMessage, subscribeLog, subscribeState } from './bridge.js';
import type { BridgeLogEntry, Unsubscribe } from './bridge.js';

export const DEFAULT_LOG_LINES = 50;

/**
 * Host status with both delivery paths wired: a one-shot `host_status()`
 * snapshot plus pushed `dsh:state` events. Events win over the snapshot —
 * once one arrives, an in-flight snapshot is stale and dropped.
 *
 * `bridge` may be null (no shell detected): the hook then just returns the
 * initial status and skips subscription, so callers can render a fallback UI.
 * `initialStatus` seeds the first render, before any async result lands.
 */
export function useHostStatus(bridge: DesktopBridge | null, initialStatus?: HostStatus): HostStatus {
  const [status, setStatus] = useState<HostStatus>(() => initialStatus ?? { state: 'starting' });
  useEffect(() => {
    if (bridge == null) return undefined;
    let alive = true;
    let eventSeen = false;
    let offState: Unsubscribe | undefined;
    try {
      offState = subscribeState((next) => {
        eventSeen = true;
        if (alive) setStatus(next);
      });
    } catch {
      // Shell without a subscribable bridge (e.g. plain-browser harness):
      // fall back to the snapshot only.
    }
    bridge
      .host_status()
      .then((snapshot) => {
        if (alive && !eventSeen) setStatus(snapshot);
      })
      .catch((err: unknown) => {
        if (alive && !eventSeen) setStatus({ state: 'error', error: bridgeErrorMessage(err) });
      });
    return () => {
      alive = false;
      offState?.();
    };
  }, [bridge]);
  return status;
}

/**
 * Ring of the last `maxLines` host log lines. Warn/error lines keep a
 * `[level]` prefix so the tail stays readable without color.
 */
export function useBridgeLogs(maxLines: number = DEFAULT_LOG_LINES): string[] {
  const cap = Math.max(1, Math.floor(maxLines));
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    let offLog: Unsubscribe | undefined;
    try {
      offLog = subscribeLog((entry: BridgeLogEntry) => {
        if (!alive) return;
        const line = entry.level === 'info' ? entry.line : `[${entry.level}] ${entry.line}`;
        setLogs((prev) => {
          const next = prev.length >= cap ? prev.slice(prev.length - cap + 1) : prev.slice();
          next.push(line);
          return next;
        });
      });
    } catch {
      // No subscribable shell; logs stay empty.
    }
    return () => {
      alive = false;
      offLog?.();
    };
  }, [cap]);
  return logs;
}

export type ShellSettingsSaveState = 'idle' | 'ok' | 'error';

export interface ShellSettingsController {
  /** Canonical settings, or null until the first settings_get resolves. */
  settings: DesktopSettings | null;
  loading: boolean;
  /** True while a settings_set round-trip is in flight (controls disabled). */
  saving: boolean;
  /** Latest load/save failure, human-readable; null when everything is fine. */
  error: string | null;
  /** Outcome of the most recent settings_set ('idle' before the first one). */
  lastSave: ShellSettingsSaveState;
  /** Persists a partial patch and adopts the platform-returned value. */
  update(patch: Partial<DesktopSettings>): Promise<void>;
}

/**
 * Shell preferences via settings_get/settings_set. The platform shell owns
 * validation + persistence + application; the hook only adopts the value
 * returned by settings_set (never a locally guessed merge). `initialSettings`
 * seeds the first render so SSR/embed callers can render real toggle states
 * before any bridge round-trip.
 */
export function useShellSettings(
  bridge: DesktopBridge,
  initialSettings?: DesktopSettings,
): ShellSettingsController {
  const [settings, setSettings] = useState<DesktopSettings | null>(() => initialSettings ?? null);
  const [loading, setLoading] = useState(() => initialSettings == null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSave, setLastSave] = useState<ShellSettingsSaveState>('idle');

  useEffect(() => {
    let alive = true;
    bridge
      .settings_get()
      .then((next) => {
        if (alive) {
          setSettings(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(bridgeErrorMessage(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const update = useCallback(
    async (patch: Partial<DesktopSettings>) => {
      setSaving(true);
      setError(null);
      setLastSave('idle');
      try {
        const next = await bridge.settings_set(patch);
        setSettings(next);
        setLastSave('ok');
      } catch (err: unknown) {
        setError(bridgeErrorMessage(err));
        setLastSave('error');
      } finally {
        setSaving(false);
      }
    },
    [bridge],
  );

  return { settings, loading, saving, error, lastSave, update };
}

export interface PluginListController {
  plugins: InstalledPlugin[];
  loading: boolean;
  /** True while an explicit rescan is in flight (initial load does not count). */
  rescanning: boolean;
  error: string | null;
  /** Re-runs plugin_list and replaces the inventory with its result. */
  rescan(): Promise<void>;
}

/**
 * Installed-plugin inventory via plugin_list, with an explicit rescan().
 * `initialPlugins` seeds the first render for SSR/embed callers.
 */
export function usePluginList(
  bridge: DesktopBridge,
  initialPlugins?: InstalledPlugin[],
): PluginListController {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>(() => initialPlugins ?? []);
  const [loading, setLoading] = useState(() => initialPlugins == null);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const list = await bridge.plugin_list();
    setPlugins(list);
  }, [bridge]);

  useEffect(() => {
    let alive = true;
    load()
      .catch((err: unknown) => {
        if (alive) setError(bridgeErrorMessage(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const rescan = useCallback(async () => {
    setRescanning(true);
    try {
      await load();
    } catch (err: unknown) {
      setError(bridgeErrorMessage(err));
    } finally {
      setRescanning(false);
    }
  }, [load]);

  return { plugins, loading, rescanning, error, rescan };
}
