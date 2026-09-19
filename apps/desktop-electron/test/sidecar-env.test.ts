import { describe, expect, it } from 'vitest';
import { buildChildEnv, buildDshArgs, resolveDshCommand } from '../src/main/sidecar';

describe('buildChildEnv', () => {
  const base = { ...process.env, NODE_OPTIONS: '--require /tmp/evil.cjs', PATH: process.env['PATH'] ?? '' };

  it('strips NODE_OPTIONS and pins the DSH contract vars', () => {
    const env = buildChildEnv(
      base,
      { profile: 'p1', dshHome: '/tmp/home', controlUrl: 'http://127.0.0.1:1', controlToken: 't' },
      { command: 'node', args: [], extraEnv: {} },
    );
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['DSH_HOME']).toBe('/tmp/home');
    expect(env['DSH_PROFILE_NAME']).toBe('p1');
    expect(env['DSH_DESKTOP_CONTROL_URL']).toBe('http://127.0.0.1:1');
    expect(env['DSH_DESKTOP_CONTROL_TOKEN']).toBe('t');
  });

  it('extraEnv wins last (ELECTRON_RUN_AS_NODE for js entries)', () => {
    const env = buildChildEnv(base, { profile: 'p1', dshHome: '/h' }, { command: 'node', args: [], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(env['NODE_OPTIONS']).toBeUndefined();
  });
});

describe('buildDshArgs order (launcher flags first, app flags last)', () => {
  it('matches the shared contract verbatim', () => {
    expect(buildDshArgs('web', 'patch.yml')).toEqual([
      '--profile', 'web', '--patch', 'patch.yml', '--port', '0', '--no-open',
    ]);
  });
});

describe('resolveDshCommand NODE_OPTIONS neutrality', () => {
  it('js entries run via the current executable with ELECTRON_RUN_AS_NODE', () => {
    const resolved = resolveDshCommand({ DSH_BIN: 'C:/x/mock-dsh.mjs', PATH: '' });
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual(['C:/x/mock-dsh.mjs']);
    expect(resolved.extraEnv['ELECTRON_RUN_AS_NODE']).toBe('1');
  });
});
