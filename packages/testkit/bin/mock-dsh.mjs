#!/usr/bin/env node
/**
 * mock-dsh — a byte-compatible stand-in for the official `dsh` CLI used by
 * smoke tests and local development when the real DeepSeek Harness is not
 * installed. It reproduces the ONLY surface the desktop shell depends on:
 *
 *   1. launcher arg semantics: first non-flag (≠ `plugin`) token → `--profile`
 *   2. flags: --profile <name> | --port <n> (0 = OS-assigned) | --host <h>
 *      (0.0.0.0 rejected) | --no-open | --patch <path> | --dump-config | --help
 *   3. the ready line printed AFTER the web server listens (deepseek-harness
 *      packages/bundle/web-app/src/index.ts:271, e2e lock built-bin.e2e.ts:787):
 *
 *        dsh web: http://127.0.0.1:<port>/?token=<base64url>
 *
 *      plus the optional second line when the browser would open.
 *   4. auth fence: requests without the token query get 401
 *      "dsh web authentication required; reopen the URL printed by dsh web."
 *   5. SIGTERM → exit 0, SIGINT → exit 130
 *
 * Unlike the real CLI it ALSO boots the real @deepseek-ai/cordis with the real
 * `dsh-desktop-shell` plugin (webServer stub + control-channel env), so the
 * full shell ⇄ plugin loop is exercised end to end without the 300MB upstream.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`dsh: ${message}\n`);
  process.exit(2);
}

// --- launcher arg expansion (args.ts:186-189): first non-flag, non-plugin
// token becomes --profile; everything after is the inner app argv.
const expanded = args.length > 0 && !args[0].startsWith('-') && args[0] !== 'plugin'
  ? ['--profile', ...args]
  : [...args];

const opts = { profile: undefined, port: undefined, host: undefined, noOpen: false, patch: [], dumpConfig: false, help: false, selfTest: false };
for (let i = 0; i < expanded.length; i++) {
  const a = expanded[i];
  if (a === '--profile') opts.profile = expanded[++i];
  else if (a === '--port') opts.port = expanded[++i];
  else if (a === '--host') opts.host = expanded[++i];
  else if (a === '--no-open') opts.noOpen = true;
  else if (a === '--patch') opts.patch.push(expanded[++i]);
  else if (a === '--dump-config') opts.dumpConfig = true;
  else if (a === '--self-test') { opts.selfTest = true; process.env['MOCK_DSH_SELF_TEST'] = '1'; }
  else if (a === '--help' || a === '-h') opts.help = true;
  else if (a === 'web' || a === 'plugin') fail(`unexpected token ${a} after expansion`);
  else fail(`unknown flag ${a}`);
}
if (opts.host === '0.0.0.0') fail('--host 0.0.0.0 is intentionally not supported yet for safety');
const portNum = opts.port === undefined ? 3080 : Number.parseInt(opts.port, 10);
if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) fail('--port must be a number between 0 and 65535');
const profile = opts.profile ?? 'web';
process.env['DSH_PROFILE_NAME'] ??= profile;

if (opts.help) {
  process.stdout.write('mock-dsh: byte-compatible stand-in for `dsh web`. See packages/testkit/bin/mock-dsh.mjs header.\n');
  process.exit(0);
}
// Failure modes for fail-path smoke tests (must precede the ready line logic):
//   MOCK_DSH_EXIT_BEFORE_READY=1 → exit 3 without ever printing the ready line
//   MOCK_DSH_READY_THEN_CRASH_MS=<ms> → print the ready line, then exit 5 later
if (process.env['MOCK_DSH_EXIT_BEFORE_READY'] === '1') {
  process.stderr.write('mock-dsh: simulated fatal error before readiness\n');
  process.exit(3);
}
if (opts.dumpConfig) {
  process.stdout.write(`${JSON.stringify({ profile, webserver: { host: '127.0.0.1', port: portNum }, patches: opts.patch }, null, 2)}\n`);
  process.exit(0);
}

function buildServer(token) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${portNum}`);
    if (url.searchParams.get('token') !== token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>DSH mock web UI</title></head><body><h1>DSH mock web UI</h1><p id="mock-ok">ok</p></body></html>');
  });
}

const token = randomBytes(32).toString('base64url');
const server = buildServer(token);
server.listen(portNum, '127.0.0.1', () => {
  const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

  // Boot the REAL cordis with the REAL desktop-shell plugin (control channel,
  // hello, event pump). Failures must not break the ready line.
  void (async () => {
    try {
      const [{ Context }, plugin] = await Promise.all([
        import('@deepseek-ai/cordis'),
        import('dsh-desktop-shell'),
      ]);
      const ctx = new Context();
      ctx.provide('webServer', { port: bound });
      ctx.plugin({ name: plugin.name, inject: [...plugin.inject], apply: plugin.apply });
    } catch (error) {
      process.stderr.write(`mock-dsh: cordis/plugin boot skipped: ${error?.message ?? error}\n`);
    }
  })();

  // Ready line — exact official format. Nothing else prints to stdout.
  process.stdout.write(`dsh web: http://127.0.0.1:${bound}/?token=${token}\n`);
  if (!opts.noOpen) {
    process.stdout.write('dsh web: opening the default browser; pass --no-open to disable\n');
  }
  const crashAfter = Number.parseInt(process.env['MOCK_DSH_READY_THEN_CRASH_MS'] ?? '', 10);
  if (Number.isInteger(crashAfter) && crashAfter >= 0) {
    setTimeout(() => process.exit(5), crashAfter).unref();
  }
  if (process.env['MOCK_DSH_SELF_TEST'] === '1') {
    setTimeout(() => process.exit(0), 150);
  }
});
server.on('error', (error) => {
  process.stderr.write(`mock-dsh: ${error.message}\n`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
process.on('SIGINT', () => process.exit(130));
