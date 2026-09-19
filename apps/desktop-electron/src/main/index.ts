/**
 * Electron entry point. Startup order and lifecycle phases:
 *
 *   shell-environment -> control-server -> profile-resolution -> host-spawn
 *   -> renderer-startup -> health-commit
 *
 * Every phase transition is written to the log. A sidecar failure lands in the
 * state machine (HostStatus.error) — the shell keeps running so the renderer
 * can surface it; only a missing profile environment is fatal.
 */
import { app, dialog, shell } from 'electron';
import type { ControlHello } from '@dsh-desktop/protocol';
import { ControlServer } from './control-server';
import { appRootFromModuleUrl, resolveDesktopPaths, type DshDesktopPaths } from './config';
import { log } from './log';
import { Launcher } from './launcher';
import { isSmokeMode, startSmokeWatch } from './smoke';
import { registerDesktopBridgeIpc } from './ipc';
import { openSettingsWindow } from './settings';
import { DshSidecar } from './sidecar';
import { ShellGeneration, preloadPathFromAppRoot, rendererIndexFromAppRoot } from './shell';

const LIFECYCLE_PHASES = [
  'shell-environment',
  'control-server',
  'profile-resolution',
  'host-spawn',
  'renderer-startup',
  'health-commit',
] as const;

type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

let currentPhase: LifecyclePhase = 'shell-environment';

