/**
 * Session/agent façades over the OFFICIAL DSH model.
 *
 * Scope guard (PLAN.md 砍单): we do NOT build our own agent runtime. The real
 * loop lives inside the DSH Host. These façades exist so UI code and tests can
 * type against the official event vocabulary
 * (deepseek-harness packages/core/session/src/known-event-types.ts) without
 * importing the upstream monorepo.
 */

export type SessionRole = 'user' | 'assistant' | 'system';

/** The subset of official session events a desktop UI renders today. */
export type SessionEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'turn/start'
  | 'turn/end'
  | 'session/title';

export interface SessionEvent {
  readonly seq: number;
  readonly type: SessionEventType;
  readonly at: number;
  /** Event payload — official format is versioned upstream; kept opaque here. */
  readonly data: unknown;
}

/** Where a session's events are durably appended (see @dsh-desktop/session-store). */
export interface SessionSink {
  append(sessionId: string, event: SessionEvent): Promise<void>;
  readAll(sessionId: string): Promise<SessionEvent[]>;
}

export interface SessionServiceOptions {
  sink?: SessionSink;
  now?: () => number;
}

export class SessionService {
  private readonly memory = new Map<string, SessionEvent[]>();
  private readonly seqBySession = new Map<string, number>();
  private readonly sink: SessionSink | undefined;
  private readonly now: () => number;

  constructor(options: SessionServiceOptions = {}) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
  }

  async append(sessionId: string, type: SessionEventType, data: unknown): Promise<SessionEvent> {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    const event: SessionEvent = { seq, type, at: this.now(), data };
    const events = this.memory.get(sessionId) ?? [];
    events.push(event);
    this.memory.set(sessionId, events);
    await this.sink?.append(sessionId, event);
    return event;
  }

  async events(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.memory.get(sessionId) ?? [])];
  }

  /**
   * Replay a persisted log into memory (cold start path). Events are taken as
   *-is; the seq counter continues from the highest observed seq.
   */
  async replay(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    const maxSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);
    this.memory.set(sessionId, [...events]);
    this.seqBySession.set(sessionId, Math.max(maxSeq, this.seqBySession.get(sessionId) ?? 0));
  }
}

/** Tool surface a UI/test harness can drive; the real executor is upstream. */
export interface ToolInvocation {
  readonly name: string;
  readonly args: unknown;
}

export type ToolExecutor = (invocation: ToolInvocation) => Promise<unknown>;

/**
 * Agent-loop façade. TODO(upstream-agent-loop): the official DSH Host owns the
 * real loop (ctx.agents / llm / tools); this façade deliberately only models
 * one turn so desktop tests can simulate assistant turns without a model.
 */
export interface AgentTurn {
  readonly sessionId: string;
  readonly userMessage: string;
  readonly toolExecutor?: ToolExecutor;
}

export class AgentRuntime {
  constructor(private readonly sessions: SessionService) {}

  async runTurn(turn: AgentTurn): Promise<void> {
    await this.sessions.append(turn.sessionId, 'turn/start', {});
    await this.sessions.append(turn.sessionId, 'user/message', { text: turn.userMessage });
    // TODO(upstream-agent-loop): delegate to the DSH Host over the gateway in a
    // later milestone; the desktop shell must never run its own model loop.
    await this.sessions.append(turn.sessionId, 'assistant/message', {
      text: '(agent loop is owned by the DSH Host; this façade records turns only)',
    });
    await this.sessions.append(turn.sessionId, 'turn/end', {});
  }
}
