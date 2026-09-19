/**
 * Main-process file logger with size-based rotation and retention cleanup.
 * Free of electron imports so it is unit-testable under plain node.
 *
 * Every line is masked through maskTokens BEFORE it is emitted to subscribers,
 * so the ready-line credential never reaches the 'dsh:log' bridge channel.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  line: string;
}

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const ROTATED_FILES_KEPT = 5;
export const LOG_RETENTION_DAYS = 7;

/** The ready-line token (`?token=<base64url>`) is a credential. */
export function maskTokens(text: string): string {
  return text.replace(/token=[A-Za-z0-9_-]+/g, 'token=***');
}

export type LogSubscriber = (entry: LogLine) => void;

const LOG_FILE_PATTERN = /^main-\d{8}\.log(?:\.\d+)?$/u;

function dateStamp(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export class FileLogSink {
  private readonly logsDir: string;
  private readonly now: () => Date;
  private filePath: string | null = null;
  private fd: number | null = null;
  private size = 0;
  private readonly subscribers = new Set<LogSubscriber>();

  constructor(logsDir: string, now: () => Date = () => new Date()) {
    this.logsDir = logsDir;
    this.now = now;
  }

  /** Open the sink and drop log files older than the retention window. */
  open(): void {
    mkdirSync(this.logsDir, { recursive: true });
    cleanupOldLogs(this.logsDir, this.now());
    this.openFile();
  }

  private openFile(): void {
    // Stamp computed on every (re)open so rotation across midnight lands in
    // the current date's file instead of the one captured at construction.
    this.filePath = join(this.logsDir, `main-${dateStamp(this.now())}.log`);
    try {
      this.fd = openSync(this.filePath, 'a');
      this.size = statSync(this.filePath).size;
    } catch {
      // A read-only or missing log directory must never take the app down.
      this.fd = null;
      this.size = 0;
    }
  }

  onLine(subscriber: LogSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  write(level: LogLevel, line: string): void {
    const masked = maskTokens(line);
    for (const subscriber of this.subscribers) {
      try {
        subscriber({ level, line: masked });
      } catch {
        // a faulty subscriber must not break logging
      }
    }
    if (this.fd === null) return;
    if (this.size >= MAX_LOG_BYTES) this.rotate();
    const stamped = `${new Date().toISOString()} [${level.toUpperCase()}] ${masked}\n`;
    try {
      appendFileSync(this.fd, stamped);
      this.size += Buffer.byteLength(stamped, 'utf8');
    } catch {
      // swallow append failures (disk full, file removed)
    }
  }

  /** main-<stamp>.log -> .log.1 -> ... -> .log.<ROTATED_FILES_KEPT> (oldest dropped). */
  private rotate(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
    const base = this.filePath ?? join(this.logsDir, `main-${dateStamp(this.now())}.log`);
    const oldest = `${base}.${ROTATED_FILES_KEPT}`;
    try {
      unlinkSync(oldest);
    } catch {
      // no oldest copy yet
    }
    for (let i = ROTATED_FILES_KEPT - 1; i >= 1; i -= 1) {
      const from = `${base}.${i}`;
      try {
        renameSync(from, `${base}.${i + 1}`);
      } catch {
        // missing slot; nothing to shift
      }
    }
    try {
      renameSync(base, `${base}.1`);
    } catch {
      // base vanished between close and rename; start a fresh file
    }
    this.openFile();
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
  }
}

/** Remove main-*.log(.[0-9]+)? files whose mtime is older than LOG_RETENTION_DAYS. */
export function cleanupOldLogs(logsDir: string, now: Date): void {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return;
  }
  const cutoffMs = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!LOG_FILE_PATTERN.test(entry)) continue;
    const full = join(logsDir, entry);
    try {
      if (statSync(full).mtimeMs < cutoffMs) unlinkSync(full);
    } catch {
      // raced with rotation or permissions; skip
    }
  }
}

let activeSink: FileLogSink | null = null;

/** Singleton facade used across the main process. */
export const log = {
  init(logsDir: string): void {
    activeSink?.close();
    const sink = new FileLogSink(logsDir);
    sink.open();
    activeSink = sink;
  },
  info(line: string): void {
    activeSink?.write('info', line);
  },
  warn(line: string): void {
    activeSink?.write('warn', line);
  },
  error(line: string): void {
    activeSink?.write('error', line);
  },
  /** Subscribe to masked log lines (used by ipc.ts to feed the 'dsh:log' bridge event). */
  onLine(subscriber: LogSubscriber): () => void {
    return activeSink?.onLine(subscriber) ?? (() => undefined);
  },
  close(): void {
    activeSink?.close();
    activeSink = null;
  },
};
