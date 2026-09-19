/**
 * "Open terminal" (desktop-terminal analog, slimmed): resolve the platform's
 * terminal launcher and start a visible console in a working directory.
 * Command resolution is pure and unit-tested; the real spawn happens only on
 * user action. The terminal is an independent process — nothing is injected
 * into any web surface.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface TerminalCommand {
  command: string;
  args: string[];
  /** On Windows the broker itself must stay hidden while the child is visible. */
  windowsHide: boolean;
}

/** Windows: Windows Terminal → pwsh → powershell → cmd, launched via `start`. */
export function resolveWindowsTerminal(
  dir: string,
  pathEnv: string,
  comspec: string | undefined,
  existsImpl: (path: string) => boolean = existsSync,
): TerminalCommand {
  const quotedDir = `"${dir}"`;
  for (const name of ['wt.exe', 'pwsh.exe', 'powershell.exe']) {
    for (const dirEntry of pathEnv.split(delimiter)) {
      if (dirEntry.length === 0) continue;
      if (existsImpl(join(dirEntry, name))) {
        // wt/pwsh/powershell keep their own console visible; broker hides.
        return { command: name, args: ['-d', dir], windowsHide: false };
      }
    }
  }
  const shell = comspec ?? 'cmd.exe';
  return { command: shell, args: ['/c', 'start', '', 'cmd.exe', '/k', `cd /d ${quotedDir}`], windowsHide: true };
}

export function resolveTerminalCommand(
  dir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsImpl: (path: string) => boolean = existsSync,
): TerminalCommand {
  if (platform === 'win32') {
    return resolveWindowsTerminal(dir, env['PATH'] ?? '', env['ComSpec'], existsImpl);
  }
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Terminal', dir], windowsHide: false };
  }
  for (const name of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal']) {
    for (const dirEntry of (env['PATH'] ?? '').split(delimiter)) {
      if (dirEntry.length === 0) continue;
      if (existsImpl(join(dirEntry, name))) {
        // gnome-terminal/konsole accept --working-directory; xterm-family varies.
        return { command: name, args: [name === 'xfce4-terminal' ? '--default-working-directory' : '--working-directory', dir], windowsHide: false };
      }
    }
  }
  throw new Error('no terminal emulator found on PATH');
}

/** Start a visible terminal in `dir`. Resolves after the spawn (not the session). */
export async function openTerminalIn(dir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const resolved = resolveTerminalCommand(dir, platform, env);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: dir,
      env,
      detached: true,
      windowsHide: resolved.windowsHide,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
