#!/usr/bin/env node
/**
 * Post-exit process-residue scan (V3 slot).
 *
 * Looks for leftover DSH / mock-dsh / sidecar node processes after the app
 * under test has exited. Exit code 1 when residue is found. `--json` prints
 * machine-readable output for the smoke script.
 */
import { execFileSync } from 'node:child_process';

const MARKERS = ['mock-dsh', 'dsh-desktop-shell', '@deepseek-ai/dsh', 'deepseek-harness'];

function listWindows() {
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','dsh.exe' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: String(p.ProcessId),
    name: p.Name,
    cmd: p.CommandLine ?? '',
  }));
}

function listPosix() {
  const raw = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30_000 });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/);
      return { pid, name: '', cmd: rest.join(' ') };
    });
}

const isWin = process.platform === 'win32';
const candidates = (isWin ? listWindows() : listPosix()).filter((p) => {
  if (String(p.pid) === String(process.pid)) return false;
  return MARKERS.some((m) => (isWin ? p.cmd : `${p.cmd} ${p.name}`).toLowerCase().includes(m.toLowerCase()));
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ residue: candidates }, null, 2));
} else if (candidates.length === 0) {
  console.log('✔ no dsh / sidecar residue');
} else {
  console.error('✘ residue found:');
  for (const p of candidates) console.error(`  pid=${p.pid} ${p.name} ${p.cmd.slice(0, 160)}`);
  process.exit(1);
}
