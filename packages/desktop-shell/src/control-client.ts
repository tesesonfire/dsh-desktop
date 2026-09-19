import {
  CONTROL_ENDPOINTS,
  CONTROL_EVENTS_LONGPOLL_MS,
  CONTROL_TIMEOUT_MS,
  CONTROL_TOKEN_ENV,
  CONTROL_TOKEN_HEADER,
  CONTROL_URL_ENV,
  CONTROL_PROTOCOL_VERSION,
  type ControlEvent,
  type ControlEventBatch,
  type ControlHello,
  type DesktopRuntimeService,
  type HostEndpoint,
  type Profile,
  type SpawnOptions,
} from '@dsh-desktop/protocol';

interface ControlClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class ControlUnavailableError extends Error {
  constructor(detail: string) {
    super(`dsh-desktop-shell: control channel unavailable — ${detail}`);
    this.name = 'ControlUnavailableError';
  }
}

/**
 * HTTP client for the platform shell's control server. Loopback-only, token
 * gated (x-dsh-desktop-control header). Every DesktopRuntimeService method is
 * one thin call — no business logic lives here.
 */
export class ControlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly closeHandlers = new Set<() => void>();
  private pumping = false;
  private disposed = false;

  private constructor(options: ControlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Returns null when the env contract is absent (running outside the shell). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ControlClient | null {
    const baseUrl = env[CONTROL_URL_ENV];
    const token = env[CONTROL_TOKEN_ENV];
    if (baseUrl === undefined || baseUrl === '' || token === undefined || token === '') {
      return null;
    }
    return new ControlClient({ baseUrl, token });
  }

  async request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set(CONTROL_TOKEN_HEADER, this.token);
    let body = init?.body;
    if (init?.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      body,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`dsh-desktop-shell: control call ${path} failed with ${response.status}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async hello(payload: ControlHello): Promise<void> {
    await this.request(CONTROL_ENDPOINTS.hello, { method: 'POST', json: payload });
  }

  async attachWebView(url: string): Promise<void> {
    await this.request(CONTROL_ENDPOINTS.webviewAttach, { method: 'POST', json: { url } });
  }

  async killHost(): Promise<void> {
    await this.request(CONTROL_ENDPOINTS.hostStop, { method: 'POST' });
  }

  async restartHost(opts?: SpawnOptions): Promise<HostEndpoint> {
    return this.request<HostEndpoint>(CONTROL_ENDPOINTS.hostRestart, { method: 'POST', json: opts ?? {} });
  }

  async spawnHost(opts?: SpawnOptions): Promise<HostEndpoint> {
    // The shell owns the spawn; from the plugin's view a fresh spawn is a restart.
    return this.restartHost(opts);
  }

  async getProfile(): Promise<Profile> {
    return this.request<Profile>(CONTROL_ENDPOINTS.hello, { method: 'GET' });
  }

  onWindowClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  /** Long-poll pump delivering shell → plugin events. Runs until dispose(). */
  startPump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    while (!this.disposed) {
      try {
        const batch = await this.request<ControlEventBatch>(CONTROL_ENDPOINTS.events, {
          method: 'GET',
          signal: AbortSignal.timeout(CONTROL_EVENTS_LONGPOLL_MS + CONTROL_TIMEOUT_MS),
        });
        for (const event of batch?.events ?? []) {
          this.dispatch(event);
        }
      } catch (error) {
        if (this.disposed) return;
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private dispatch(event: ControlEvent): void {
    if (event.type === 'window-close') {
      for (const handler of this.closeHandlers) {
        try {
          handler();
        } catch {
          // a faulty subscriber must not kill the pump
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeHandlers.clear();
  }
}

/**
 * Fallback service handed out when the plugin runs without the shell env
 * (e.g. `dsh web` started by a human in a terminal). Calls fail loudly with
 * an actionable message instead of hanging.
 */
export function unavailableDesktopRuntime(profile: string): DesktopRuntimeService {
  const fail = async (): Promise<never> => {
    throw new ControlUnavailableError(
      `set ${CONTROL_URL_ENV}/${CONTROL_TOKEN_ENV} (provided by the dsh-desktop shell); current profile: ${profile}`,
    );
  };
  return {
    spawnHost: () => fail(),
    killHost: () => fail(),
    restartHost: () => fail(),
    attachWebView: () => fail(),
    getProfile: async () => ({ name: profile, path: '', bundles: [] }),
    onWindowClose: () => () => undefined,
  };
}

/** Wire a DesktopRuntimeService onto an established control client. */
export function createDesktopRuntime(client: ControlClient): DesktopRuntimeService {
  return {
    spawnHost: (opts) => client.spawnHost(opts),
    killHost: () => client.killHost(),
    restartHost: (opts) => client.restartHost(opts),
    attachWebView: (url) => client.attachWebView(url),
    getProfile: () => client.getProfile(),
    onWindowClose: (cb) => client.onWindowClose(cb),
  };
}

export { CONTROL_PROTOCOL_VERSION };
