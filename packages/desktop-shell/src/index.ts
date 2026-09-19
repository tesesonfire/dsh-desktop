/**
 * dsh-desktop-shell — the DSH Cordis plugin loaded inside the DSH Host.
 *
 * It provides `ctx.desktopRuntime`, whose every method is a thin HTTP call
 * into the platform shell's control server (loopback, token-gated). The shell
 * passes DSH_DESKTOP_CONTROL_URL / DSH_DESKTOP_CONTROL_TOKEN via env before
 * spawning `dsh`; without them (a human running `dsh web` in a terminal) the
 * plugin degrades to loud-failure stubs.
 *
 * Cordis facts this relies on (verified against @deepseek-ai/cordis 4.0.2 and
 * deepseek-harness ddefc45f):
 *  - services are registered with ctx.provide (ctx.set is provider-only)
 *  - there is NO generic ctx.on('ready') event: `inject: ['webServer']`
 *    guarantees this plugin mounts only after the web server exists, so
 *    announcing in apply() IS the ready point.
 */
import type { Context } from '@deepseek-ai/cordis';
import { CONTROL_PROTOCOL_VERSION, type DesktopRuntimeService } from '@dsh-desktop/protocol';
import { ControlClient, createDesktopRuntime, unavailableDesktopRuntime } from './control-client.js';

export const name = 'dsh-desktop-shell';
export const inject = ['webServer'] as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopRuntime: DesktopRuntimeService;
    /** Minimal structural surface of @deepseek-ai/dsh-host-webserver. */
    webServer: { readonly port: number };
  }
}

export interface ApplyOptions {
  env?: NodeJS.ProcessEnv;
  pid?: number;
}

export function apply(ctx: Context, _config: unknown, options: ApplyOptions = {}): void {
  const env = options.env ?? process.env;
  const profile = env['DSH_PROFILE_NAME'] ?? 'web';
  const webPort = ctx.get('webServer')?.port ?? 0;

  const control = ControlClient.fromEnv(env);
  if (control === null) {
    ctx.provide('desktopRuntime', unavailableDesktopRuntime(profile));
    return;
  }

  ctx.provide('desktopRuntime', createDesktopRuntime(control));

  // Announce + start the shell→plugin event pump. apply() stays synchronous;
  // failures surface on the shell side via a missing hello, not a thrown
  // plugin mount (a flaky control server must not break DSH startup).
  void (async () => {
    try {
      await control.hello({
        pid: options.pid ?? process.pid,
        webPort,
        profile,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
      });
      control.startPump();
    } catch (error) {
      control.dispose();
      console.warn('[dsh-desktop-shell] control channel announce failed:', error);
    }
  })();
}
