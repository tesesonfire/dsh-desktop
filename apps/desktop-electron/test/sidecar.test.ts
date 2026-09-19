/**
 * DshSidecar against the REAL mock-dsh CLI (packages/testkit/bin/mock-dsh.mjs)
 * through the DSH_BIN contract — the same path the app uses when the official
 * @deepseek-ai/dsh is not installed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DshSidecar,
  buildDshArgs,
  classifySidecarLine,
  resolveDshCommand,
  resolvePatchYmlPath,
} from '../src/main/sidecar';
import { isProcessAlive } from '../src/main/proc-kill';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(appRoot, '..');
const mockDshPath = join(repoRoot, 'packages', 'testkit', 'bin', 'mock-dsh.mjs');

function makeSidecar(overrides: Partial<ConstructorParameters<typeof DshSidecar>[0]> = {}): DshSidecar {
  return new DshSidecar({
    profile: 'dsh-desktop-electron',
    dshHome: mkdtempSync(join(tmpdir(), 'dsh-sidecar-home-')),
    env: { ...process.env, DSH_BIN: mockDshPath },
    log: () => undefined,
    ...overrides,
  });
}

async function expectEventuallyDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sidecar pid ${String(pid)} is still alive after ${String(timeoutMs)}ms`);
}

describe('resolveDshCommand', () => {
  it('wraps .mjs/.cjs/.js with process.execPath and ELECTRON_RUN_AS_NODE=1', () => {
    const result = resolveDshCommand({ DSH_BIN: '/opt/tools/mock-dsh.mjs' });
    expect(result.command).toBe(process.execPath);
    expect(result.args).toEqual(['/opt/tools/mock-dsh.mjs']);
    expect(result.extraEnv['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('wraps .cmd/.bat with cmd.exe /d /s /c on windows and passes through otherwise', () => {
    const result = resolveDshCommand({ DSH_BIN: 'C:\\tools\\dsh.cmd' });
    if (process.platform === 'win32') {
      expect(result.command).toBe('cmd.exe');
      expect(result.args).toEqual(['/d', '/s', '/c', 'C:\\tools\\dsh.cmd']);
    } else {
      expect(result.command).toBe('C:\\tools\\dsh.cmd');
      expect(result.args).toEqual([]);
    }
  });

  it('uses plain binaries verbatim', () => {
    const result = resolveDshCommand({ DSH_BIN: '/usr/local/bin/dsh' });
    expect(result.command).toBe('/usr/local/bin/dsh');
    expect(result.args).toEqual([]);
    expect(result.extraEnv).toEqual({});
  });

  it('throws the contract error message when nothing is found', () => {
    expect(() => resolveDshCommand({})).toThrowError(
      'dsh binary not found: install @deepseek-ai/dsh or set DSH_BIN',
    );
  });
});

describe('buildDshArgs / resolvePatchYmlPath', () => {
  it('appends flags in the fixed contract order', () => {
    expect(buildDshArgs('my-profile', '/tmp/patch.yml')).toEqual([
      '--profile',
      'my-profile',
      '--patch',
      '/tmp/patch.yml',
      '--port',
      '0',
      '--no-open',
    ]);
  });

  it('resolves the monorepo cordis.patch.yml and honors DSH_PATCH', () => {
    expect(resolvePatchYmlPath({}, appRoot)).toBe(join(repoRoot, 'packages', 'desktop-shell', 'cordis.patch.yml'));
    expect(resolvePatchYmlPath({ DSH_PATCH: '/custom/patch.yml' }, appRoot)).toBe('/custom/patch.yml');
  });
});

describe('classifySidecarLine', () => {
  it('grades by keyword', () => {
    expect(classifySidecarLine('something error happened')).toBe('error');
    expect(classifySidecarLine('host ready on port 3000')).toBe('info');
    expect(classifySidecarLine('server listening')).toBe('info');
    expect(classifySidecarLine('loading plugins')).toBe('info');
  });
});

describe('DshSidecar (real mock-dsh process)', () => {
  it(
    'spawns, parses the ready line, is reentrant, and stops without residue',
    { timeout: 60_000 },
    async () => {
      const sidecar = makeSidecar();
      try {
        const states: string[] = [];
        sidecar.on('state', (status) => states.push(status.state));
        // Concurrent spawns must dedup onto one child.
        const [a, b] = await Promise.all([sidecar.spawn(), sidecar.spawn()]);
        expect(b).toEqual(a);
        expect(a.port).toBeGreaterThan(0);
        expect(a.url).toContain('/?token=');
        // The token is a credential: it must survive into the URL handed out.
        expect(a.url).toMatch(/\?token=[A-Za-z0-9_-]+$/u);
        expect(sidecar.state).toBe('running');
        expect(sidecar.status.port).toBe(a.port);
        expect(sidecar.status.url).toBe(a.url);
        expect(states).toContain('running');

        const pid = sidecar.pid;
        if (pid === undefined) throw new Error('sidecar pid missing while running');

        await sidecar.stop();
        expect(sidecar.state).toBe('stopped');
        expect(sidecar.endpoint()).toBeNull();
        await expectEventuallyDead(pid);
      } finally {
        await sidecar.stop().catch(() => undefined);
      }
    },
  );

  it(
    'restart replaces the endpoint with a fresh port',
    { timeout: 60_000 },
    async () => {
      const sidecar = makeSidecar();
      try {
        const first = await sidecar.spawn();
        const firstPid = sidecar.pid;
        if (firstPid === undefined) throw new Error('sidecar pid missing');
        const second = await sidecar.restart();
        expect(second.port).toBeGreaterThan(0);
        // OS-assigned ports; a real restart must not return the old endpoint.
        expect(second.url).not.toBe(first.url);
        expect(sidecar.state).toBe('running');
        await expectEventuallyDead(firstPid);
      } finally {
        await sidecar.stop().catch(() => undefined);
      }
    },
  );

  it(
    'lands spawn failures in the state machine instead of crashing',
    { timeout: 30_000 },
    async () => {
      // A .mjs DSH_BIN that exits before printing a ready line.
      const failingBin = join(appRoot, 'test', 'fixtures', 'exit-before-ready.mjs');
      const sidecar = makeSidecar({ env: { ...process.env, DSH_BIN: failingBin } });
      const child = await sidecar.spawn().then(
        () => null,
        (error: unknown) => error,
      );
      expect(child).toBeInstanceOf(Error);
      expect(sidecar.state).toBe('error');
      expect(sidecar.status.error).toBeTruthy();
      await sidecar.stop();
      expect(sidecar.state).toBe('stopped');
    },
  );
});
