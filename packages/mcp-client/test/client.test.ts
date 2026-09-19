import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/client.js';
import { StdioTransport } from '../src/stdio-transport.js';

const serverPath = join(import.meta.dirname, 'fixtures', 'mock-mcp-server.mjs');

describe('McpClient over stdio', () => {
  it('initializes, lists tools and calls one', { timeout: 20_000 }, async () => {
    const transport = new StdioTransport(process.execPath, [serverPath]);
    const client = new McpClient(transport, { clientInfo: { name: 'dsh-desktop-test', version: '0.0.0' } });
    try {
      await client.start();
      expect(client.info?.name).toBe('mock-mcp');
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo', 'fail']);
      const result = await client.callTool('echo', { text: 'ping' });
      expect(result.content[0]?.text).toBe('ping');
    } finally {
      await client.close();
    }
  });

  it('propagates tool errors', { timeout: 20_000 }, async () => {
    const transport = new StdioTransport(process.execPath, [serverPath]);
    const client = new McpClient(transport, { clientInfo: { name: 'dsh-desktop-test', version: '0.0.0' } });
    try {
      await client.start();
      const result = await client.callTool('fail');
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
