/**
 * Ready-line parsing — the ONLY readiness contract with the official DSH CLI.
 *
 * Official print point: deepseek-harness packages/bundle/web-app/src/index.ts:271
 *   console.log(`dsh web: ${authenticatedUrl}${lanUrl === undefined ? '' : ` (LAN: ${lanUrl})`}`)
 * Official e2e lock: apps/cli/tests/built-bin.e2e.ts:787
 *   /^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+$/u
 *
 * The `?token=` query parameter is the per-process credential; it MUST be kept
 * in the URL handed to the web view. The LAN suffix is informational only.
 */

export interface ReadyLineInfo {
  /** Authenticated URL, ready to load in the web view (token included). */
  url: string;
  /** Exact origin — the navigation fence allows nothing else. */
  origin: string;
  port: number;
}

export const DSH_READY_LINE_PATTERN =
  /^dsh web: (http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=[A-Za-z0-9_-]+?)(?: \(LAN: .+\))?$/;

export function parseReadyLine(line: string): ReadyLineInfo | null {
  const trimmed = line.trim();
  const match = DSH_READY_LINE_PATTERN.exec(trimmed);
  if (match === null) return null;
  const url = match[1];
  if (url === undefined) return null;
  const port = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { url, origin: `http://127.0.0.1:${port}`, port };
}

/** True when the URL is a loopback HTTP origin match for the given origin. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
