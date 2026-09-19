import { spawn } from 'node:child_process';
import type { JsonRpcRequest, JsonRpcResponse, Transport } from './types.js';

/**
 * stdio transport: newline-delimited JSON over a child process' stdin/stdout
 * (the MCP stdio convention). stderr is surfaced through onStderr for logging.
 */
export class StdioTransport implements Transport {
  private child: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private handler: ((message: JsonRpcResponse) => void) | null = null;
  private readonly stderrLines: string[] = [];

  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    private readonly options: { cwd?: string; env?: NodeJS.ProcessEnv; onStderr?: (line: string) => void } = {},
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, [...this.args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.deliver(line);
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length === 0) continue;
        this.stderrLines.push(line);
        this.options.onStderr?.(line);
      }
    });
  }

  private deliver(line: string): void {
    try {
      const parsed = JSON.parse(line) as JsonRpcResponse;
      this.handler?.(parsed);
    } catch {
      // non-JSON stdout is a protocol violation; keep the last lines for diagnostics
    }
  }

  onMessage(handler: (message: JsonRpcResponse) => void): void {
    this.handler = handler;
  }

  async send(message: JsonRpcRequest): Promise<void> {
    const child = this.child;
    if (child === null || child.stdin === null) throw new Error('mcp-client: transport not started');
    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => (error === undefined || error === null ? resolve() : reject(error)));
    });
  }

  recentStderr(): readonly string[] {
    return this.stderrLines.slice(-20);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    child.stdin?.end();
    child.kill();
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  }
}
