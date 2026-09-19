/**
 * Profile discovery and selection over $DSH_HOME.
 *
 * A profile is `$DSH_HOME/profiles/<name>/` with a package.json manifest
 * declaring `dsh.profile.bundles`. The current selection and the
 * last-known-good checkpoint live in userData/desktop-state.json (atomic
 * tmp+rename writes). Electron-free so it is unit-testable.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '@dsh-desktop/protocol';
import type { DshSidecar } from './sidecar';

export interface DesktopState {
  currentProfile: string;
  lastKnownGood: { name: string; at: number } | null;
}

export interface LauncherOptions {
  dshHome: string;
  userDataDir: string;
  sidecar?: DshSidecar;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

export const DEFAULT_PROFILE_NAME = 'web';

/** Bundles of the shipped `web` template (deepseek-harness app-boot/src/profile.ts:135-151). */
export const DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const;

/**
 * Mirror the official `dsh` profile bootstrap (initProfile): when $DSH_HOME
 * holds no usable profile, create the default one so a clean machine can boot.
 * The official CLI refuses `--profile desktop` (reserved for the official
 * Electron app), so the shell default is `dsh-desktop-electron`.
 */
export function defaultProfileName(): string {
  const fromEnv = process.env['DSH_PROFILE_NAME'];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : 'dsh-desktop-electron';
}

export function createDefaultProfile(dshHome: string, name = defaultProfileName()): Profile {
  const dir = join(dshHome, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: [...DEFAULT_PROFILE_BUNDLES] } },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    '# profile user layer — the desktop shell injects its plugin via --patch, not by editing this file\n[]\n',
    'utf8',
  );
  return { name, path: dir, bundles: [...DEFAULT_PROFILE_BUNDLES] };
}

interface ProfileManifest {
  name?: unknown;
  dsh?: { profile?: { bundles?: unknown } };
}

export function readDesktopStateFile(file: string): DesktopState {
  const fallback: DesktopState = { currentProfile: DEFAULT_PROFILE_NAME, lastKnownGood: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopState> | null;
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return {
      currentProfile: typeof parsed.currentProfile === 'string' && parsed.currentProfile.length > 0
        ? parsed.currentProfile
        : DEFAULT_PROFILE_NAME,
      lastKnownGood: parsed.lastKnownGood !== null && typeof parsed.lastKnownGood === 'object' && typeof parsed.lastKnownGood.name === 'string'
        ? { name: parsed.lastKnownGood.name, at: typeof parsed.lastKnownGood.at === 'number' ? parsed.lastKnownGood.at : 0 }
        : null,
    };
  } catch {
    return fallback;
  }
}

/** tmp + rename so a crash mid-write can never truncate the state file. */
export function writeDesktopStateFile(file: string, state: DesktopState): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export class Launcher {
  private readonly stateFile: string;
  private readonly log: (level: 'info' | 'warn' | 'error', line: string) => void;

  constructor(private readonly options: LauncherOptions) {
    this.stateFile = join(options.userDataDir, 'desktop-state.json');
    this.log = options.log ?? (() => undefined);
  }

  get dshHome(): string {
    return this.options.dshHome;
  }

  /** Wire the sidecar after construction (the sidecar needs the profile name first). */
  setSidecar(sidecar: DshSidecar): void {
    this.options.sidecar = sidecar;
  }

  /** Scan the profile directories' package.json manifests; unreadable entries are skipped. */
  listProfiles(): Profile[] {
    const profilesDir = join(this.options.dshHome, 'profiles');
    let entries: string[];
    try {
      entries = readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const profiles: Profile[] = [];
    for (const name of entries) {
      const manifestPath = join(profilesDir, name, 'package.json');
      let manifest: ProfileManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest;
      } catch {
        this.log('warn', `skipping profile ${name}: ${manifestPath} is missing or not valid JSON`);
        continue;
      }
      const bundles = manifest.dsh?.profile?.bundles;
      profiles.push({
        name,
        path: join(profilesDir, name),
        bundles: Array.isArray(bundles) ? bundles.filter((b): b is string => typeof b === 'string') : [],
      });
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return profiles;
  }

  private readState(): DesktopState {
    return readDesktopStateFile(this.stateFile);
  }

  /**
   * Resolve the current profile: the persisted selection, else the
   * last-known-good checkpoint, else the first profile on disk. Throws when no
   * profile exists at all — without one the sidecar must not be spawned.
   */
  getCurrentProfile(): Profile {
    let profiles = this.listProfiles();
    if (profiles.length === 0) {
      // Clean machine: bootstrap the default profile like the official CLI does.
      const created = createDefaultProfile(this.options.dshHome);
      this.log('info', `bootstrapped default profile: ${created.name} at ${created.path}`);
      profiles = [created];
    }
    const state = this.readState();
    const wanted = [state.currentProfile, state.lastKnownGood?.name] as const;
    for (const name of wanted) {
      if (name === undefined) continue;
      const found = profiles.find((p) => p.name === name);
      if (found !== undefined) return found;
    }
    return profiles[0] as Profile;
  }

  setCurrentProfile(name: string): void {
    if (!this.listProfiles().some((p) => p.name === name)) {
      throw new Error(`profile not found: ${name}`);
    }
    const state = this.readState();
    writeDesktopStateFile(this.stateFile, { ...state, currentProfile: name });
  }

  /** Validate -> persist -> restart the sidecar on the new profile. */
  async switchProfile(name: string): Promise<void> {
    this.setCurrentProfile(name);
    const sidecar = this.options.sidecar;
    if (sidecar === undefined) {
      this.log('warn', `profile switched to ${name} but no sidecar is wired; restart skipped`);
      return;
    }
    sidecar.setProfile(name);
    await sidecar.restart();
    this.log('info', `switched profile to ${name}`);
  }

  /** Called whenever the host reaches a healthy (running) generation. */
  recordHealthy(name: string): void {
    const state = this.readState();
    if (state.lastKnownGood?.name === name) return;
    writeDesktopStateFile(this.stateFile, { ...state, lastKnownGood: { name, at: Date.now() } });
    this.log('info', `last-known-good profile checkpoint: ${name}`);
  }
}
