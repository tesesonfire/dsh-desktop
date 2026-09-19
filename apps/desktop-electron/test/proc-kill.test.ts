/**
 * killProcessTree against REAL processes: a node child that spawns a node
 * grandchild; both must be gone after the tree kill. On posix the child is
 * spawned detached (process-group leader) exactly like the sidecar is.
 */
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessAlive, killProcessTree } from '../src/main/proc-kill';

// Runs under plain node: prints one JSON line {child, grand} then idles.
const CHILD_CODE = `
const { spawn } = require('node:child_process');
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ child: process.pid, grand: grand.pid }) + String.fromCharCode(10));
setInterval(() => {}, 1000);
`;

function firstLine(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) throw new Error('child produced no stdout');
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        cleanup();
        resolve(buffer.slice(0, index).trim());
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`stdout ended before a full line: ${buffer}`));
    };
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}

async function expectEventuallyDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pid ${String(pid)} is still alive after ${String(timeoutMs)}ms`);
}

describe('killProcessTree', () => {
  it(
    'kills a real process tree (child and grandchild both die)',
    { timeout: 90_000 },
    async () => {
      const child = spawn(process.execPath, ['-e', CHILD_CODE], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Same spawn shape as the sidecar: a posix group leader so the whole
        // tree shares a process group; windows relies on taskkill /T.
        detached: process.platform !== 'win32',
      });
      const line = await firstLine(child.stdout);
      const parsed: unknown = JSON.parse(line);
      const pids = parsed as { child: number; grand: number };
      expect(pids.child).toBeGreaterThan(0);
      expect(pids.grand).toBeGreaterThan(0);
      expect(isProcessAlive(pids.child)).toBe(true);
      expect(isProcessAlive(pids.grand)).toBe(true);

      try {
        await killProcessTree(pids.child);
        await expectEventuallyDead(pids.child);
        await expectEventuallyDead(pids.grand);
      } finally {
        // Safety net so a failed assertion cannot leak processes into the suite.
        if (isProcessAlive(pids.child)) {
          if (process.platform === 'win32') {
            const { execFileSync } = await import('node:child_process');
            try {
              execFileSync('taskkill', ['/pid', String(pids.child), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            } catch {
              // already dead
            }
          } else {
            try {
              process.kill(-pids.child, 'SIGKILL');
            } catch {
              // already dead
            }
          }
        }
        child.kill();
        await once(child, 'exit').catch(() => undefined);
      }
    },
  );

  it(
    'swallows already-gone errors (ESRCH / taskkill exit 128)',
    { timeout: 30_000 },
    async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) throw new Error('child pid missing');
      await once(child, 'exit');
      await expectEventuallyDead(pid);
      await expect(killProcessTree(pid)).resolves.toBeUndefined();
    },
  );

  it('rejects invalid pids', async () => {
    await expect(killProcessTree(0)).rejects.toThrowError(/invalid pid/u);
    await expect(killProcessTree(-1)).rejects.toThrowError(/invalid pid/u);
  });
});
