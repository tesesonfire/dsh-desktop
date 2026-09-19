import { describe, expect, it, vi } from 'vitest';
import { BackoffPolicy, HostSupervisor, MAX_RESTARTS, type SupervisorHost } from '../src/main/supervisor';
import type { SidecarStatus } from '../src/main/sidecar';

function makeHost(): { host: SupervisorHost; statuses: SidecarStatus[]; restarts: { count: number } } {
  const statuses: SidecarStatus[] = [];
  const restarts = { count: 0 };
  return {
    statuses,
    restarts,
    host: {
      status: () => statuses[statuses.length - 1] ?? { state: 'stopped' },
      restart: async () => {
        restarts.count += 1;
      },
    },
  };
}

describe('BackoffPolicy', () => {
  it('doubles the delay and gives up after MAX_RESTARTS', () => {
    const policy = new BackoffPolicy();
    const delays = [];
    for (let i = 0; i < MAX_RESTARTS + 1; i += 1) delays.push(policy.onFailure());
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, null]);
    expect(policy.exhausted).toBe(true);
  });

  it('resets after a stable run', () => {
    const policy = new BackoffPolicy(5, 1000);
    policy.onFailure();
    policy.onFailure();
    policy.onStable();
    expect(policy.failures).toBe(0);
    expect(policy.onFailure()).toBe(1000);
  });
});

describe('HostSupervisor', () => {
  it('schedules backoff restarts on error state and notifies', () => {
    vi.useFakeTimers();
    const { host, restarts } = makeHost();
    const notifications: [string, string][] = [];
    const supervisor = new HostSupervisor({
      host,
      notifier: { notify: (t, b) => notifications.push([t, b]) },
      stableMs: 60_000,
    });
    supervisor.onState({ state: 'error', error: 'crash!' });
    vi.advanceTimersByTime(2000);
    expect(restarts.count).toBe(1);
    expect(notifications.length).toBe(1);
    // second failure → doubled delay
    supervisor.onState({ state: 'error', error: 'crash again' });
    vi.advanceTimersByTime(2000);
    expect(restarts.count).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(restarts.count).toBe(2);
    supervisor.dispose();
    vi.useRealTimers();
  });

  it('resets the counter once the host runs stably', () => {
    vi.useFakeTimers();
    const { host, restarts } = makeHost();
    const supervisor = new HostSupervisor({ host, notifier: { notify: () => undefined }, stableMs: 1000 });
    supervisor.onState({ state: 'error' });
    vi.advanceTimersByTime(2000);
    supervisor.onState({ state: 'running' });
    vi.advanceTimersByTime(1000); // stability window elapsed
    supervisor.onState({ state: 'error' });
    vi.advanceTimersByTime(2000); // back to base delay (2s), not 4s
    expect(restarts.count).toBe(2);
    supervisor.dispose();
    vi.useRealTimers();
  });

  it('suppress() cancels pending restarts (intentional shutdown)', () => {
    vi.useFakeTimers();
    const { host, restarts } = makeHost();
    const supervisor = new HostSupervisor({ host, notifier: { notify: () => undefined } });
    supervisor.onState({ state: 'error' });
    supervisor.suppress();
    vi.advanceTimersByTime(60_000);
    expect(restarts.count).toBe(0);
    vi.useRealTimers();
  });

  it('gives up after MAX_RESTARTS consecutive failures with a final notice', () => {
    vi.useFakeTimers();
    const { host, restarts } = makeHost();
    const notifications: [string, string][] = [];
    const supervisor = new HostSupervisor({
      host,
      notifier: { notify: (t, b) => notifications.push([t, b]) },
      stableMs: 1,
    });
    for (let i = 0; i < MAX_RESTARTS; i += 1) {
      supervisor.onState({ state: 'error' });
      vi.advanceTimersByTime(60_000); // run out the longest possible backoff
    }
    const before = restarts.count;
    supervisor.onState({ state: 'error' });
    vi.advanceTimersByTime(60_000);
    expect(restarts.count).toBe(before); // no further restarts
    expect(notifications.at(-1)?.[0]).toContain('已停止');
    supervisor.dispose();
    vi.useRealTimers();
  });
});
