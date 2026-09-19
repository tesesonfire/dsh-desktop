/** JSON-RPC 2.0 + MCP surface used by the desktop shell. */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly content: { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

export interface Transport {
  start(): Promise<void>;
  send(message: JsonRpcRequest): Promise<void>;
  onMessage(handler: (message: JsonRpcResponse) => void): void;
  close(): Promise<void>;
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}
