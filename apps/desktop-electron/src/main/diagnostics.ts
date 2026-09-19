/**
 * Diagnostics export (desktop-diagnostics analog, slimmed): collect a masked,
 * read-only snapshot of shell state + recent logs into a single JSON file,
 * then reveal it. No runtime files are modified.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskTokens } from './log';

export const DIAGNOSTICS_LOG_TAIL_LINES = 200;

export interface DiagnosticsInput {
  appVersion: string;
  platform: string;
  electronVersion?: string;
  dshHome: string;
  logsDir: string;
  desktopStateFile: string;
  windowStateFile: string;
  settingsFile: string;
  hostStatus: unknown;
  hostHello: unknown;
  profiles: unknown;
  now?: () => Date;
}

function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Tail a log file and mask every line (tokens must never leave the machine). */
export function tailLogLines(logsDir: string, lines = DIAGNOSTICS_LOG_TAIL_LINES): string[] {
  const today = `main-${dateStamp(new Date())}.log`;
  try {
    const content = readFileSync(join(logsDir, today), 'utf8');
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-lines)
      .map(maskTokens);
  } catch {
    return [];
  }
}

function dateStamp(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function collectDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const now = input.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    electronVersion: input.electronVersion ?? null,
    dshHome: input.dshHome,
    hostStatus: input.hostStatus,
    hostHello: input.hostHello,
    profiles: input.profiles,
    desktopState: readJsonOrNull(input.desktopStateFile),
    windowState: readJsonOrNull(input.windowStateFile),
    settings: readJsonOrNull(input.settingsFile),
    recentLog: tailLogLines(input.logsDir),
  };
}

export function writeDiagnosticsReport(dir: string, report: Record<string, unknown>, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `dsh-desktop-diagnostics-${now.getTime()}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}
