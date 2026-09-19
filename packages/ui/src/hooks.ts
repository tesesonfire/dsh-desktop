import { useEffect, useState } from 'react';
import type { DesktopBridge, HostStatus } from '@dsh-desktop/protocol';
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
