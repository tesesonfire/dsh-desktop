#!/usr/bin/env node
// Minimal MCP server fixture for tests: initialize + two tools over stdio.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '0.1.0' } });
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [
        { name: 'echo', description: 'echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'fail', description: 'always errors', inputSchema: { type: 'object' } },
      ],
    });
  } else if (message.method === 'tools/call') {
    if (message.params?.name === 'echo') {
      reply(message.id, { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] });
    } else {
      reply(message.id, { content: [{ type: 'text', text: 'boom' }], isError: true });
    }
  }
});
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
