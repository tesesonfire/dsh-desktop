/**
 * ControlServer — the loopback HTTP control channel between the platform shell
 * and the in-host desktop-shell Cordis plugin.
 *
 * - listens on 127.0.0.1 with an OS-assigned random port
 * - every request must carry the per-launch token in the
 *   x-dsh-desktop-control header (timing-safe compare); anything else -> 403
 * - routes are the canonical CONTROL_ENDPOINTS from @dsh-desktop/protocol
 * - GET /v0/events long-polls for up to CONTROL_EVENTS_LONGPOLL_MS and drains
 *   the queued ControlEvents (window-close is enqueued by the main window's
 *   close request).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CONTROL_ENDPOINTS,
  CONTROL_EVENTS_LONGPOLL_MS,
  CONTROL_TOKEN_HEADER,
  isSameOrigin,
  type ControlEvent,
  type ControlEventBatch,
  type ControlHello,
  type HostEndpoint,
  type Profile,
} from '@dsh-desktop/protocol';

export interface ControlServerHandlers {
  /** Called for POST /v0/hello. */
  onHello?: (hello: ControlHello) => void;
  /** Current profile for GET /v0/hello; null -> 503 (shell not ready). */
  currentProfile: () => Profile | null;
  /** POST /v0/webview/attach with an already same-origin-validated URL. */
  attach: (url: string) => void | Promise<void>;
  stopHost: () => void | Promise<void>;
  restartHost: () => Promise<HostEndpoint> | HostEndpoint;
}

interface Waiter {
  resolve: (batch: ControlEventBatch) => void;
  timer: NodeJS.Timeout;
}

export class ControlServer {
  readonly token: string;
  private readonly server: Server;
  private handlers: ControlServerHandlers | null = null;
  private readyOrigin: string | null = null;
  private hello: ControlHello | null = null;
  private eventQueue: ControlEvent[] = [];
  private waiters: Waiter[] = [];

  helloSeen = false;
  webviewAttached = false;

  /**
   * Mark the web view attached from the shell side: the shell attaches the
   * ready URL itself right after parsing the ready line, while the plugin's
   * POST /v0/webview/attach route is the other path. One source of truth for
   * the smoke gate either way.
   */
  markAttached(): void {
    this.webviewAttached = true;
  }

  constructor() {
    this.token = randomBytes(32).toString('base64url');
    this.server = createServer((req, res) => {
      void this.dispatch(req, res).catch(() => {
        this.respond(res, 500, 'control server internal error');
      });
    });
    // Do not keep the event loop alive just for the control channel.
    this.server.unref();
  }

  get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('control server is not listening');
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('control server is not listening');
    }
    return address.port;
  }

  get helloInfo(): ControlHello | null {
    return this.hello === null ? null : { ...this.hello };
  }

  /** The ready-line origin gates /v0/webview/attach. */
  setReadyOrigin(origin: string): void {
    this.readyOrigin = origin;
  }

  async start(handlers: ControlServerHandlers): Promise<void> {
    this.handlers = handlers;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ events: [] });
    }
    this.waiters = [];
    this.eventQueue = [];
    if (this.server.listening) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }

  enqueueEvent(event: ControlEvent): void {
    this.eventQueue.push(event);
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.eventQueue.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.resolve({ events: this.eventQueue.splice(0) });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers[CONTROL_TOKEN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (provided === undefined || provided.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(this.token, 'utf8'));
  }

  private respond(res: ServerResponse, status: number, body?: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) {
          reject(new Error('control request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(text) as unknown);
        } catch {
          reject(new Error('control request body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const method = req.method ?? '';

    if (!this.authorized(req)) {
      this.respond(res, 403, { error: 'control token mismatch' });
      return;
    }

    if (path === CONTROL_ENDPOINTS.hello) {
      if (method === 'POST') {
        const body = (await this.readJson(req)) as Partial<ControlHello> | undefined;
        if (body === null || typeof body !== 'object' || typeof body.pid !== 'number' || typeof body.profile !== 'string') {
          this.respond(res, 400, { error: 'hello requires {pid, webPort, profile}' });
          return;
        }
        this.hello = {
          pid: body.pid,
          webPort: typeof body.webPort === 'number' ? body.webPort : 0,
          profile: body.profile,
          protocolVersion: body.protocolVersion ?? 1,
        };
        this.helloSeen = true;
        this.handlers?.onHello?.(this.hello);
        this.respond(res, 204);
        return;
      }
      if (method === 'GET') {
        const profile = this.handlers?.currentProfile() ?? null;
        if (profile === null) {
          this.respond(res, 503, { error: 'shell has not resolved a profile yet' });
          return;
        }
        this.respond(res, 200, profile);
        return;
      }
      this.respond(res, 405);
      return;
    }

    if (path === CONTROL_ENDPOINTS.webviewAttach) {
      if (method !== 'POST') {
        this.respond(res, 405);
        return;
      }
      const body = (await this.readJson(req)) as { url?: unknown } | undefined;
      const url = typeof body?.url === 'string' ? body.url : undefined;
      if (url === undefined || url.length === 0) {
        this.respond(res, 400, { error: 'attach requires {url}' });
        return;
      }
      if (this.readyOrigin === null) {
        this.respond(res, 409, { error: 'host ready line not observed yet' });
        return;
      }
      if (!isSameOrigin(url, this.readyOrigin)) {
        this.respond(res, 403, { error: `attach URL is not same-origin with ${this.readyOrigin}` });
        return;
      }
      await this.handlers?.attach(url);
      this.webviewAttached = true;
      this.respond(res, 204);
      return;
    }

    if (path === CONTROL_ENDPOINTS.hostStop) {
      if (method !== 'POST') {
        this.respond(res, 405);
        return;
      }
      await this.handlers?.stopHost();
      this.respond(res, 204);
      return;
    }

    if (path === CONTROL_ENDPOINTS.hostRestart) {
      if (method !== 'POST') {
        this.respond(res, 405);
        return;
      }
      const handlers = this.handlers;
      if (handlers === null) {
        this.respond(res, 503, { error: 'control server has no handlers' });
        return;
      }
      const endpoint = await handlers.restartHost();
      this.respond(res, 200, { port: endpoint.port, url: endpoint.url });
      return;
    }

    if (path === CONTROL_ENDPOINTS.events) {
      if (method !== 'GET') {
        this.respond(res, 405);
        return;
      }
      if (this.eventQueue.length > 0) {
        this.respond(res, 200, { events: this.eventQueue.splice(0) } satisfies ControlEventBatch);
        return;
      }
      // Long-poll: resolve with the drained batch as soon as an event is
      // enqueued, an empty batch after CONTROL_EVENTS_LONGPOLL_MS, or null
      // when the client went away (nothing to respond to).
      const batch = await new Promise<ControlEventBatch | null>((resolve) => {
        const waiter: Waiter = {
          resolve: (resolved) => {
            cleanup();
            resolve(resolved);
          },
          timer: undefined as unknown as NodeJS.Timeout,
        };
        const cleanup = (): void => {
          clearTimeout(waiter.timer);
          res.off('close', onClose);
        };
        const onClose = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          cleanup();
          resolve(null);
        };
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          cleanup();
          resolve({ events: [] });
        }, CONTROL_EVENTS_LONGPOLL_MS);
        res.once('close', onClose);
        this.waiters.push(waiter);
      });
      if (batch !== null) this.respond(res, 200, batch);
      return;
    }

    this.respond(res, 404, { error: `unknown control route ${path}` });
  }
}
