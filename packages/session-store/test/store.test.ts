import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../src/index.js';

describe('SqliteSessionStore', () => {
  it('migrates to the current version and round-trips events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'));
    const file = join(dir, 'sessions.db');
    try {
      const store = new SqliteSessionStore(file);
      expect(store.schemaVersion).toBe(1);
      await store.append('s1', { seq: 1, type: 'user/message', at: 1, data: { text: 'hi' } });
      await store.append('s1', { seq: 2, type: 'assistant/message', at: 2, data: { text: 'hello' } });
      const events = await store.readAll('s1');
      expect(events.map((e) => e.type)).toEqual(['user/message', 'assistant/message']);
      expect(events[1]?.data).toEqual({ text: 'hello' });
      expect(store.listSessions().map((s) => s.id)).toEqual(['s1']);
      store.close();

      // reopen: migration is idempotent, data persists
      const reopened = new SqliteSessionStore(file);
      expect(reopened.schemaVersion).toBe(1);
      expect((await reopened.readAll('s1')).length).toBe(2);
      reopened.close();
    } finally {
      // Windows can hold the sqlite handle a beat after close() — best effort.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // temp dir, OS will reclaim it
      }
    }
  });
});
