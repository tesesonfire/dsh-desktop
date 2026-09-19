import { describe, expect, it } from 'vitest';
import { AgentRuntime, SessionService, type SessionSink, type SessionEvent } from '../src/index.js';

class MemorySink implements SessionSink {
  readonly log = new Map<string, SessionEvent[]>();
  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const list = this.log.get(sessionId) ?? [];
    list.push(event);
    this.log.set(sessionId, list);
  }
  async readAll(sessionId: string): Promise<SessionEvent[]> {
    return this.log.get(sessionId) ?? [];
  }
}

describe('SessionService', () => {
  it('appends monotonic seqs and keeps order', async () => {
    const service = new SessionService();
    await service.append('s1', 'user/message', { text: 'hi' });
    await service.append('s1', 'assistant/message', { text: 'hello' });
    const events = await service.events('s1');
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]?.type).toBe('user/message');
  });

  it('mirrors appends into a sink and replays cold', async () => {
    const sink = new MemorySink();
    const service = new SessionService({ sink });
    const runtime = new AgentRuntime(service);
    await runtime.runTurn({ sessionId: 's2', userMessage: 'draft a plan' });

    const persisted = await sink.readAll('s2');
    expect(persisted.map((e) => e.type)).toEqual(['turn/start', 'user/message', 'assistant/message', 'turn/end']);

    const cold = new SessionService({ sink });
    await cold.replay('s2', persisted);
    const events = await cold.events('s2');
    expect(events).toHaveLength(4);
    // seq counter continues after replay
    const next = await cold.append('s2', 'user/message', { text: 'again' });
    expect(next.seq).toBe(5);
  });
});
