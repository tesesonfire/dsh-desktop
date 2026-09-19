/**
 * DshSidecar — spawns and supervises the `dsh` host process.
 *
 * Ready-line contract (deepseek-harness ddefc45f, locked by the official e2e):
 * the sidecar never parses the line itself; it uses parseReadyLine from
 * @dsh-desktop/protocol so shell, mock and tests share one regex.
 *
 * DSH_BIN resolution contract (shared verbatim with the Tauri implementation):
 *   - DSH_BIN set:
 *     * *.mjs / *.cjs / *.js  -> command=process.execPath, args=[path], env ELECTRON_RUN_AS_NODE=1
 *     * *.cmd / *.bat (win32) -> command=cmd.exe, args=['/d','/s','/c', path]
 *     * otherwise             -> command=path, args=[]
 *   - DSH_BIN unset: search every PATH directory for `dsh.cmd` (win32) or
 *     `dsh` (unix); a .cmd hit is wrapped with cmd.exe; nothing found -> error.
 *   - Always appended, in this exact order:
 *     ['--profile', profile, '--patch', patchYml, '--port', '0', '--no-open']
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import {
  CONTROL_TOKEN_ENV,
  CONTROL_URL_ENV,
  parseReadyLine,
  type HostEndpoint,
} from '@dsh-desktop/protocol';
import { killProcessTree } from './proc-kill';

export type SidecarState = 'stopped' | 'starting' | 'running' | 'error';

export interface SidecarStatus {
  state: SidecarState;
  port?: number;
  url?: string;
  error?: string;
  startedAt?: number;
}

export interface DshCommand {
  command: string;
  args: string[];
  extraEnv: NodeJS.ProcessEnv;
}

export type SidecarLogLevel = 'info' | 'warn' | 'error';

export interface DshSidecarOptions {
  profile: string;
  dshHome: string;
  /** Control server URL/token; forwarded to the child through protocol env names. */
  controlUrl?: string;
  controlToken?: string;
  env?: NodeJS.ProcessEnv;
  log?: (level: SidecarLogLevel, line: string) => void;
}

export interface DshSidecarEvents {
  state: [status: SidecarStatus];
  ready: [endpoint: HostEndpoint & { origin: string }];
  exit: [info: { code: number | null; signal: string | null }];
}

const JS_EXTENSIONS = ['.mjs', '.cjs', '.js'];
const EXIT_GRACE_MS = 5_000;

const JS_RE = /(?:\.mjs|\.cjs|\.js)$/u;
const CMD_RE = /(?:\.cmd|\.bat)$/u;

/** The DSH_BIN resolution contract. Throws when no binary can be located. */
export function resolveDshCommand(env: NodeJS.ProcessEnv = process.env): DshCommand {
  const dshBin = env['DSH_BIN'];
  if (dshBin !== undefined && dshBin.length > 0) {
    const lower = dshBin.toLowerCase();
    if (JS_RE.test(lower)) {
      // An Electron-capable node script: run it as plain node so the official
      // CLI does not boot a second GUI runtime inside the sidecar.
      return { command: process.execPath, args: [dshBin], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    if (process.platform === 'win32' && CMD_RE.test(lower)) {
      // /d /s /c keeps quoting predictable when the install path has spaces.
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', dshBin], extraEnv: {} };
    }
    return { command: dshBin, args: [], extraEnv: {} };
  }

  const isWindows = process.platform === 'win32';
  const candidate = isWindows ? 'dsh.cmd' : 'dsh';
  const pathValue = env['PATH'] ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    const full = join(dir, candidate);
    if (existsSync(full)) {
      if (isWindows) return { command: 'cmd.exe', args: ['/d', '/s', '/c', full], extraEnv: {} };
      return { command: full, args: [], extraEnv: {} };
    }
  }
  throw new Error('dsh binary not found: install @deepseek-ai/dsh or set DSH_BIN');
}

/**
 * The --patch overlay injected into the composed profile tree: env DSH_PATCH
 * wins; otherwise the monorepo's packages/desktop-shell/cordis.patch.yml is
 * located by walking up from this module's directory (works identically for
 * src/main under vitest and dist/main at runtime).
 *
 * TODO(packaging): a packaged build must copy cordis.patch.yml into
 * resources (electron-builder extraResources) and resolve it against
 * process.resourcesPath here — the monorepo walk cannot work inside asar.
 */
export function resolvePatchYmlPath(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const override = env['DSH_PATCH'];
  if (override !== undefined && override.length > 0) return override;
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, 'packages', 'desktop-shell', 'cordis.patch.yml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cordis.patch.yml not found: set DSH_PATCH to the desktop-shell patch file');
}

