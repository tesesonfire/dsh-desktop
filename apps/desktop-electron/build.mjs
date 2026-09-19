#!/usr/bin/env node
/**
 * Build pipeline for the Electron thin-host shell:
 *   1. esbuild  src/main/index.ts    -> dist/main/index.js     (ESM, node platform)
 *   2. esbuild  src/preload/index.ts -> dist/preload/index.cjs (CJS, browser platform —
 *      sandboxed preloads must be CommonJS)
 *   3. vite build (renderer)        -> dist/renderer
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));

const step = (message) => console.log(`[build] ${message}`);

async function buildMain() {
  step('main process -> dist/main/index.js (esbuild, esm, platform=node)');
  await build({
    entryPoints: [resolve(appRoot, 'src/main/index.ts')],
    outfile: resolve(appRoot, 'dist/main/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['electron', 'electron-updater'],
    sourcemap: false,
    logLevel: 'warning',
  });
}

async function buildPreload() {
  step('preload -> dist/preload/index.cjs (esbuild, cjs, platform=browser)');
  await build({
    entryPoints: [resolve(appRoot, 'src/preload/index.ts')],
    outfile: resolve(appRoot, 'dist/preload/index.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome130',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'warning',
  });
}

function buildRenderer() {
  const viteBin = resolve(appRoot, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) {
    console.error('[build] FAILED: vite binary not found — dependencies are not installed');
    process.exit(1);
  }
  step('renderer -> dist/renderer (vite build)');
  const result = spawnSync(process.execPath, [viteBin, 'build'], { cwd: appRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[build] FAILED: vite build exited with status', result.status ?? result.error?.message ?? 'unknown');
    process.exit(result.status ?? 1);
  }
}

try {
  await buildMain();
  await buildPreload();
  buildRenderer();
  console.log('[build] OK — dist/main/index.js, dist/preload/index.cjs, dist/renderer/*');
} catch (error) {
  console.error('[build] FAILED:', error);
  process.exit(1);
}
