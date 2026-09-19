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
import { isSameOrigin, DESKTOP_ZOOM_MAX, DESKTOP_ZOOM_MIN, type DesktopSettings, type Profile } from '@dsh-desktop/protocol';
import { createTray, type TrayActions, type TrayController } from './tray';

export const WINDOW_STATE_WRITE_DELAY_MS = 250;

export const ZOOM_STEP = 0.1;

/** Pure zoom math for Ctrl+= / Ctrl+- / Ctrl+0 shortcuts (unit-tested). */
export function applyZoomStep(current: number, key: '+' | '-' | '0', baseZoom: number): number {
  if (key === '0') return baseZoom;
  const next = key === '+' ? current + ZOOM_STEP : current - ZOOM_STEP;
  return Math.min(DESKTOP_ZOOM_MAX, Math.max(DESKTOP_ZOOM_MIN, Number(next.toFixed(2))));
}

/**
 * Pure navigation fence, shared by the main window and unit tests.
 *
 * After the ready line: ONLY the ready origin (origin equality — the token
 * query must survive, so the fence is origin-level, not prefix-level).
 * Before it: only the local renderer surface (file: or an explicit dev-server
 * origin via DSH_RENDERER_DEV_URL). Anything else — including file: after
 * ready — is denied.
 */
export function navigationAllowed(url: string, readyOrigin: string | null, devUrl?: string): boolean {
  if (readyOrigin !== null) return isSameOrigin(url, readyOrigin);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    if (devUrl !== undefined && devUrl.length > 0) {
      try {
        if (parsed.origin === new URL(devUrl).origin) return true;
      } catch {
        // invalid devUrl; ignore
      }
    }
  } catch {
    return false;
  }
  return false;
}

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
  /** Fired when the user closes the window and closeToTray is off (→ quit). */
  onQuitRequested: () => void;
  isQuitting: () => boolean;
  /** Live settings snapshot (close-to-tray, start-minimized, zoom). */
  settings: () => DesktopSettings;
  /** Persist a zoom change made via keyboard shortcuts. */
  onZoomChange?: (zoomFactor: number) => void;
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

  /** Apply a zoom change from settings_set to the live webContents. */
  setZoom(zoomFactor: number): void {
    const win = this.getMainWindow();
    if (win === null) return;
    win.webContents.setZoomFactor(zoomFactor);
  }

  /** Push host/profile state to the tray menu (no-op without a tray). */
  updateTray(snapshot: { hostState: Parameters<TrayController['update']>[0]['hostState']; port?: number; profiles?: Profile[]; currentProfile?: string | null }): void {
    this.tray?.update(snapshot);
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

    const closeToTray = (): boolean => this.options.settings().closeToTray;
    const startMinimized = this.options.settings().startMinimized;

    win.on('move', () => this.schedulePersistWindowState());
    win.on('resize', () => this.schedulePersistWindowState());
    win.on('close', (event) => {
      this.persistWindowState();
      if (this.options.isQuitting()) return;
      if (closeToTray()) {
        // Close-to-tray; the plugin learns about it through the control channel.
        event.preventDefault();
        win.hide();
        this.options.onWindowCloseRequest();
        return;
      }
      // User opted out of close-to-tray: closing the last window quits.
      this.options.onQuitRequested();
    });
    // Zoom shortcuts (Ctrl/⌘ + =, -, 0); persisted via onZoomChange.
    win.webContents.on('before-input-event', (event, input) => {
      if (!(input.control || input.meta) || input.type !== 'keyDown') return;
      const key = input.key;
      if (key !== '=' && key !== '+' && key !== '-' && key !== '0') return;
      const current = win.webContents.getZoomFactor();
      const next = applyZoomStep(current, key === '=' || key === '+' ? '+' : key === '-' ? '-' : '0', this.options.settings().zoomFactor);
      win.webContents.setZoomFactor(next);
      this.options.onZoomChange?.(next);
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
      if (startMinimized) return; // tray-only start (user setting)
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
    return navigationAllowed(url, this.readyOrigin, process.env['DSH_RENDERER_DEV_URL']);
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
    // Zoom carries over to the host page for the same webContents.
    win.webContents.setZoomFactor(this.options.settings().zoomFactor);
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