/** Fixed-order CLI arguments shared with the Tauri sidecar. */
export function buildDshArgs(profile: string, patchYmlPath: string): string[] {
  return ['--profile', profile, '--patch', patchYmlPath, '--port', '0', '--no-open'];
}

/**
 * Child environment: inherits everything, pins the DSH contract vars, strips
 * NODE_OPTIONS (a stray loader/debug flag from the user shell would otherwise
 * apply to the run-as-node sidecar — the reference shell does the same) and
 * lets DSH_BIN resolution extras (ELECTRON_RUN_AS_NODE) win last.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { profile: string; dshHome: string; controlUrl?: string; controlToken?: string },
  command: DshCommand,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...base, DSH_HOME: opts.dshHome, DSH_PROFILE_NAME: opts.profile };
  delete childEnv['NODE_OPTIONS'];
  if (opts.controlUrl !== undefined) childEnv[CONTROL_URL_ENV] = opts.controlUrl;
  if (opts.controlToken !== undefined) childEnv[CONTROL_TOKEN_ENV] = opts.controlToken;
  return { ...childEnv, ...command.extraEnv };
}

/**
 * Non-ready stdout lines are graded by keyword only; the ready line itself is
 * consumed by parseReadyLine and never reaches this classifier.
 */
export function classifySidecarLine(line: string): SidecarLogLevel {
  const lower = line.toLowerCase();
  if (lower.includes('error')) return 'error';
  if (lower.includes('ready') || lower.includes('listening')) return 'info';
  return 'info';
}

interface StartDeferred {
  resolve: (endpoint: HostEndpoint) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class DshSidecar extends EventEmitter<DshSidecarEvents> {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logLine: (level: SidecarLogLevel, line: string) => void;
  private profileName: string;
  private child: ChildProcess | undefined;
  private currentState: SidecarState = 'stopped';
  private currentStatus: SidecarStatus = { state: 'stopped' };
  private readyEndpoint: HostEndpoint | null = null;
  private stopping = false;
  private ops: Promise<unknown> = Promise.resolve();
  private pendingStart: Promise<HostEndpoint> | null = null;
  private deferred: StartDeferred | null = null;

  constructor(private readonly options: DshSidecarOptions) {
    super();
    this.env = options.env ?? process.env;
    this.profileName = options.profile;
    this.logLine = options.log ?? (() => undefined);
  }

  get state(): SidecarState {
    return this.currentState;
  }

  get status(): SidecarStatus {
    return { ...this.currentStatus };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get profile(): string {
    return this.profileName;
  }

  /** Switch the profile used by the NEXT spawn (launcher.switchProfile). */
  setProfile(name: string): void {
    this.profileName = name;
  }

  endpoint(): HostEndpoint | null {
    return this.readyEndpoint === null ? null : { ...this.readyEndpoint };
  }

  private log(level: SidecarLogLevel, line: string): void {
    this.logLine(level, line);
  }

  private setState(state: SidecarState, patch: Partial<SidecarStatus> = {}): void {
    this.currentState = state;
    this.currentStatus = { ...this.currentStatus, ...patch, state };
    this.emit('state', this.status);
  }

  /** Serialize stop/spawn/restart; every queued step runs after the previous settles. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.then(fn, fn);
    this.ops = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Idempotent: while running, resolves with the current endpoint; while
   * starting, returns the in-flight promise.
   */
  spawn(): Promise<HostEndpoint> {
    if (this.currentState === 'running' && this.readyEndpoint !== null) {
      return Promise.resolve({ ...this.readyEndpoint });
    }
    if (this.pendingStart !== null) return this.pendingStart;
    const pending = this.runExclusive(() => this.doSpawn());
    this.pendingStart = pending.finally(() => {
      if (this.pendingStart === pending) this.pendingStart = null;
    });
    return this.pendingStart;
  }

  /** Kill the whole process tree; resolves when the exit is observed (≤5s). */
  stop(): Promise<void> {
    this.pendingStart = null;
    return this.runExclusive(() => this.doStop());
  }

  restart(): Promise<HostEndpoint> {
    this.pendingStart = null;
    const pending = this.runExclusive(async () => {
      await this.doStop();
      return this.doSpawn();
    });
    this.pendingStart = pending.finally(() => {
      if (this.pendingStart === pending) this.pendingStart = null;
    });
    return this.pendingStart;
  }

  private async doStop(): Promise<void> {
    const child = this.child;
    this.readyEndpoint = null;
    if (child === undefined) {
      this.stopping = false;
      this.setState('stopped', { port: undefined, url: undefined, error: undefined, startedAt: undefined });
      return;
    }
    this.stopping = true;
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        await killProcessTree(pid, { log: (line) => this.log('warn', line) });
      } catch (error) {
        this.log('error', `failed to kill sidecar tree (pid ${pid}): ${errorText(error)}`);
      }
    }
    const exited = await waitForExit(child, EXIT_GRACE_MS);
    if (!exited) {
      this.log('warn', `sidecar pid ${String(pid)} did not exit within ${String(EXIT_GRACE_MS)}ms after kill`);
    }
    // The exit handler owns the final state transition when it fires; when the
    // wait timed out, settle the state here so callers see a consistent view.
    if (this.child === child) {
      this.child = undefined;
      this.stopping = false;
      this.setState('stopped', { port: undefined, url: undefined, error: undefined, startedAt: undefined });
    }
  }

