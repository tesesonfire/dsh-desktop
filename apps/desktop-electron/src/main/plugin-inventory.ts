/**
 * Plugin inventory (desktop-pnpm / community-market analog, read-only):
 * scan the current DSH profile's node_modules for packages that declare a
 * `dsh` manifest section with `bundle` (patch) or `client` fields. The shell
 * never installs, disables or patches anything here — display only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledPlugin } from '@dsh-desktop/protocol';

interface DshManifestView {
  name?: unknown;
  version?: unknown;
  dsh?: {
    bundle?: { patch?: unknown } | null;
    client?: { platform?: unknown } | null;
    profile?: unknown;
  } | null;
}

function parseManifest(dir: string): InstalledPlugin | null {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: DshManifestView;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DshManifestView;
  } catch {
    return null;
  }
  const bundlePatch = manifest.dsh?.bundle?.patch;
  const clientPlatform = manifest.dsh?.client?.platform;
  if (typeof bundlePatch !== 'string' && typeof clientPlatform !== 'string') return null;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null;
  return {
    name: manifest.name,
    version: manifest.version,
    patchPath: typeof bundlePatch === 'string' ? bundlePatch : undefined,
    clientPlatform: typeof clientPlatform === 'string' ? clientPlatform : undefined,
  };
}

function scanNodeModules(nodeModulesDir: string, out: InstalledPlugin[]): void {
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pkgDir = join(nodeModulesDir, entry);
    // scoped package: node_modules/@scope/<name>
    if (entry.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = readdirSync(pkgDir, { withFileTypes: true }).map((e) => e.name);
      } catch {
        continue;
      }
      for (const inner of scoped) {
        const found = parseManifest(join(pkgDir, inner));
        if (found !== null) out.push(found);
      }
      continue;
    }
    const found = parseManifest(pkgDir);
    if (found !== null) out.push(found);
  }
}

/** List DSH plugins (bundle/client manifests) installed in a profile. */
export function listProfilePlugins(profileDir: string): InstalledPlugin[] {
  const plugins: InstalledPlugin[] = [];
  scanNodeModules(join(profileDir, 'node_modules'), plugins);
  // pnpm layout: real packages live under .pnpm; the top-level links are what
  // the profile depends on, which is the surface users care about.
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return plugins;
}
