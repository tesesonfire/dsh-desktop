import type { ChatDelta, ChatRequest, LlmProvider } from './types.js';

/**
 * Minimal SSE parser for OpenAI-compatible `data:` streams. Exposed for tests
 * and for providers that hand us the raw byte stream.
 */
export function parseSseChunk(chunk: string): string[] {
  const events: string[] = [];
  for (const rawEvent of chunk.split('\n\n')) {
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) {
        events.push(line.slice(5).trimStart());
      }
    }
  }
  return events;
}

interface OpenAiStreamChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

/**
 * One OpenAI-compatible streaming provider (works for DeepSeek and any
 * /chat/completions backend). TODO(upstream-gateway): in the desktop product
 * the DSH Host mediates all model traffic (ctx.llm); this provider exists for
 * tests and optional direct-provider tooling, never as a second runtime.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content.map((b) => ('text' in b ? b.text : JSON.stringify(b))) })),
        tools: request.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        stream: true,
      }),
      signal: request.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`llm-sdk: ${this.id} stream failed with ${response.status}`);
    }
    const toolNames = new Map<number, string>();
    for await (const event of sseDataEvents(response.body)) {
      if (event === '[DONE]') return;
      let parsed: { choices?: { delta?: OpenAiStreamChoiceDelta }[] };
      try {
        parsed = JSON.parse(event) as typeof parsed;
      } catch {
        continue;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (delta === undefined) continue;
      if (delta.content) yield { text: delta.content };
      if (delta.reasoning_content) yield { reasoning: delta.reasoning_content };
      for (const call of delta.tool_calls ?? []) {
        if (call.id !== undefined && call.function?.name !== undefined) {
          toolNames.set(call.index, call.function.name);
          yield { toolCall: { kind: 'start', toolCallId: call.id, name: call.function.name } };
        } else if (call.function?.arguments !== undefined) {
          const name = toolNames.get(call.index) ?? '';
          yield { toolCall: { kind: 'arguments-delta', toolCallId: `${name}#${String(call.index)}`, delta: call.function.arguments } };
        }
      }
    }
  }
}

async function* sseDataEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = parseSseChunk(buffer);
    buffer = buffer.includes('\n\n') ? buffer.slice(buffer.lastIndexOf('\n\n') + 2) : '';
    for (const event of events) yield event;
  }
}
