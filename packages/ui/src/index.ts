export { DesktopRoot, readRootView } from './DesktopRoot.js';
export type { DesktopRootProps, RootView } from './DesktopRoot.js';
export { ErrorPanel } from './components/ErrorPanel.js';
export type { ErrorPanelProps } from './components/ErrorPanel.js';
export { SettingsView } from './components/SettingsView.js';
export type { SettingsViewProps } from './components/SettingsView.js';
export { StartupProgress } from './components/StartupProgress.js';
export type { StartupProgressProps } from './components/StartupProgress.js';
export {
  bridgeErrorMessage,
  getDesktopBridge,
  subscribeLog,
  subscribeState,
} from './bridge.js';
export type {
  BridgeLogEntry,
  ElectronPreloadApi,
  TauriEventLike,
  TauriGlobalLike,
  Unsubscribe,
} from './bridge.js';
export { useBridgeLogs, useHostStatus, DEFAULT_LOG_LINES } from './hooks.js';

// Contract re-exports: app code should import bridge types from here, keeping
// packages/protocol the only place that defines them.
export { BRIDGE_EVENTS, DESKTOP_BRIDGE_METHODS } from '@dsh-desktop/protocol';
export type {
  BridgeEvents,
  DesktopBridge,
  HostEndpoint,
  HostState,
  HostStatus,
  Profile,
} from '@dsh-desktop/protocol';
