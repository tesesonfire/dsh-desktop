#!/usr/bin/env node
/**
 * Machine-enforced DesktopBridge contract audit.
 *
 * The canonical method list lives in packages/protocol/src/bridge.ts. Both
 * platform implementations must register exactly that set:
 *   - Electron: ipc.ts must contain a literal `bridge:<method>` channel per
 *     method (ipcMain.handle('bridge:host_start', …)).
 *   - Tauri: lib.rs generate_handler![] must list every command as
 *     `ipc::<method>` and ipc.rs must define each as #[tauri::command].
 *
 * Drift in either direction fails with a nonzero exit. This runs without
 * cargo, so the Rust side is audited at source level even on machines
 * without a Rust toolchain.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function extractList(source, marker) {
  const match = source.match(new RegExp(`${marker}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (match === null) throw new Error(`cannot locate ${marker} in source`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const canonical = extractList(read('packages/protocol/src/bridge.ts'), 'DESKTOP_BRIDGE_METHODS');
const failures = [];

function audit(name, found, source) {
  const missing = canonical.filter((m) => !found.includes(m));
  const extra = found.filter((m) => !canonical.includes(m));
  const dupes = found.filter((m, i) => found.indexOf(m) !== i);
  if (missing.length > 0) failures.push(`${name}: missing ${missing.join(', ')}`);
  if (extra.length > 0) failures.push(`${name}: unknown entries ${extra.join(', ')}`);
  if (dupes.length > 0) failures.push(`${name}: duplicated ${dupes.join(', ')}`);
  console.log(`${found.length === canonical.length && missing.length === 0 && extra.length === 0 && dupes.length === 0 ? '✔' : '✘'} ${name}: ${found.length}/${canonical.length} methods`);
  if (process.argv.includes('--verbose')) console.log(`   (${source}) ${found.join(', ')}`);
}

// --- Electron: literal bridge: channels in ipc.ts
const electronIpc = read('apps/desktop-electron/src/main/ipc.ts');
audit('electron ipcMain.handle', [...electronIpc.matchAll(/bridge:([a-z_]+)/g)].map((m) => m[1]), 'apps/desktop-electron/src/main/ipc.ts');

// --- Electron: preload whitelist must be protocol-driven, not a literal copy
if (!/DESKTOP_BRIDGE_METHODS/.test(read('apps/desktop-electron/src/preload/index.ts'))) {
  failures.push('electron preload: must whitelist via DESKTOP_BRIDGE_METHODS from @dsh-desktop/protocol');
}

// --- Tauri: generate_handler! list
const tauriLib = read('apps/desktop-tauri/src-tauri/src/lib.rs');
const handlerMatch = tauriLib.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (handlerMatch === null) {
  failures.push('tauri lib.rs: generate_handler![] not found');
} else {
  audit('tauri generate_handler!', [...handlerMatch[1].matchAll(/ipc::([a-z_]+)/g)].map((m) => m[1]), 'apps/desktop-tauri/src-tauri/src/lib.rs');
}
// --- Tauri: each command defined as #[tauri::command] fn <name>
const tauriIpc = read('apps/desktop-tauri/src-tauri/src/ipc.rs');
const commandFns = [...tauriIpc.matchAll(/#\s*\[\s*tauri::command\s*\][\s\S]{0,120}?fn\s+([a-z_]+)/g)].map((m) => m[1]);
audit('tauri #[tauri::command] fns', commandFns, 'apps/desktop-tauri/src-tauri/src/ipc.rs');

// --- Frontend: Tauri bridge must invoke exactly the canonical set
const uiBridge = read('packages/ui/src/bridge.ts');
const invoked = [...uiBridge.matchAll(/invoke[^(]*\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
audit('ui tauri invoke calls', invoked, 'packages/ui/src/bridge.ts');

if (failures.length > 0) {
  console.error('\nCONTRACT AUDIT FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\ncontract audit OK: ${canonical.length} DesktopBridge methods, 4 audit points`);
