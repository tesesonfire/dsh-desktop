/**
 * Cross-platform process-tree termination. Free of electron imports so it is
 * unit-testable against real child processes.
 *
 * - win32:  `taskkill /pid <pid> /T /F` walks the parent-child tree, so the
 *           sidecar does not need a job object.
 * - posix:  the sidecar is spawned detached (its own process group), so
 *           `kill(-pid)` reaches the whole tree; SIGTERM escalates to SIGKILL
 *           after a grace period, with a non-group `kill(pid)` fallback for
 *           children that are not group leaders.
 *
 * ESRCH (process already gone) and its Windows counterpart (taskkill exit 128)
 * are swallowed: killing a dead tree is success.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_ESCALATE_AFTER_MS = 3_000;

export interface KillProcessTreeOptions {
  /** POSIX only: how long SIGTERM gets before SIGKILL. */
  readonly escalateAfterMs?: number;
  readonly log?: (line: string) => void;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function killTreeWindows(pid: number, log: (line: string) => void): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
    // taskkill exits 128 ("process not found") when the tree is already gone.
    const exitCode = typeof err.code === 'number' ? err.code : Number(err.code);
    if (exitCode === 128) {
      log(`taskkill: pid ${pid} already gone`);
      return;
    }
    log(`taskkill failed for pid ${pid}: ${err.message}${err.stderr === undefined ? '' : ` — ${err.stderr.trim()}`}`);
    throw error;
  }
}

async function killTreePosix(pid: number, escalateAfterMs: number, log: (line: string) => void): Promise<void> {
  const signalTree = (signal: NodeJS.Signals): boolean => {
    // Prefer the process group (the sidecar is spawned detached); fall back to
    // the single pid when the group does not exist.
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ESRCH') log(`kill(-${pid}, ${signal}) failed: ${String(code)}`);
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ESRCH') log(`kill(${pid}, ${signal}) failed: ${String(code)}`);
      return false;
    }
  };

  signalTree('SIGTERM');
  const deadline = Date.now() + escalateAfterMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
  log(`pid ${pid} survived SIGTERM for ${escalateAfterMs}ms; escalating to SIGKILL`);
  signalTree('SIGKILL');
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(50);
  }
}

export async function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`killProcessTree: invalid pid ${String(pid)}`);
  }
  const log = options.log ?? (() => undefined);
  if (process.platform === 'win32') {
    await killTreeWindows(pid, log);
    return;
  }
  await killTreePosix(pid, options.escalateAfterMs ?? DEFAULT_ESCALATE_AFTER_MS, log);
}
