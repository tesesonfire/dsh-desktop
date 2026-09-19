/**
 * DSH_SMOKE contract — exercised by scripts/smoke-clean-boot.mjs.
 *
 * With DSH_SMOKE=1 the app boots through the REAL window/tray/sidecar path and
 * additionally waits for three conditions:
 *   (a) sidecar state=running with a ready URL
 *   (b) helloSeen on the control server
 *   (c) webviewAttached
 * then writes a JSON report to DSH_SMOKE_OUT (default <userData>/smoke-report.json)
 * and exits 0. After 90s the same-shaped report with `errors` and exit 1.
 *
 * `pid` in the report is the DSH host process pid — the smoke runner already
 * knows the Electron pid it spawned, while the host pid is the one that can
 * orphan and is therefore the useful one to publish.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SmokeReport {
  framework: 'electron';
  profile: string;
  pid: number;
  readyLine: { port: number; url: string } | null;
  helloReceived: boolean;
  webviewAttached: boolean;
  settings: { closeToTray: boolean; startMinimized: boolean; zoomFactor: number };
  errors: string[];
}

export const SMOKE_TIMEOUT_MS = 90_000;
export const SMOKE_POLL_INTERVAL_MS = 250;

export function isSmokeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DSH_SMOKE'] === '1';
}

export function writeSmokeReport(outPath: string, report: SmokeReport): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export interface SmokeWatchOptions {
  profile: string;
  outPath: string;
  onFinish: (report: SmokeReport, exitCode: number) => void;
  /** Narrow surface for testability. */
  sidecarStatus: () => { state: string; port?: number; url?: string; error?: string };
  sidecarPid: () => number | undefined;
  helloSeen: () => boolean;
  webviewAttached: () => boolean;
  settings: () => { closeToTray: boolean; startMinimized: boolean; zoomFactor: number };
  /** DSH_SMOKE_EXPECT=error: finish(0) once the sidecar lands in error state. */
  expectError?: boolean;
}

export interface SmokeWatch {
  stop: () => void;
}

export function startSmokeWatch(options: SmokeWatchOptions): SmokeWatch {
  const errorsSeen = new Set<string>();
  let finished = false;

  const finish = (report: SmokeReport, exitCode: number): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try {
      writeSmokeReport(options.outPath, report);
    } catch (error) {
      // The report write itself failing must still surface to the runner.
      console.error('[smoke] failed to write report:', error);
    }
    options.onFinish(report, exitCode);
  };

  const buildReport = (): SmokeReport => {
    const status = options.sidecarStatus();
    const pid = options.sidecarPid();
    const readyOk = status.state === 'running' && typeof status.url === 'string' && typeof status.port === 'number';
    return {
      framework: 'electron',
      profile: options.profile,
      pid: pid === undefined ? -1 : pid,
      readyLine: readyOk && status.port !== undefined && status.url !== undefined
        ? { port: status.port, url: status.url }
        : null,
      helloReceived: options.helloSeen(),
      webviewAttached: options.webviewAttached(),
      settings: options.settings(),
      errors: [...errorsSeen],
    };
  };

  const startTime = Date.now();

  const timer = setInterval(() => {
    const status = options.sidecarStatus();
    if (typeof status.error === 'string' && status.error.length > 0) {
      errorsSeen.add(status.error);
    }
    const readyOk = status.state === 'running' && typeof status.url === 'string' && typeof status.port === 'number';
    const helloOk = options.helloSeen();
    const attachOk = options.webviewAttached();

    if (options.expectError === true && status.state === 'error') {
      finish(buildReport(), 0);
      return;
    }
    if (readyOk && helloOk && attachOk) {
      finish(buildReport(), 0);
      return;
    }
    if (Date.now() - startTime >= SMOKE_TIMEOUT_MS) {
      const unmet: string[] = [];
      if (!readyOk) unmet.push('sidecar running with ready URL');
      if (!helloOk) unmet.push('control hello received');
      if (!attachOk) unmet.push('webview attached');
      errorsSeen.add(`smoke timeout after ${String(SMOKE_TIMEOUT_MS)}ms; unmet: ${unmet.join(', ')}`);
      finish(buildReport(), 1);
    }
  }, SMOKE_POLL_INTERVAL_MS);

  return {
    stop: () => {
      finished = true;
      clearInterval(timer);
    },
  };
}
