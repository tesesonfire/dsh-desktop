import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SettingsStore,
  SettingsValidationError,
  applySettingsPatch,
  clampZoom,
  readSettingsFile,
} from '../src/main/settings-store';
import { applyZoomStep } from '../src/main/shell';

const BASE = { closeToTray: true, startMinimized: false, zoomFactor: 1 };

describe('applySettingsPatch', () => {
  it('merges valid patches and clamps nothing silently', () => {
    expect(applySettingsPatch(BASE, { closeToTray: false })).toEqual({ closeToTray: false, startMinimized: false, zoomFactor: 1 });
    expect(applySettingsPatch(BASE, { zoomFactor: 1.5 })).toMatchObject({ zoomFactor: 1.5 });
  });

  it('rejects unknown keys, bad types and out-of-range zoom', () => {
    expect(() => applySettingsPatch(BASE, { theme: 'dark' })).toThrow(SettingsValidationError);
    expect(() => applySettingsPatch(BASE, { zoomFactor: 3 })).toThrow(/zoomFactor/u);
    expect(() => applySettingsPatch(BASE, { zoomFactor: 0.4 })).toThrow(/zoomFactor/u);
    expect(() => applySettingsPatch(BASE, { closeToTray: 'yes' })).toThrow(/boolean/u);
    expect(() => applySettingsPatch(BASE, null)).toThrow(/object/u);
  });

  it('clampZoom bounds helpers agree with validation', () => {
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(0)).toBe(0.5);
    expect(clampZoom(1.234)).toBe(1.234);
  });
});

describe('SettingsStore persistence', () => {
  it('round-trips through disk atomically and survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-'));
    const file = join(dir, 'settings.json');
    try {
      const store = new SettingsStore(file);
      expect(store.get()).toEqual({ closeToTray: true, startMinimized: false, zoomFactor: 1 });
      const next = store.set({ startMinimized: true, zoomFactor: 1.3 });
      expect(next).toEqual({ closeToTray: true, startMinimized: true, zoomFactor: 1.3 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ startMinimized: true });
      // reopen: persisted values win over defaults
      expect(new SettingsStore(file).get()).toMatchObject({ startMinimized: true, zoomFactor: 1.3 });
      // corrupt file → defaults, not a crash
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(file, '{broken');
      expect(readSettingsFile(file)).toEqual({ closeToTray: true, startMinimized: false, zoomFactor: 1 });
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp best effort
      }
    }
  });
});

describe('applyZoomStep (Ctrl+= / Ctrl+- / Ctrl+0)', () => {
  it('steps within bounds and resets to the base zoom', () => {
    expect(applyZoomStep(1, '+', 1)).toBe(1.1);
    expect(applyZoomStep(1, '-', 1)).toBe(0.9);
    expect(applyZoomStep(1.96, '+', 1)).toBe(2);
    expect(applyZoomStep(0.55, '-', 1)).toBe(0.5);
    expect(applyZoomStep(1.7, '0', 1)).toBe(1);
    expect(applyZoomStep(2, '0', 1.25)).toBe(1.25);
  });
});
