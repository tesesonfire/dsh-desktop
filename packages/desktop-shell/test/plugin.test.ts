import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlClient, createDesktopRuntime, unavailableDesktopRuntime } from '../src/control-client.js';
import { apply } from '../src/index.js';
import { CONTROL_ENDPOINTS, CONTROL_TOKEN_HEADER } from '@dsh-desktop/protocol';

function fakeCtx(webPort = 1234) {
  const provide = vi.fn();
  return {
    ctx: { provide, get: (key: string) => (key === 'webServer' ? { port: webPort } : undefined) } as never,
    provide,
  };
}

afterEach(() => {
  delete process.env['DSH_DESKTOP_CONTROL_URL'];
  delete process.env['DSH_DESKTOP_CONTROL_TOKEN'];
});

describe('dsh-desktop-shell plugin', () => {
  it('provides an unavailable runtime without shell env', () => {
    const { ctx, provide } = fakeCtx();
    apply(ctx, undefined, { env: {} });
    expect(provide).toHaveBeenCalledWith('desktopRuntime', expect.objectContaining({ spawnHost: expect.any(Function) }));
  });

  it('unavailable runtime fails loudly on spawnHost', async () => {
    const runtime = unavailableDesktopRuntime('web');
    await expect(runtime.spawnHost()).rejects.toThrow(/control channel unavailable/);
    await expect(runtime.getProfile()).resolves.toEqual({ name: 'web', path: '', bundles: [] });
  });

  it('sends hello with pid/webPort/profile and pumps events', async () => {
    const calls: { path: string; init: RequestInit & { json?: unknown } }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit & { json?: unknown }) => {
      calls.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), init: init ?? {} });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as typeof fetch;

    const client = new ControlClient({ baseUrl: 'http://127.0.0.1:45678', token: 'tok', fetchImpl });
    const runtime = createDesktopRuntime(client);
    await expect(runtime.attachWebView('http://127.0.0.1:3080/?token=x')).resolves.toBeUndefined();

    const hello = calls.find((c) => c.path === CONTROL_ENDPOINTS.webviewAttach);
    expect(hello).toBeDefined();
    const headers = new Headers(hello?.init?.headers);
    expect(headers.get(CONTROL_TOKEN_HEADER)).toBe('tok');
    expect(hello?.init?.json).toEqual({ url: 'http://127.0.0.1:3080/?token=x' });
  });

  it('delivers window-close events to onWindowClose subscribers', async () => {
    let respond: ((batch: unknown) => void) | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit & { json?: unknown }) => {
      if (String(_url).endsWith(CONTROL_ENDPOINTS.events)) {
        return await new Promise<Response>((resolve) => {
          respond = (batch) => resolve(new Response(JSON.stringify(batch), { status: 200 }));
        });
      }
      return new Response(undefined, { status: 204 });
    }) as typeof fetch;

    const client = new ControlClient({ baseUrl: 'http://127.0.0.1:45678', token: 'tok', fetchImpl });
    const handler = vi.fn();
    const off = client.onWindowClose(handler);
    client.startPump();
    await vi.waitFor(() => expect(respond).toBeDefined());
    respond?.({ events: [{ type: 'window-close' }] });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    off();
    client.dispose();
  });
});
