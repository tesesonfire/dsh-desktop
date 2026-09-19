import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTerminalCommand } from '../src/main/terminal';
import { collectDiagnostics, tailLogLines, writeDiagnosticsReport } from '../src/main/diagnostics';
import { listProfilePlugins } from '../src/main/plugin-inventory';

const PATH_WITH = (names: string[]): string => ['C:\\a', 'C:\\b', ...names.map((n) => `X:\\bin-${n}`)].join(';');

describe('resolveTerminalCommand', () => {
  // Stub exists probe: X:\bin-<name>\<name> "exists" when listed.
  const probeFor = (names: string[]) => (path: string): boolean =>
    names.some((n) => path === `X:\\bin-${n}\\${n}.exe` || path === `X:\\bin-${n}\\${n}`);

  it('windows: prefers wt, falls back to cmd broker', () => {
    const withWt = resolveTerminalCommand('C:\\data', 'win32', { PATH: PATH_WITH(['wt']), ComSpec: 'cmd.exe' }, probeFor(['wt']));
    expect(withWt.command).toBe('wt.exe');
    expect(withWt.args).toEqual(['-d', 'C:\\data']);
    const bare = resolveTerminalCommand('C:\\data', 'win32', { PATH: 'C:\\Windows', ComSpec: 'cmd.exe' }, () => false);
    expect(bare.command).toBe('cmd.exe');
    expect(bare.args[0]).toBe('/c');
    expect(bare.args).toContain('start');
  });

  it('mac: open -a Terminal', () => {
    expect(resolveTerminalCommand('/tmp/d', 'darwin', {}, () => false)).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/tmp/d'],
      windowsHide: false,
    });
  });

  it('linux: first known emulator wins; none → throws', () => {
    const linuxPath = ['C:\\x', 'X:\\bin-gnome-terminal'].join(';');
    const resolved = resolveTerminalCommand('/tmp/d', 'linux', { PATH: linuxPath }, probeFor(['gnome-terminal']));
    expect(resolved.command).toBe('gnome-terminal');
    expect(resolved.args).toEqual(['--working-directory', '/tmp/d']);
    expect(() => resolveTerminalCommand('/tmp/d', 'linux', { PATH: 'C:\\x' }, () => false)).toThrow(/terminal/u);
  });
});

describe('diagnostics', () => {
  it('tails and masks log lines (token never leaves the machine)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag-'));
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date();
      const name = `main-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}.log`;
      writeFileSync(
        join(dir, name),
        'dsh web: http://127.0.0.1:3080/?token=SECRETVALUE\nplain line\n'.repeat(2),
        'utf8',
      );
      const lines = tailLogLines(dir, 3);
      expect(lines.join('\n')).not.toContain('SECRETVALUE');
      expect(lines.some((line) => line.includes('token=***'))).toBe(true);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it('collect + write produces a file on disk with masked content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag2-'));
    try {
      const report = collectDiagnostics({
        appVersion: '0.1.0',
        platform: 'win32',
        dshHome: dir,
        logsDir: dir,
        desktopStateFile: join(dir, 'missing-state.json'),
        windowStateFile: join(dir, 'missing-window.json'),
        settingsFile: join(dir, 'missing-settings.json'),
        hostStatus: { state: 'running', port: 1234 },
        hostHello: { pid: 42, webPort: 1234, profile: 'p' },
        profiles: [{ name: 'p', path: dir, bundles: [] }],
      });
      expect(report['hostStatus']).toEqual({ state: 'running', port: 1234 });
      const file = writeDiagnosticsReport(dir, report);
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      expect(readFileSync(file, 'utf8')).toContain('"appVersion": "0.1.0"');
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
});

describe('listProfilePlugins', () => {
  it('finds bundle and client manifests incl. scoped packages, skips others', () => {
    const profile = mkdtempSync(join(tmpdir(), 'dsh-plugins-'));
    const nm = join(profile, 'node_modules');
    try {
      const mk = (dir: string, manifest: object): void => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
      };
      mk(join(nm, 'dsh-desktop-shell'), {
        name: 'dsh-desktop-shell',
        version: '0.1.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      });
      mk(join(nm, '@scope', 'web-client'), {
        name: '@scope/web-client',
        version: '1.2.3',
        dsh: { client: { platform: 'web' } },
      });
      mk(join(nm, 'plain-lib'), { name: 'plain-lib', version: '0.0.1' });
      const plugins = listProfilePlugins(profile);
      expect(plugins.map((p) => p.name)).toEqual(['@scope/web-client', 'dsh-desktop-shell']);
      expect(plugins[1]?.patchPath).toBe('./cordis.patch.yml');
      expect(plugins[0]?.clientPlatform).toBe('web');
    } finally {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // best effort
      }
    }
  });
});
