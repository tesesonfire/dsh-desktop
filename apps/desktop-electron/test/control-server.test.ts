/**
 * ControlServer — HTTP contract tests with real fetch() over loopback:
 * token gate, hello recording, same-origin attach fence, host stop/restart
 * and the /v0/events queue + long-poll.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { CONTROL_ENDPOINTS, CONTROL_TOKEN_HEADER, type ControlEventBatch } from '@dsh-desktop/protocol';
import { ControlServer } from '../src/main/control-server';

const READY_ORIGIN = 'http://127.0.0.1:3080';

interface Harness {
  server: ControlServer;
  attachedUrls: () => string[];
  stopCalls: () => number;
}

async function startHarness(): Promise<Harness> {
  const server = new ControlServer();
  const attached: string[] = [];
  let stops = 0;
  await server.start({
    currentProfile: () => ({ name: 'web', path: '/tmp/dsh-home/profiles/web', bundles: ['@dsh/base'] }),
    attach: (url) => {
      attached.push(url);
    },
    stopHost: () => {
      stops += 1;
    },
    restartHost: async () => ({ port: 4321, url: 'http://127.0.0.1:4321/?token=abc' }),
  });
  server.setReadyOrigin(READY_ORIGIN);
  return { server, attachedUrls: () => attached, stopCalls: () => stops };
}

function authHeaders(token: string): Record<string, string> {
  return { [CONTROL_TOKEN_HEADER]: token };
}

describe('ControlServer', () => {
  it('accepts hello with the correct token and records it', async () => {
    const { server } = await startHarness();
    try {
      const response = await fetch(`${server.url}${CONTROL_ENDPOINTS.hello}`, {
        method: 'POST',
        headers: authHeaders(server.token),
        body: JSON.stringify({ pid: 1234, webPort: 3080, profile: 'web', protocolVersion: 1 }),
      });
      expect(response.status).toBe(204);
      expect(server.helloSeen).toBe(true);
      expect(server.helloInfo?.pid).toBe(1234);
      expect(server.helloInfo?.profile).toBe('web');
    } finally {
      await server.stop();
    }
  });

  it('rejects wrong and missing tokens with 403', async () => {
    const { server } = await startHarness();
    try {
      const wrong = await fetch(`${server.url}${CONTROL_ENDPOINTS.hello}`, {
        method: 'POST',
        headers: authHeaders('not-the-token'),
        body: JSON.stringify({ pid: 1, webPort: 1, profile: 'web', protocolVersion: 1 }),
      });
      expect(wrong.status).toBe(403);
      const missing = await fetch(`${server.url}${CONTROL_ENDPOINTS.hello}`, {
        method: 'POST',
        body: JSON.stringify({ pid: 1, webPort: 1, profile: 'web', protocolVersion: 1 }),
      });
      expect(missing.status).toBe(403);
      expect(server.helloSeen).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('GET /v0/hello returns the current profile JSON', async () => {
    const { server } = await startHarness();
    try {
      const response = await fetch(`${server.url}${CONTROL_ENDPOINTS.hello}`, {
        headers: authHeaders(server.token),
      });
      expect(response.status).toBe(200);
      const profile = (await response.json()) as { name: string; bundles: string[] };
      expect(profile.name).toBe('web');
      expect(profile.bundles).toEqual(['@dsh/base']);
    } finally {
      await server.stop();
    }
  });

  it('attach is fenced to the ready-line origin (403 otherwise)', async () => {
    const { server, attachedUrls } = await startHarness();
    try {
      const foreign = await fetch(`${server.url}${CONTROL_ENDPOINTS.webviewAttach}`, {
        method: 'POST',
        headers: authHeaders(server.token),
        body: JSON.stringify({ url: 'http://127.0.0.1:9999/?token=whatever' }),
      });
      expect(foreign.status).toBe(403);
      expect(server.webviewAttached).toBe(false);
      expect(attachedUrls()).toEqual([]);

      const sameOrigin = await fetch(`${server.url}${CONTROL_ENDPOINTS.webviewAttach}`, {
        method: 'POST',
        headers: authHeaders(server.token),
        body: JSON.stringify({ url: 'http://127.0.0.1:3080/?token=abc' }),
      });
      expect(sameOrigin.status).toBe(204);
      expect(server.webviewAttached).toBe(true);
      expect(attachedUrls()).toEqual(['http://127.0.0.1:3080/?token=abc']);
    } finally {
      await server.stop();
    }
  });

  it('host stop/restart endpoints drive the injected handlers', async () => {
    const { server, stopCalls } = await startHarness();
    try {
      const stop = await fetch(`${server.url}${CONTROL_ENDPOINTS.hostStop}`, {
        method: 'POST',
        headers: authHeaders(server.token),
      });
      expect(stop.status).toBe(204);
      expect(stopCalls()).toBe(1);

      const restart = await fetch(`${server.url}${CONTROL_ENDPOINTS.hostRestart}`, {
        method: 'POST',
        headers: authHeaders(server.token),
        body: JSON.stringify({}),
      });
      expect(restart.status).toBe(200);
      const endpoint = (await restart.json()) as { port: number; url: string };
      expect(endpoint.port).toBe(4321);
      expect(endpoint.url).toBe('http://127.0.0.1:4321/?token=abc');
    } finally {
      await server.stop();
    }
  });

  it('drains enqueued events immediately and long-polls in order', async () => {
    const { server } = await startHarness();
    try {
      server.enqueueEvent({ type: 'window-close' });
      const response = await fetch(`${server.url}${CONTROL_ENDPOINTS.events}`, {
        headers: authHeaders(server.token),
      });
      expect(response.status).toBe(200);
      const batch = (await response.json()) as ControlEventBatch;
      expect(batch.events).toEqual([{ type: 'window-close' }]);

      // A second poll that arrives before the event is enqueued must still
      // receive it (long-poll wakeup).
      const pending = fetch(`${server.url}${CONTROL_ENDPOINTS.events}`, {
        headers: authHeaders(server.token),
      });
      await sleep(150);
      server.enqueueEvent({ type: 'shutdown' });
      const batch2 = (await (await pending).json()) as ControlEventBatch;
      expect(batch2.events).toEqual([{ type: 'shutdown' }]);
    } finally {
      await server.stop();
    }
  });

  it('cleans up the long-poll waiter when the client aborts', async () => {
    const { server } = await startHarness();
    try {
      const aborted = fetch(`${server.url}${CONTROL_ENDPOINTS.events}`, {
        headers: authHeaders(server.token),
        signal: AbortSignal.timeout(150),
      }).then(
        () => 'resolved',
        () => 'aborted',
      );
      expect(await aborted).toBe('aborted');
      await sleep(100);
      // The waiter must be gone; the next poll drains the queue instantly.
      server.enqueueEvent({ type: 'window-close' });
      const response = await fetch(`${server.url}${CONTROL_ENDPOINTS.events}`, {
        headers: authHeaders(server.token),
      });
      const batch = (await response.json()) as ControlEventBatch;
      expect(batch.events).toEqual([{ type: 'window-close' }]);
    } finally {
      await server.stop();
    }
  });

  it('answers 404 for unknown routes (with a valid token)', async () => {
    const { server } = await startHarness();
    try {
      const response = await fetch(`${server.url}/v0/nope`, { headers: authHeaders(server.token) });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
