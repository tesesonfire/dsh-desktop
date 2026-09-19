/**
 * ShellGeneration — owns exactly one generation of native shell surfaces
 * (main BrowserWindow + tray) with the navigation fence:
 *
 *  - will-frame-navigate / will-redirect allow ONLY the ready-line origin
 *    (origin equality via protocol isSameOrigin); before the ready line only
 *    the local renderer surface (file: or the dev-server origin) is allowed.
 *  - setWindowOpenHandler always denies; http/https/mailto go to the OS via
 *    shell.openExternal.
 *  - window close hides to tray (enqueuing a window-close control event) and
 *    window state (bounds + maximized) is debounced-persisted.
 *
 * release() is idempotent: destroys the tray, removes every listener and
 * destroys the windows, so a stale generation cannot leak native handles.
 */
import { BrowserWindow, screen, shell } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSameOrigin } from '@dsh-desktop/protocol';
import { createTray, type TrayActions, type TrayController } from './tray';

export const WINDOW_STATE_WRITE_DELAY_MS = 250;

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export function defaultWindowState(): WindowState {
  return { width: 1280, height: 800, maximized: false };
}

export function readWindowStateFile(file: string): WindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null;
    return {
      width: parsed.width,
      height: parsed.height,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      maximized: parsed.maximized === true,
    };
  } catch {
    return null;
  }
}

