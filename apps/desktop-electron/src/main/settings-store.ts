/**
 * Desktop settings persistence (contract v1.1). Electron-free so it is
 * unit-testable. Atomic tmp+rename writes; zoom is clamped to [0.5, 2.0].
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DESKTOP_SETTINGS_DEFAULTS, DESKTOP_ZOOM_MAX, DESKTOP_ZOOM_MIN, type DesktopSettings } from '@dsh-desktop/protocol';

export const ZOOM_MIN = DESKTOP_ZOOM_MIN;
export const ZOOM_MAX = DESKTOP_ZOOM_MAX;

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Validate + merge a partial patch onto current settings. Unknown keys and
 * wrong types are rejected (not silently dropped) so renderer bugs surface.
 */
export function applySettingsPatch(current: DesktopSettings, patch: unknown): DesktopSettings {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsValidationError('settings patch must be a JSON object');
  }
  const next: DesktopSettings = { ...current };
  const record = patch as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case 'closeToTray':
      case 'startMinimized':
        if (typeof value !== 'boolean') throw new SettingsValidationError(`${key} must be a boolean`);
        next[key] = value;
        break;
      case 'zoomFactor': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new SettingsValidationError('zoomFactor must be a finite number');
        }
        if (value < ZOOM_MIN || value > ZOOM_MAX) {
          throw new SettingsValidationError(`zoomFactor must be within [${String(ZOOM_MIN)}, ${String(ZOOM_MAX)}]`);
        }
        next['zoomFactor'] = value;
        break;
      }
      default:
        throw new SettingsValidationError(`unknown settings key: ${key}`);
    }
  }
  return next;
}

export function readSettingsFile(file: string): DesktopSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Re-validate stored values so a hand-edited file cannot poison the shell.
    return applySettingsPatch({ ...DESKTOP_SETTINGS_DEFAULTS }, parsed);
  } catch {
    return { ...DESKTOP_SETTINGS_DEFAULTS };
  }
}

export function writeSettingsFile(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export class SettingsStore {
  private current: DesktopSettings;

  constructor(private readonly file: string) {
    this.current = readSettingsFile(file);
  }

  get(): DesktopSettings {
    return { ...this.current };
  }

  /** Validate → persist → return the new value; throws on invalid patches. */
  set(patch: unknown): DesktopSettings {
    const next = applySettingsPatch(this.current, patch);
    writeSettingsFile(this.file, next);
    this.current = next;
    return { ...this.current };
  }
}

/** Convenience for wiring: settings.json lives next to desktop-state.json. */
export function settingsFileFor(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}
