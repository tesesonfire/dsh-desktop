/**
 * Path resolution for the Electron shell. Kept free of electron imports so it
 * is unit-testable under plain node.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface DshDesktopPaths {
  /** DSH profile root ($DSH_HOME). */
  dshHome: string;
  /** Electron per-user data directory. */
  userData: string;
  logs: string;
  windowStateFile: string;
  desktopStateFile: string;
  smokeReportFile: string;
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME'];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

export function resolveDesktopPaths(userDataDir: string, env: NodeJS.ProcessEnv = process.env): DshDesktopPaths {
  const smokeOut = env['DSH_SMOKE_OUT'];
  return {
    dshHome: resolveDshHome(env),
    userData: userDataDir,
    logs: join(userDataDir, 'logs'),
    windowStateFile: join(userDataDir, 'window-state.json'),
    desktopStateFile: join(userDataDir, 'desktop-state.json'),
    smokeReportFile: smokeOut !== undefined && smokeOut.length > 0 ? smokeOut : join(userDataDir, 'smoke-report.json'),
  };
}

/**
 * Locate the desktop-electron application root by walking up from a module
 * directory until the package.json whose name is `desktop-electron` is found.
 * Works for both src/main/*.ts (vitest) and dist/main/index.js (runtime).
 *
 * TODO(packaging): in an asar archive this walk still resolves (electron
 * patches fs), but a packaged install should prefer app.getAppPath().
 */
export function resolveAppRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (parsed.name === 'desktop-electron') return dir;
    } catch {
      // not the app root; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function appRootFromModuleUrl(moduleUrl: string): string {
  return resolveAppRoot(dirname(fileURLToPath(moduleUrl)));
}
