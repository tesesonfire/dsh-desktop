/**
 * Tray — same menu structure as the Tauri implementation: show/hide main
 * window, open data directory, restart host, quit. Quit always goes through
 * the safe path (sidecar.stop() -> app.quit()) provided by the shell wiring.
 */
import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { appRootFromModuleUrl } from './config';

export interface TrayActions {
  showMainWindow: () => void;
  hideMainWindow: () => void;
  openDataDirectory: () => void;
  restartHost: () => void;
  quit: () => void;
}

export interface TrayController {
  destroy: () => void;
}

export interface CreateTrayOptions {
  actions: TrayActions;
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Absolute path to the 16x16 tray PNG; a sibling tray@2x.png is picked up automatically. */
  iconPath?: string;
  tooltip?: string;
}

export function defaultTrayIconPath(): string {
  return join(appRootFromModuleUrl(import.meta.url), 'assets', 'tray.png');
}

export function createTray(options: CreateTrayOptions): TrayController {
  const iconPath = options.iconPath ?? defaultTrayIconPath();
  const tooltip = options.tooltip ?? 'DSH Desktop (Electron)';
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // TODO(packaging): electron-builder.yml ships only dist/**, so assets/ is
    // missing inside asar. Either add assets/** to `files` or copy tray.png
    // under dist/ — until then packaged builds run trayless (everything else
    // keeps working).
    options.log('warn', `tray icon missing or unreadable at ${iconPath}; continuing without a tray`);
    return { destroy: () => undefined };
  }

  const tray = new Tray(icon);
  tray.setToolTip(tooltip);
  // Without a context menu a bare tray click would do nothing on some platforms.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show main window', click: () => options.actions.showMainWindow() },
      { label: 'Hide main window', click: () => options.actions.hideMainWindow() },
      { type: 'separator' },
      { label: 'Open data directory', click: () => options.actions.openDataDirectory() },
      { label: 'Restart host', click: () => options.actions.restartHost() },
      { type: 'separator' },
      // Safe exit path: the wiring behind actions.quit stops the sidecar
      // before app.quit() so the host process tree never orphans.
      { label: 'Quit', click: () => options.actions.quit() },
    ]),
  );
  tray.on('click', () => options.actions.showMainWindow());

  return {
    destroy: () => {
      try {
        tray.destroy();
      } catch {
        // double-destroy is fine during teardown
      }
    },
  };
}