export function writeWindowStateFile(file: string, state: WindowState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Keep restored bounds on some display's work area. */
export function clampToWorkArea(state: WindowState): WindowState {
  try {
    const bounds = { x: state.x ?? 0, y: state.y ?? 0, width: state.width, height: state.height };
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(state.width, workArea.width);
    const height = Math.min(state.height, workArea.height);
    const x = state.x === undefined ? undefined : Math.max(workArea.x, Math.min(state.x, workArea.x + workArea.width - width));
    const y = state.y === undefined ? undefined : Math.max(workArea.y, Math.min(state.y, workArea.y + workArea.height - height));
    return { width, height, x, y, maximized: state.maximized };
  } catch {
    return state;
  }
}

export interface ShellGenerationOptions {
  preloadPath: string;
  /** dist/renderer/index.html — loaded as file: until attach() swaps in the host URL. */
  indexHtmlPath: string;
  windowStateFile: string;
  trayActions: TrayActions;
  /** Fired when the main window is closed by the user (hidden to tray). */
  onWindowCloseRequest: () => void;
  isQuitting: () => boolean;
  log: (level: 'info' | 'warn' | 'error', line: string) => void;
}

export class ShellGeneration {
  private window: BrowserWindow | null = null;
  private tray: TrayController | null = null;
  private released = false;
  private mounted = false;
  private readyOrigin: string | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  /** The local renderer load; attach() waits for it to avoid aborted navigations. */
  private localLoad: Promise<void> = Promise.resolve();

  constructor(private readonly options: ShellGenerationOptions) {}

  get isMounted(): boolean {
    return this.mounted;
  }

  getMainWindow(): BrowserWindow | null {
    const win = this.window;
    return win !== null && !win.isDestroyed() ? win : null;
  }

  /** The fence opens for the ready-line origin once the host reported ready. */
  setReadyOrigin(origin: string): void {
    this.readyOrigin = origin;
  }

  mount(): BrowserWindow {
    if (this.mounted || this.window !== null) {
      throw new Error('shell generation is already mounted');
    }
    const restored = readWindowStateFile(this.options.windowStateFile) ?? defaultWindowState();
    const clamped = clampToWorkArea(restored);
    const win = new BrowserWindow({
      width: clamped.width,
      height: clamped.height,
      ...(clamped.x !== undefined && clamped.y !== undefined ? { x: clamped.x, y: clamped.y } : {}),
      minWidth: 960,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      title: 'DSH Desktop (Electron)',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        partition: 'persist:dsh-desktop-renderer',
      },
    });
    if (restored.maximized) win.maximize();
    this.window = win;
    this.mounted = true;

    win.on('move', () => this.schedulePersistWindowState());
    win.on('resize', () => this.schedulePersistWindowState());
    win.on('close', (event) => {
      this.persistWindowState();
      if (this.options.isQuitting()) return;
      // Close-to-tray; the plugin learns about it through the control channel.
      event.preventDefault();
      win.hide();
      this.options.onWindowCloseRequest();
    });
    win.webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) return;
      if (!this.isNavigationAllowed(event.url)) event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (!this.isNavigationAllowed(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((error: unknown) => {
            this.options.log('warn', `failed to open external link: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } catch {
        // malformed target is simply denied
      }
      return { action: 'deny' };
    });

    this.tray = createTray({ actions: this.options.trayActions, log: this.options.log });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !this.released) win.show();
    });
    this.localLoad = win
      .loadFile(this.options.indexHtmlPath)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!this.released && !win.isDestroyed()) {
          this.options.log('error', `renderer load failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return win;
  }

  private isNavigationAllowed(url: string): boolean {
    if (this.readyOrigin !== null && isSameOrigin(url, this.readyOrigin)) return true;
    // Before ready: only the local renderer surface. file: URLs are local by
    // definition; a dev-server origin may be announced via DSH_RENDERER_DEV_URL.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') return true;
      const devUrl = process.env['DSH_RENDERER_DEV_URL'];
      if (devUrl !== undefined && devUrl.length > 0) {
        try {
          if (parsed.origin === new URL(devUrl).origin) return true;
        } catch {
          // invalid DSH_RENDERER_DEV_URL; ignore
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private schedulePersistWindowState(): void {
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.persistWindowState();
    }, WINDOW_STATE_WRITE_DELAY_MS);
    this.stateTimer.unref();
  }

  private persistWindowState(): void {
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    const win = this.window;
    if (win === null || win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
    try {
      writeWindowStateFile(this.options.windowStateFile, state);
    } catch (error) {
      this.options.log('warn', `failed to save window state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  show(): void {
    const win = this.window;
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  hide(): void {
    const win = this.window;
    if (win === null || win.isDestroyed()) return;
    win.hide();
  }

  focus(): void {
    const win = this.window;
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /** Swap the main window onto a host URL; only ready-line origins pass. */
  async attach(url: string): Promise<void> {
    if (this.readyOrigin === null || !isSameOrigin(url, this.readyOrigin)) {
      throw new Error(`attach rejected: ${url} is not same-origin with the ready line`);
    }
    const win = this.window;
    if (win === null || win.isDestroyed()) throw new Error('attach rejected: main window is not mounted');
    // Never race the local renderer load (two navigations abort each other).
    await this.localLoad;
    if (win.isDestroyed()) throw new Error('attach rejected: main window destroyed during local load');
    await win.loadURL(url);
  }

  /** Idempotent teardown: tray, listeners, timers, windows. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.tray?.destroy();
    this.tray = null;
    const win = this.window;
    this.window = null;
    this.mounted = false;
    if (win === null) return;
    if (!win.isDestroyed()) {
      // Removing all listeners first also drops the close-to-tray handler, so
      // destroy() cannot be blocked by our own preventDefault.
      win.removeAllListeners();
      if (!win.webContents.isDestroyed()) {
        win.webContents.removeAllListeners();
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      }
      win.destroy();
    }
  }
}

/** Absolute path of the packaged preload bundle (dist/preload/index.cjs). */
export function preloadPathFromAppRoot(appRoot: string): string {
  return join(appRoot, 'dist', 'preload', 'index.cjs');
}

/** Absolute path of the built renderer entry (dist/renderer/index.html). */
export function rendererIndexFromAppRoot(appRoot: string): string {
  return join(appRoot, 'dist', 'renderer', 'index.html');
}