  private async doSpawn(): Promise<HostEndpoint> {
    if (this.child !== undefined) {
      throw new Error('sidecar: cannot spawn while a previous child is still alive');
    }
    // Resolution errors land in the state machine instead of crashing the app.
    const command = resolveDshCommand(this.env);
    const patchYmlPath = resolvePatchYmlPath(this.env);
    const args = [...command.args, ...buildDshArgs(this.profileName, patchYmlPath)];
    const childEnv = buildChildEnv(this.env, {
      profile: this.profileName,
      dshHome: this.options.dshHome,
      controlUrl: this.options.controlUrl,
      controlToken: this.options.controlToken,
    }, command);

    this.readyEndpoint = null;
    this.stopping = false;
    this.setState('starting', {
      port: undefined,
      url: undefined,
      error: undefined,
      startedAt: Date.now(),
    });
    this.log('info', `spawning host: ${command.command} ${args.map((a) => (a.includes('token=') ? 'token=***' : a)).join(' ')}`);

    const child = spawn(command.command, args, {
      env: childEnv,
      windowsHide: true,
      // posix: the child becomes a process-group leader so killProcessTree can
      // signal the whole tree; win32 relies on taskkill /T instead.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const deferred: StartDeferred = {
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    };
    const startPromise = new Promise<HostEndpoint>((resolve, reject) => {
      deferred.resolve = (endpoint) => {
        if (deferred.settled) return;
        deferred.settled = true;
        resolve(endpoint);
      };
      deferred.reject = (error) => {
        if (deferred.settled) return;
        deferred.settled = true;
        reject(error);
      };
    });
    this.deferred = deferred;

    if (child.stdout !== null) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      rl.on('line', (line) => this.onStdoutLine(child, line));
      child.once('close', () => rl.close());
    }
    if (child.stderr !== null) {
      const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
      rlErr.on('line', (line) => {
        if (line.trim().length === 0) return;
        this.log('error', line);
      });
      child.once('close', () => rlErr.close());
    }

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.log('error', `sidecar spawn error: ${errorText(error)}`);
      deferred.reject(new Error(`sidecar spawn error: ${errorText(error)}`));
      this.deferred = null;
      this.child = undefined;
      this.setState('error', {
        error: `sidecar spawn error: ${errorText(error)}`,
        port: undefined,
        url: undefined,
      });
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.deferred = null;
      const wasStopping = this.stopping;
      this.stopping = false;
      deferred.reject(new Error(`sidecar exited before the ready line (code ${codeText(code)}, signal ${signal ?? 'null'})`));
      if (wasStopping) {
        this.setState('stopped', { port: undefined, url: undefined, error: undefined, startedAt: undefined });
      } else {
        this.setState('error', {
          error: `sidecar exited unexpectedly (code ${codeText(code)}, signal ${signal ?? 'null'})`,
          port: undefined,
          url: undefined,
        });
      }
      this.emit('exit', { code, signal });
    });

    return startPromise;
  }

  private onStdoutLine(_child: ChildProcess, line: string): void {
    const ready = parseReadyLine(line);
    if (ready !== null) {
      const endpoint = { port: ready.port, url: ready.url };
      this.readyEndpoint = endpoint;
      this.setState('running', { port: ready.port, url: ready.url, error: undefined });
      this.log('info', `host ready: ${ready.origin}`);
      this.deferred?.resolve(endpoint);
      this.deferred = null;
      this.emit('ready', { port: ready.port, url: ready.url, origin: ready.origin });
      return;
    }
    if (line.trim().length === 0) return;
    this.log(classifySidecarLine(line), line);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeText(code: number | null): string {
  return code === null ? 'null' : String(code);
}

/** Resolves true when the child emitted 'exit' within the budget. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