function enterPhase(next: LifecyclePhase): void {
  currentPhase = next;
  log.info(`lifecycle phase -> ${next}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

let generation: ShellGeneration | null = null;
let sidecar: DshSidecar | null = null;
let controlServer: ControlServer | null = null;
let launcher: Launcher | null = null;
let quitting = false;

async function shutdownAndExit(exitCode: number): Promise<void> {
  quitting = true;
  generation?.release();
  generation = null;
  try {
    await sidecar?.stop();
  } catch (error) {
    log.error(`sidecar stop during shutdown failed: ${errorText(error)}`);
  }
  sidecar = null;
  try {
    await controlServer?.stop();
  } catch {
    // control server teardown must not block exit
  }
  controlServer = null;
  log.close();
  app.exit(exitCode);
}

/**
 * electron-updater wiring. The feed URL is opt-in via DSH_UPDATE_URL because
 * there is nothing to update from by default.
 *
 * TODO(release-infra): no published release feed exists, so this path cannot
 * be verified on this machine (autoUpdater needs a signed, published artifact).
 */
async function checkForUpdates(): Promise<void> {
  const feedUrl = process.env['DSH_UPDATE_URL'];
  if (feedUrl === undefined || feedUrl.length === 0) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    const result = await autoUpdater.checkForUpdates();
    log.info(`update check finished: ${result?.updateInfo?.version ?? 'no info'}`);
  } catch (error) {
    log.error(`update check failed: ${errorText(error)}`);
  }
}

async function bootstrap(): Promise<void> {
  const paths: DshDesktopPaths = resolveDesktopPaths(app.getPath('userData'));
  log.init(paths.logs);
  enterPhase('shell-environment');
  log.info(`dsh-desktop electron starting (pid ${String(process.pid)}); userData=${paths.userData} dshHome=${paths.dshHome}`);
  const appRoot = appRootFromModuleUrl(import.meta.url);
  const preloadPath = preloadPathFromAppRoot(appRoot);

  enterPhase('control-server');
  controlServer = new ControlServer();
  await controlServer.start({
    onHello: (hello: ControlHello) => {
      log.info(`host hello: pid=${String(hello.pid)} webPort=${String(hello.webPort)} profile=${hello.profile}`);
    },
    currentProfile: () => {
      try {
        return launcher?.getCurrentProfile() ?? null;
      } catch {
        return null;
      }
    },
    attach: (url) => {
      const gen = generation;
      if (gen === null) return;
      void gen.attach(url).catch((error: unknown) => {
        log.error(`webview attach failed: ${errorText(error)}`);
      });
    },
    stopHost: async () => {
      await sidecar?.stop();
    },
    restartHost: async () => {
      const active = sidecar;
      if (active === null) throw new Error('sidecar not created yet');
      return active.restart();
    },
  });
  log.info(`control server listening at ${controlServer.url}`);

  enterPhase('profile-resolution');
  launcher = new Launcher({
    dshHome: paths.dshHome,
    userDataDir: paths.userData,
    log: (level, line) => log[level](line),
  });
  let profileName: string;
  try {
    profileName = launcher.getCurrentProfile().name;
  } catch (error) {
    log.error(`profile resolution failed: ${errorText(error)}`);
    dialog.showErrorBox('DSH Desktop', error instanceof Error ? error.message : String(error));
    await shutdownAndExit(1);
    return;
  }
  log.info(`resolved profile: ${profileName}`);

  /**
   * Shell-side attach used for the ready URL. Marking the control server keeps
   * webviewAttached a single source of truth (the plugin's POST /v0/webview/
   * attach route flips the same flag). Declared before the sidecar exists —
   * the ready event can fire while spawn() is still awaited.
   */
  const attachReadyUrl = async (url: string): Promise<void> => {
    const gen = generation;
    if (gen === null) return;
    await gen.attach(url);
    controlServer?.markAttached();
  };

  enterPhase('host-spawn');
  sidecar = new DshSidecar({
    profile: profileName,
    dshHome: paths.dshHome,
    controlUrl: controlServer.url,
    controlToken: controlServer.token,
    log: (level, line) => log[level](line),
  });
  launcher.setSidecar(sidecar);
  sidecar.on('state', (status) => {
    if (status.state === 'running') launcher?.recordHealthy(profileName);
  });
  sidecar.on('ready', ({ url, origin }) => {
    controlServer?.setReadyOrigin(origin);
    generation?.setReadyOrigin(origin);
    void attachReadyUrl(url).catch((error: unknown) => {
      log.error(`webview attach failed: ${errorText(error)}`);
    });
  });
  // A failed spawn rejects the promise but keeps the app alive: the error is
  // in the state machine (dsh:state) and the renderer shows it.
  await sidecar.spawn().catch((error: unknown) => {
    log.error(`host spawn failed: ${errorText(error)}`);
  });

  enterPhase('renderer-startup');
  generation = new ShellGeneration({
    preloadPath,
    indexHtmlPath: rendererIndexFromAppRoot(appRoot),
    windowStateFile: paths.windowStateFile,
    trayActions: {
      showMainWindow: () => generation?.show(),
      hideMainWindow: () => generation?.hide(),
      openDataDirectory: () => {
        void shell.openPath(paths.userData);
      },
      restartHost: () => {
        void sidecar?.restart().catch((error: unknown) => {
          log.error(`tray host restart failed: ${errorText(error)}`);
        });
      },
      quit: () => app.quit(),
    },
    onWindowCloseRequest: () => {
      // The plugin long-polls /v0/events; window-close is its signal.
      controlServer?.enqueueEvent({ type: 'window-close' });
    },
    isQuitting: () => quitting,
    log: (level, line) => log[level](line),
  });
  generation.mount();
  registerDesktopBridgeIpc({
    sidecar,
    generation,
    launcher,
    userDataDir: paths.userData,
    log: (level, line) => log[level](line),
    logOnLine: (subscriber) => log.onLine(subscriber),
    openSettings: () =>
      openSettingsWindow({ preloadPath, appRoot, log: (level, line) => log[level](line) }),
  });

  // The ready line may have arrived before the window existed.
  const endpoint = sidecar.endpoint();
  if (endpoint !== null) {
    const origin = `http://127.0.0.1:${String(endpoint.port)}`;
    controlServer.setReadyOrigin(origin);
    generation.setReadyOrigin(origin);
    await attachReadyUrl(endpoint.url).catch((error: unknown) => {
      log.error(`webview attach failed: ${errorText(error)}`);
    });
  }

  enterPhase('health-commit');
  if (sidecar.state === 'running') {
    launcher.recordHealthy(profileName);
  }
  void checkForUpdates();

  if (isSmokeMode()) {
    log.info(`smoke mode active; report -> ${paths.smokeReportFile}`);
    startSmokeWatch({
      profile: profileName,
      outPath: paths.smokeReportFile,
      sidecarStatus: () => sidecar?.status ?? { state: 'stopped' },
      sidecarPid: () => sidecar?.pid,
      helloSeen: () => controlServer?.helloSeen ?? false,
      webviewAttached: () => controlServer?.webviewAttached ?? false,
      onFinish: (_report, exitCode) => {
        void shutdownAndExit(exitCode);
      },
    });
  }
  log.info('bootstrap complete');
}

// --- single instance ---------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    generation?.show();
  });
  app.on('activate', () => {
    generation?.show();
  });
  // The app lives in the tray; closing the last window must not quit it.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    // Release the shell first so close-to-tray cannot block the quit, then
    // stop the host tree before the process actually exits.
    generation?.release();
    event.preventDefault();
    void shutdownAndExit(0);
  });

  process.on('uncaughtException', (error) => {
    log.error(`uncaughtException: ${errorText(error)}`);
    try {
      dialog.showErrorBox('DSH Desktop — unexpected error', error.message);
    } catch {
      // headless environments have no dialog; the log entry is the record
    }
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${errorText(reason)}`);
  });

  void app.whenReady().then(() => {
    bootstrap().catch((error: unknown) => {
      log.error(`bootstrap failed in phase ${currentPhase}: ${errorText(error)}`);
      try {
        dialog.showErrorBox('DSH Desktop — startup failed', error instanceof Error ? error.message : String(error));
      } catch {
        // no dialog available
      }
      void shutdownAndExit(1);
    });
  });
}
