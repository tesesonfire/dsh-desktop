/**
 * Settings window — a second BrowserWindow on the same hardened webPreferences
 * and the same preload, loading dist/renderer/index.html#settings.
 *
 * Unlike the main window there is no ready-line origin to open up: navigation
 * away from the local settings surface is refused entirely.
 */
import { BrowserWindow, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { appRootFromModuleUrl } from './config';
import { rendererIndexFromAppRoot } from './shell';

export interface SettingsWindowOptions {
  preloadPath: string;
  appRoot?: string;
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
}

let settingsWindow: BrowserWindow | null = null;

export function openSettingsWindow(options: SettingsWindowOptions): void {
  const existing = settingsWindow;
  if (existing !== null && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  const appRoot = options.appRoot ?? appRootFromModuleUrl(import.meta.url);
  const indexHtmlPath = rendererIndexFromAppRoot(appRoot);
  const expectedUrl = pathToFileURL(indexHtmlPath).href;

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 480,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    title: 'DSH Desktop Settings',
    parent: undefined,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      partition: 'persist:dsh-desktop-renderer',
    },
  });
  settingsWindow = win;

  // The settings surface is a terminal destination: no redirects, no links out
  // (http/https/mailto still go to the OS like everywhere else), no window.open.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === expectedUrl || url.startsWith(`${expectedUrl}#`)) return;
    event.preventDefault();
    options.log('warn', `settings window refused navigation to ${url}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === 'mailto:') {
        void shell.openExternal(target.href).catch(() => undefined);
      }
    } catch {
      // deny malformed targets
    }
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });

  void win.loadFile(indexHtmlPath, { hash: 'settings' }).catch((error: unknown) => {
    options.log('error', `settings renderer load failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
