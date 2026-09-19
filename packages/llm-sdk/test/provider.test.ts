import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, parseSseChunk } from '../src/provider.js';
import type { Message } from '../src/types.js';

describe('parseSseChunk', () => {
  it('extracts data lines across events', () => {
    expect(parseSseChunk('data: {"a":1}\n\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]']);
    expect(parseSseChunk('event: x\ndata: 1\n\n')).toEqual(['1']);
    expect(parseSseChunk(': keep-alive\n\n')).toEqual([]);
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('streams text deltas and honors [DONE]', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const provider = new OpenAiCompatibleProvider('test', 'https://example.invalid/v1', 'k', (async () =>
      new Response(sse, { status: 200 })) as typeof fetch);
    const messages: Message[] = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const deltas = [];
    for await (const delta of provider.stream({ model: 'm', messages })) deltas.push(delta);
    expect(deltas.map((d) => d.text).join('')).toBe('Hello');
  });

  it('surfaces tool-call starts and argument deltas', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const provider = new OpenAiCompatibleProvider('test', 'https://example.invalid/v1', 'k', (async () =>
      new Response(sse, { status: 200 })) as typeof fetch);
    const messages: Message[] = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const deltas = [];
    for await (const delta of provider.stream({ model: 'm', messages })) deltas.push(delta);
    expect(deltas[0]).toEqual({ toolCall: { kind: 'start', toolCallId: 'c1', name: 'get_weather' } });
    expect(deltas[1]?.toolCall?.kind).toBe('arguments-delta');
  });
});
