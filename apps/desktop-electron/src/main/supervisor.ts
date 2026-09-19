/**
 * Host supervisor — restarts the DSH host after UNEXPECTED exits with
 * exponential backoff (reference shell pattern: MAX_RESTARTS=5, 2^n seconds,
 * stable-run counter reset). Pure state machine + injected clocks/notifier, so
 * it is unit-testable without Electron.
 */
import type { SidecarStatus } from './sidecar';

export const MAX_RESTARTS = 5;
export const BASE_BACKOFF_MS = 2_000;
export const STABLE_RESET_MS = 60_000;

export class BackoffPolicy {
  private consecutive = 0;

  constructor(
    private readonly maxRestarts: number = MAX_RESTARTS,
    private readonly baseMs: number = BASE_BACKOFF_MS,
  ) {}

  /** Call when the host exited unexpectedly. Returns the restart delay, or null to give up. */
  onFailure(): number | null {
    if (this.consecutive >= this.maxRestarts) return null;
    const delay = this.baseMs * 2 ** this.consecutive;
    this.consecutive += 1;
    return delay;
  }

  /** Call when the host has been running stably for STABLE_RESET_MS. */
  onStable(): void {
    this.consecutive = 0;
  }

  get failures(): number {
    return this.consecutive;
  }

  get exhausted(): boolean {
    return this.consecutive >= this.maxRestarts;
  }
}

export interface SupervisorHost {
  /** Sidecar state snapshot. */
  status(): SidecarStatus;
  /** Kick a restart; the sidecar serializes this with stop/spawn. */
  restart(): Promise<unknown>;
}

export interface SupervisorNotifier {
  notify(title: string, body: string): void;
}

export interface SupervisorOptions {
  host: SupervisorHost;
  notifier: SupervisorNotifier;
  /** Backoff instance (injected for tests). */
  policy?: BackoffPolicy;
  /** ms after which a running host counts as stable (tests inject a small value). */
  stableMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Wired to the sidecar's `state` events. A transition into 'running' starts
 * the stability timer; an 'error' state caused by an unexpected exit
 * schedules a backoff restart. Intentional stops (state 'stopped') cancel
 * everything. `suppressUntil` lets callers mark a stop as intentional.
 */
export class HostSupervisor {
  private readonly policy: BackoffPolicy;
  private readonly timers = new Set<Timer>();
  private stableTimer: Timer | null = null;
  private stopped = false;

  constructor(private readonly options: SupervisorOptions) {
    this.policy = options.policy ?? new BackoffPolicy();
  }

  /** Intentional shutdown (app quit / user stop): no restarts until reset(). */
  suppress(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** Re-arm after an intentional stop (e.g. manual host_start). */
  reset(): void {
    this.stopped = false;
    this.policy.onStable();
  }

  /** Feed every sidecar state transition. */
  onState(status: SidecarStatus): void {
    if (this.stopped) return;
    if (status.state === 'running') {
      this.scheduleStableCheck();
      return;
    }
    if (status.state === 'error') {
      this.scheduleRestart(status.error);
    }
  }

  private scheduleStableCheck(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    const setTimeoutImpl = this.options.setTimeoutImpl ?? setTimeout;
    this.stableTimer = setTimeoutImpl(() => {
      this.stableTimer = null;
      if (!this.stopped) {
        this.policy.onStable();
        this.options.log?.('info', 'host stable; restart counter reset');
      }
    }, this.options.stableMs ?? STABLE_RESET_MS);
    this.timers.add(this.stableTimer);
  }

  private scheduleRestart(error: string | undefined): void {
    if (this.stopped) return;
    const delay = this.policy.onFailure();
    if (delay === null) {
      this.options.notifier.notify(
        'DSH Host 已停止 / host stopped',
        `自动重启已达上限（${String(MAX_RESTARTS)} 次）。${error ?? ''}`,
      );
      this.options.log?.('error', `supervisor gave up after ${String(MAX_RESTARTS)} restarts`);
      return;
    }
    const attempt = this.policy.failures;
    this.options.notifier.notify(
      'DSH Host 已退出 / host exited',
      `${delay / 1000} 秒后自动重启（第 ${String(attempt)}/${String(MAX_RESTARTS)} 次）`,
    );
    this.options.log?.('warn', `host exited unexpectedly; restart #${String(attempt)} in ${String(delay)}ms`);
    const setTimeoutImpl = this.options.setTimeoutImpl ?? setTimeout;
    const timer: Timer = setTimeoutImpl(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      void this.options.host.restart().catch((restartError: unknown) => {
        this.options.log?.('error', `supervisor restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
      });
    }, delay);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  dispose(): void {
    this.stopped = true;
    this.clearTimers();
  }
}
