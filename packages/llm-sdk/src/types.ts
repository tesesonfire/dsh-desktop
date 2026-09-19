/**
 * Provider-neutral LLM types, aligned with the official DSH protocol
 * (deepseek-harness packages/llm/llm/src/message.ts + types.ts, ddefc45f):
 * messages are immutable with merge-extensible content blocks; tools declare
 * JSON Schema parameters. New core blocks must land upstream first.
 */

export type MessageRole = 'system' | 'user' | 'assistant';

export interface TextBlock { readonly type: 'text'; readonly text: string }
export interface ReasoningBlock { readonly type: 'reasoning'; readonly text: string }
export interface ImageBlock { readonly type: 'image'; readonly mediaType: string; readonly data: string }
export interface FileBlock { readonly type: 'file'; readonly mediaType: string; readonly data: string; readonly name?: string }
export interface ToolCallBlock { readonly type: 'tool-call'; readonly toolCallId: string; readonly name: string; readonly arguments: string }
export interface ToolResultBlock { readonly type: 'tool-result'; readonly toolCallId: string; readonly content: unknown; readonly isError?: boolean }

export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | FileBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
}

/** Official ToolSchema — parameters is a JSON Schema object. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
}

export interface ChatDelta {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCall?:
    | { kind: 'start'; toolCallId: string; name: string }
    | { kind: 'arguments-delta'; toolCallId: string; delta: string };
}

export interface LlmProvider {
  readonly id: string;
  /** Streams one assistant turn; providers must honor request.signal. */
  stream(request: ChatRequest): AsyncIterable<ChatDelta>;
}

export function text(text: string): TextBlock {
  return { type: 'text', text };
}
