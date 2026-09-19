import { MCP_PROTOCOL_VERSION, McpError, type McpToolCallResult, type McpToolDefinition, type JsonRpcRequest, type JsonRpcResponse, type Transport } from './types.js';

export interface McpClientOptions {
  clientInfo: { name: string; version: string };
  requestTimeoutMs?: number;
}

/** Minimal MCP client: initialize → tools/list → tools/call. */
export class McpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private serverInfo: { name?: string; version?: string } | null = null;

  constructor(private readonly transport: Transport, private readonly options: McpClientOptions) {
    transport.onMessage((message) => {
      const pendingCall = this.pending.get(message.id);
      if (pendingCall === undefined) return;
      this.pending.delete(message.id);
      pendingCall.resolve(message);
    });
  }

  get info(): { name?: string; version?: string } | null {
    return this.serverInfo;
  }

  async start(): Promise<void> {
    await this.transport.start();
    const result = await this.request<{ serverInfo?: { name?: string; version?: string } }>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.options.clientInfo,
    });
    this.serverInfo = result.serverInfo ?? null;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request<{ tools?: McpToolDefinition[] }>('tools/list', {});
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    return this.request<McpToolCallResult>('tools/call', { name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const response = await Promise.race([
      new Promise<JsonRpcResponse>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.transport.send(message).catch(reject);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new McpError(`mcp-client: ${method} timed out`)), this.options.requestTimeoutMs ?? 10_000),
      ),
    ]);
    if (response.error !== undefined) {
      throw new McpError(`${method} failed: ${response.error.message}`, response.error.code);
    }
    return response.result as T;
  }
}
