/**
 * Launcher — profile discovery over a synthetic $DSH_HOME, selection
 * persistence in desktop-state.json and switchProfile wiring.
 */
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Launcher, readDesktopStateFile, writeDesktopStateFile } from '../src/main/launcher';
import type { DshSidecar } from '../src/main/sidecar';

function makeDshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-launcher-home-'));
  mkdirSync(join(home, 'profiles', 'alpha'), { recursive: true });
  writeFileSync(
    join(home, 'profiles', 'alpha', 'package.json'),
    JSON.stringify({ name: 'alpha', dsh: { profile: { bundles: ['@dsh/alpha-bundle'] } } }),
  );
  mkdirSync(join(home, 'profiles', 'beta'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'beta', 'package.json'), JSON.stringify({ name: 'beta' }));
  // A broken manifest must be skipped, not fatal.
  mkdirSync(join(home, 'profiles', 'broken'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'broken', 'package.json'), '{ not json');
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function fakeSidecar(): DshSidecar & { restart: ReturnType<typeof vi.fn>; setProfile: ReturnType<typeof vi.fn> } {
  const sidecar = {
    setProfile: vi.fn(),
    restart: vi.fn(async () => ({ port: 1, url: 'http://127.0.0.1:1/?token=x' })),
  };
  return sidecar as unknown as DshSidecar & { restart: ReturnType<typeof vi.fn>; setProfile: ReturnType<typeof vi.fn> };
}

describe('Launcher.listProfiles', () => {
  it('scans $DSH_HOME/profiles/*/package.json and maps bundles', () => {
    const { home, cleanup } = makeDshHome();
    try {
      const launcher = new Launcher({ dshHome: home, userDataDir: join(home, 'userData') });
      const profiles = launcher.listProfiles();
      expect(profiles.map((p) => p.name)).toEqual(['alpha', 'beta']);
      expect(profiles[0]?.bundles).toEqual(['@dsh/alpha-bundle']);
      expect(profiles[1]?.bundles).toEqual([]);
      expect(profiles[0]?.path).toBe(join(home, 'profiles', 'alpha'));
    } finally {
      cleanup();
    }
  });

  it('returns an empty list for a missing DSH_HOME', () => {
    const launcher = new Launcher({ dshHome: join(tmpdir(), 'dsh-does-not-exist-42'), userDataDir: tmpdir() });
    expect(launcher.listProfiles()).toEqual([]);
  });
});

describe('Launcher.getCurrentProfile', () => {
  it('falls back currentProfile -> lastKnownGood -> first profile', () => {
    const { home, cleanup } = makeDshHome();
    try {
      const userData = join(home, 'userData');
      mkdirSync(userData, { recursive: true });
      // No state file: currentProfile defaults to 'web' which does not exist
      // here, no lastKnownGood -> first profile alphabetically.
      const launcher = new Launcher({ dshHome: home, userDataDir: userData });
      expect(launcher.getCurrentProfile().name).toBe('alpha');
    } finally {
      cleanup();
    }
  });

  it('uses the lastKnownGood checkpoint when the selection is missing', () => {
    const { home, cleanup } = makeDshHome();
    try {
      const userData = join(home, 'userData');
      mkdirSync(userData, { recursive: true });
      writeDesktopStateFile(join(userData, 'desktop-state.json'), {
        currentProfile: 'ghost-profile',
        lastKnownGood: { name: 'beta', at: 1 },
      });
      const launcher = new Launcher({ dshHome: home, userDataDir: userData });
      expect(launcher.getCurrentProfile().name).toBe('beta');
    } finally {
      cleanup();
    }
  });

  it('bootstraps the default profile when none exists (clean machine)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-empty-home-'));
    try {
      const launcher = new Launcher({ dshHome: empty, userDataDir: join(empty, 'userData') });
      const profile = launcher.getCurrentProfile();
      expect(profile.name).toBe('dsh-desktop-electron');
      const manifest = JSON.parse(readFileSync(join(profile.path, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
      expect(manifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-web-app');
      expect(launcher.listProfiles()).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('Launcher.switchProfile', () => {
  it('validates, persists and restarts the sidecar on the new profile', async () => {
    const { home, cleanup } = makeDshHome();
    try {
      const userData = join(home, 'userData');
      const sidecar = fakeSidecar();
      const launcher = new Launcher({ dshHome: home, userDataDir: userData, sidecar });
      await launcher.switchProfile('beta');
      expect(sidecar.setProfile).toHaveBeenCalledWith('beta');
      expect(sidecar.restart).toHaveBeenCalledTimes(1);
      const state = readDesktopStateFile(join(userData, 'desktop-state.json'));
      expect(state.currentProfile).toBe('beta');
    } finally {
      cleanup();
    }
  });

  it('rejects unknown profile names without touching the sidecar', async () => {
    const { home, cleanup } = makeDshHome();
    try {
      const sidecar = fakeSidecar();
      const launcher = new Launcher({ dshHome: home, userDataDir: join(home, 'userData'), sidecar });
      await expect(launcher.switchProfile('ghost')).rejects.toThrowError(/profile not found/u);
      expect(sidecar.restart).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe('Launcher.recordHealthy', () => {
  it('checkpoints the last-known-good profile', () => {
    const { home, cleanup } = makeDshHome();
    try {
      const userData = join(home, 'userData');
      const launcher = new Launcher({ dshHome: home, userDataDir: userData });
      launcher.recordHealthy('beta');
      const state = readDesktopStateFile(join(userData, 'desktop-state.json'));
      expect(state.lastKnownGood?.name).toBe('beta');
      expect(state.lastKnownGood?.at).toBeGreaterThan(0);
      // Idempotent for the same name.
      launcher.recordHealthy('beta');
      expect(readDesktopStateFile(join(userData, 'desktop-state.json')).lastKnownGood?.name).toBe('beta');
    } finally {
      cleanup();
    }
  });
});

describe('desktop-state.json round trip', () => {
  it('reads defaults from a missing file and survives a write/read cycle', () => {
    const missing = join(tmpdir(), `dsh-state-missing-${String(process.pid)}`, 'desktop-state.json');
    expect(readDesktopStateFile(missing)).toEqual({ currentProfile: 'web', lastKnownGood: null });
    const file = join(mkstempDir(), 'desktop-state.json');
    writeDesktopStateFile(file, { currentProfile: 'alpha', lastKnownGood: { name: 'beta', at: 42 } });
    expect(readDesktopStateFile(file)).toEqual({ currentProfile: 'alpha', lastKnownGood: { name: 'beta', at: 42 } });
    rmSync(join(file, '..'), { recursive: true, force: true });
  });
});

function mkstempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'));
  return dir;
}
