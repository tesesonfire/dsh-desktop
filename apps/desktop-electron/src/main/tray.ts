/**
 * Tray v2 — three-group structure aligned with the official desktop runtime:
 * window group, profiles group (radio switch), tools group (terminal,
 * diagnostics, restart, data dir). The tooltip tracks host state. Menus are
 * rebuilt on demand via update() so profile and host state changes surface.
 */
import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { appRootFromModuleUrl } from './config';
import type { HostState, Profile } from '@dsh-desktop/protocol';

export interface TrayActions {
  showMainWindow: () => void;
  hideMainWindow: () => void;
  openDataDirectory: () => void;
  restartHost: () => void;
  quit: () => void;
  /** v2 additions — all optional so tests can build minimal trays. */
  openTerminal?: () => void;
  exportDiagnostics?: () => void;
  listProfiles?: () => Profile[];
  currentProfile?: () => string | null;
  switchProfile?: (name: string) => void;
}

export interface TrayController {
  destroy: () => void;
  /** Refresh tooltip + rebuild the context menu from current state. */
  update: (snapshot: { hostState: HostState; port?: number; profiles?: Profile[]; currentProfile?: string | null }) => void;
}

export interface CreateTrayOptions {
  actions: TrayActions;
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Absolute path to the 16x16 tray PNG; a sibling tray@2x.png is picked up automatically. */
  iconPath?: string;
  tooltip?: string;
}

const HOST_STATE_LABELS: Record<HostState, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  error: '错误',
};

export function hostTooltip(state: HostState, port: number | undefined, base = 'DSH Desktop (Electron)'): string {
  const portText = port === undefined ? '' : ` :${String(port)}`;
  return `${base} — Host ${HOST_STATE_LABELS[state]}${portText}`;
}

export function defaultTrayIconPath(): string {
  return join(appRootFromModuleUrl(import.meta.url), 'assets', 'tray.png');
}

export function createTray(options: CreateTrayOptions): TrayController {
  const iconPath = options.iconPath ?? defaultTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // TODO(packaging): electron-builder.yml ships only dist/**, so assets/ is
    // missing inside asar. Either add assets/** to `files` or copy tray.png
    // under dist/ — until then packaged builds run trayless (everything else
    // keeps working).
    options.log('warn', `tray icon missing or unreadable at ${iconPath}; continuing without a tray`);
    return { destroy: () => undefined, update: () => undefined };
  }

  const tray = new Tray(icon);
  let lastSnapshot: { hostState: HostState; port?: number } = { hostState: 'stopped' };
  tray.setToolTip(hostTooltip(lastSnapshot.hostState, lastSnapshot.port, options.tooltip));

  const rebuildMenu = (): void => {
    const profiles = options.actions.listProfiles?.() ?? [];
    const current = options.actions.currentProfile?.() ?? null;
    const profileItems: Electron.MenuItemConstructorOptions[] = profiles
      .slice(0, 10)
      .map((profile) => ({
        label: profile.name,
        type: 'radio',
        checked: profile.name === current,
        click: () => options.actions.switchProfile?.(profile.name),
      }));

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '显示主窗口', click: () => options.actions.showMainWindow() },
      { label: '隐藏主窗口', click: () => options.actions.hideMainWindow() },
      { type: 'separator' },
      ...(profileItems.length > 0
        ? [{ label: 'Profile', submenu: profileItems } satisfies Electron.MenuItemConstructorOptions]
        : []),
      { label: '打开数据目录', click: () => options.actions.openDataDirectory() },
      ...(options.actions.openTerminal !== undefined
        ? [{ label: '打开终端', click: () => options.actions.openTerminal?.() } satisfies Electron.MenuItemConstructorOptions]
        : []),
      { label: '重启 Host', click: () => options.actions.restartHost() },
      ...(options.actions.exportDiagnostics !== undefined
        ? [{ label: '导出诊断', click: () => options.actions.exportDiagnostics?.() } satisfies Electron.MenuItemConstructorOptions]
        : []),
      { type: 'separator' },
      // Safe exit path: the wiring behind actions.quit stops the sidecar
      // before app.quit() so the host process tree never orphans.
      { label: '退出', click: () => options.actions.quit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  rebuildMenu();
  // With a context menu set, Windows opens it on click; macOS fires 'click'
  // for showing the window. Rebuilding on right-click keeps profiles fresh.
  tray.on('click', () => options.actions.showMainWindow());

  return {
    destroy: () => {
      try {
        tray.destroy();
      } catch {
        // double-destroy is fine during teardown
      }
    },
    update: (snapshot) => {
      lastSnapshot = { hostState: snapshot.hostState, port: snapshot.port };
      tray.setToolTip(hostTooltip(lastSnapshot.hostState, lastSnapshot.port, options.tooltip));
      rebuildMenu();
    },
  };
}
