import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_LOG_BYTES, FileLogSink, maskTokens } from '../src/main/log';

describe('maskTokens', () => {
  it('masks ready-line tokens but keeps the URL shape', () => {
    const masked = maskTokens('dsh web: http://127.0.0.1:3080/?token=abcDEF-_123');
    expect(masked).toBe('dsh web: http://127.0.0.1:3080/?token=***');
    expect(maskTokens('x-token-abc')).toBe('x-token-abc');
  });
});

describe('FileLogSink rotation across midnight', () => {
  it('reopens the CURRENT date file after a rotation that crosses a day boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'));
    try {
      let current = new Date('2026-09-20T23:00:00');
      const sink = new FileLogSink(dir, () => current);
      sink.open();
      // One oversized line forces a rotation (still on Sep 20).
      sink.write('info', `x${'x'.repeat(MAX_LOG_BYTES)}`);
      expect(existsSync(join(dir, 'main-20260920.log'))).toBe(true);
      // Cross midnight, then force a second rotation.
      current = new Date('2026-09-21T01:00:00');
      sink.write('info', `y${'y'.repeat(MAX_LOG_BYTES)}`);
      expect(existsSync(join(dir, 'main-20260921.log'))).toBe(true);
      // The old date file was rotated to .1, not resurrected as the live file.
      expect(readdirSync(dir).filter((f) => f === 'main-20260920.log' && !f.includes('.1')).length).toBe(0);
      sink.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // temp dir best effort
      }
    }
  });
});
