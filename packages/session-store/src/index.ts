import { DatabaseSync } from 'node:sqlite';
import { CURRENT_VERSION, MIGRATIONS } from './schema.js';

export interface StoredSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly at: number;
  readonly data: unknown;
}

export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type SessionEventSink = {
  append(sessionId: string, event: { seq: number; type: string; at: number; data: unknown }): Promise<void>;
  readAll(sessionId: string): Promise<StoredSessionEvent[]>;
};

/**
 * SQLite persistence for @dsh-desktop/core SessionService — implements the
 * SessionSink surface. Zero native dependencies: Node's built-in
 * node:sqlite (better-sqlite3 stays an Electron-bundling alternative; see
 * HANDOFF.md deviations).
 */
export class SqliteSessionStore implements SessionEventSink {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.migrate();
  }

  private migrate(): void {
    // A fresh database has no meta table yet — that's version 0, not an error.
    let current = 0;
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
      current = row === undefined ? 0 : Number.parseInt(row.value, 10);
    } catch {
      current = 0;
    }
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('schema_version', String(migration.version));
      }
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    return row === undefined ? 0 : Number.parseInt(row.value, 10);
  }

  upsertSession(sessionId: string, title: string | null = null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, title = COALESCE(excluded.title, sessions.title)`,
      )
      .run(sessionId, title, now, now);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all() as {
      id: string;
      title: string | null;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async append(sessionId: string, event: { seq: number; type: string; at: number; data: unknown }): Promise<void> {
    this.upsertSession(sessionId);
    this.db
      .prepare('INSERT OR REPLACE INTO session_events (session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, event.seq, event.type, event.at, JSON.stringify(event.data ?? null));
  }

  async readAll(sessionId: string): Promise<StoredSessionEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, type, at, data FROM session_events WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as { seq: number; type: string; at: number; data: string }[];
    return rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at, data: JSON.parse(r.data) as unknown }));
  }

  close(): void {
    this.db.close();
  }
}

export { CURRENT_VERSION };
