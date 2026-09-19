import { useEffect, useState } from 'react';
import type { DesktopBridge, HostStatus } from '@dsh-desktop/protocol';
import { getDesktopBridge } from './bridge.js';
import { ErrorPanel } from './components/ErrorPanel.js';
import { SettingsView } from './components/SettingsView.js';
import { StartupProgress } from './components/StartupProgress.js';
import { useBridgeLogs, useHostStatus } from './hooks.js';

export type RootView = 'startup' | 'settings';

/**
 * View routing without a router: the shell opens the settings window as the
 * same bundle loaded with `#settings` (or `?view=settings`).
 */
export function readRootView(): RootView {
  if (typeof location === 'undefined') return 'startup';
  if (location.hash === '#settings') return 'settings';
  if (location.search.includes('view=settings')) return 'settings';
  return 'startup';
}

export interface DesktopRootProps {
  /** Test/embed seam — bypasses getDesktopBridge() when provided. */
  bridge?: DesktopBridge;
  /** Test/embed seam — status rendered before the first host_status() resolves. */
  initialStatus?: HostStatus;
}

/**
 * Shared application root for both platform shells. Assumption baked into the
 * `running` UI: once the host reports running, the shell navigates the ENTIRE
 * window to the Host URL (ready-line URL with its token), so this component
 * only shows a short hand-off note and never tries to embed the web UI itself.
 */
export function DesktopRoot({ bridge: bridgeProp, initialStatus }: DesktopRootProps) {
  // Captured once per mount; the test seam is not expected to change identity.
  const [bridge] = useState<DesktopBridge | null>(() => bridgeProp ?? tryGetDesktopBridge());
  const status = useHostStatus(bridge, initialStatus);
  const logs = useBridgeLogs();
  const [view, setView] = useState<RootView>(readRootView);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onHashChange = () => setView(readRootView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (bridge == null) {
    return (
      <div className="dsh-root">
        <ErrorPanel
          title="无法连接桌面壳 / Desktop shell not found"
          message="未检测到 window.dshDesktop（Electron）或 window.__TAURI__（Tauri）。此界面必须由 DSH Desktop 平台壳加载。 / Neither window.dshDesktop (Electron) nor window.__TAURI__ (Tauri) was detected; this UI must be loaded by the DSH Desktop shell."
        />
      </div>
    );
  }

  return (
    <div className="dsh-root">
      {view === 'settings' ? (
        <SettingsView bridge={bridge} />
      ) : (
        <StartupProgress bridge={bridge} status={status} logs={logs} />
      )}
    </div>
  );
}

function tryGetDesktopBridge(): DesktopBridge | null {
  try {
    return getDesktopBridge();
  } catch {
    // No platform shell (plain browser / broken preload) — render the fallback.
    return null;
  }
}
