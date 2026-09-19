#!/usr/bin/env node
/**
 * Clean-boot smoke test (V1/V2 slots) — one script, both frameworks.
 *
 *   node scripts/smoke-clean-boot.mjs --framework electron
 *   node scripts/smoke-clean-boot.mjs --framework tauri
 *
 * Flow (identical for both): point DSH_BIN at the testkit mock-dsh (byte-
 * compatible ready line + real cordis + real desktop-shell plugin), set
 * DSH_SMOKE=1, launch the real shell binary, then assert the smoke report:
 * host running on a random loopback port parsed from the official ready
 * line, control-channel hello received from the in-host plugin, web view
 * attached to the ready origin, and zero process residue after exit.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const frameworkIdx = args.indexOf('--framework');
const framework = frameworkIdx >= 0 ? args[frameworkIdx + 1] : undefined;

if (framework !== 'electron' && framework !== 'tauri') {
  console.error('usage: node scripts/smoke-clean-boot.mjs --framework <electron|tauri> [--timeout <s>]');
  process.exit(2);
}

const timeoutMs = Number.parseInt(args[args.indexOf('--timeout') + 1] ?? '', 10) || 120_000;
const workDir = mkdtempSync(join(tmpdir(), `dsh-smoke-${framework}-`));
const reportPath = join(workDir, 'smoke-report.json');
const dshBin = join(root, 'packages', 'testkit', 'bin', 'mock-dsh.mjs');

const env = {
  ...process.env,
  DSH_SMOKE: '1',
  DSH_SMOKE_OUT: reportPath,
  DSH_BIN: dshBin,
  DSH_HOME: join(workDir, 'dsh-home'),
  NODE_ENV: 'production',
};

function fail(message, extra) {
  console.error(`\n✘ smoke (${framework}) FAILED: ${message}`);
  if (extra) console.error(extra);
  cleanup(1);
}

function cleanup(code) {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // temp dir cleanup is best-effort
  }
  process.exit(code);
}

async function runElectron() {
  const appDir = join(root, 'apps', 'desktop-electron');
  const mainJs = join(appDir, 'dist', 'main', 'index.js');
  if (!existsSync(mainJs)) {
    fail('dist/main/index.js missing — run `pnpm --filter desktop-electron build` first');
  }
  const electronCli = join(appDir, 'node_modules', 'electron', 'cli.js');
  return launch([process.execPath, electronCli, '.'], appDir);
}

async function runTauri() {
  const srcTauri = join(root, 'apps', 'desktop-tauri', 'src-tauri');
  const binary =
    process.platform === 'win32'
      ? join(srcTauri, 'target', 'release', 'dsh-desktop-tauri.exe')
      : join(srcTauri, 'target', 'release', 'dsh-desktop-tauri');
  if (!existsSync(binary)) {
    let hasCargo = false;
    try {
      execFileSync('cargo', ['--version'], { stdio: 'ignore' });
      hasCargo = true;
    } catch {
      hasCargo = false;
    }
    if (!hasCargo) {
      console.log(
        `⚠ SKIP smoke (tauri): binary not built and cargo unavailable on this machine.\n` +
          `  On a machine with Rust+MSVC: pnpm --filter desktop-tauri tauri build, then rerun this script.`,
      );
      cleanup(0);
    }
    console.log('building tauri binary (cargo build --release)…');
    execFileSync('cargo', ['build', '--release'], { cwd: srcTauri, stdio: 'inherit' });
  }
  return launch([binary], srcTauri);
}

async function launch(command, cwd) {
  console.log(`▶ launching ${framework}: ${command.join(' ')}`);
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const timer = setTimeout(() => {
    console.error('\nsmoke timed out; killing app');
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, timeoutMs);

  const code = await new Promise((resolveExit) => child.on('exit', (c) => resolveExit(c ?? -1)));
  clearTimeout(timer);
  return code;
}

function verifyReport() {
  if (!existsSync(reportPath)) {
    fail(`smoke report not written to ${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const problems = [];
  if (report.framework !== framework) problems.push(`framework mismatch: ${report.framework}`);
  if (report.helloReceived !== true) problems.push('control-channel hello not received');
  if (report.webviewAttached !== true) problems.push('web view never attached to the ready origin');
  if (!report.readyLine || !Number.isInteger(report.readyLine.port) || report.readyLine.port <= 0) {
    problems.push(`ready line not parsed: ${JSON.stringify(report.readyLine)}`);
  } else if (!/\/\?token=[A-Za-z0-9_-]+$/.test(report.readyLine.url)) {
    problems.push(`ready URL lost its token: ${report.readyLine.url}`);
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) problems.push(`app errors: ${report.errors.join(' | ')}`);
  return { report, problems };
}

const exitCode = framework === 'electron' ? await runElectron() : await runTauri();
if (exitCode !== 0) fail(`app exited with code ${exitCode}`);

const { report, problems } = verifyReport();
if (problems.length > 0) fail('smoke report invalid', JSON.stringify(report, null, 2));

// V3: no orphaned dsh / sidecar processes after exit
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'check-orphan-processes.mjs')], { stdio: 'inherit' });
} catch {
  fail('process residue detected after exit');
}

console.log(`\n✔ smoke (${framework}) PASSED: port=${report.readyLine.port} hello=${report.helloReceived} attached=${report.webviewAttached} profile=${report.profile}`);
cleanup(0);
