/**
 * Event normalizer: translates DSH `session/event` / `assistant/chunk`
 * payloads into the plugin's unified message stream used by the renderer.
 *
 * Live facts (verified by probe on dsh 0.1.2-rc.1):
 * - `session/event` fires for every persisted event with the full lifecycle:
 *   turn/start, step/start, user/message, assistant/chunk (token deltas),
 *   assistant/message (final), step/end, turn/end, … plus approval/policy,
 *   permission/preset etc.
 * - `assistant/chunk` events carry `data.chunk: StreamChunk`:
 *   text-delta | reasoning-delta | tool-call-delta | block-start | block-end | usage | finish.
 * - `agent/assistant-stream` does NOT fire on headless profiles (verified), so
 *   incremental presence comes from the `assistant/chunk` events instead.
 *
 * @module core/event-normalizer
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One normalized outbound message for the renderer/delivery. */
export type NormalizedMessage =
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-call-delta'; name: string; argumentsDelta: string }
  | { kind: 'assistant-final'; text: string }
  | { kind: 'status'; status: 'running' | 'done' | 'cancelled' | 'error'; detail?: string }
  | { kind: 'approval'; summary: string }
  | { kind: 'user-message'; text: string }

/** Normalize one assistant/chunk's StreamChunk into a message. */
export function normalizeChunk(chunk: StreamChunk): NormalizedMessage | undefined {
  switch (chunk.type) {
    case 'text-delta':
      return { kind: 'text-delta', text: chunk.text }
    case 'reasoning-delta':
      return { kind: 'reasoning-delta', text: chunk.text }
    case 'tool-call-delta': {
      const name = chunk.name ?? ''
      // The first tool-call-delta of a call carries the name (or an empty
      // name with an id); subsequent ones carry only arguments.
      return { kind: 'tool-call-delta', name, argumentsDelta: chunk.argumentsDelta }
    }
    case 'block-start':
    case 'block-end':
    case 'usage':
    case 'finish':
      return undefined
  }
}

/**
 * Normalize a persisted `session/event` into a message, when the event type
 * is one we surface. Returns undefined for noise we do not forward.
 */
export function normalizeSessionEvent(event: SessionEvent): NormalizedMessage | undefined {
  switch (event.type) {
    case 'turn/start':
      return { kind: 'status', status: 'running' }
    case 'turn/end': {
      // turn/end carries no success flag on this version; the final
      // assistant/message marks completion, and errors surface separately.
      return { kind: 'status', status: 'done' }
    }
    case 'user/message': {
      const text = extractUserText(event)
      if (text === undefined) return undefined
      return { kind: 'user-message', text }
    }
    case 'assistant/message': {
      const text = extractAssistantText(event)
      if (text === undefined) return undefined
      return { kind: 'assistant-final', text }
    }
    default:
      return undefined
  }
}

/** Concatenated text blocks of the assistant message content. */
function extractAssistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter(block => block.type === 'text')
  if (blocks.length === 0) return undefined
  return blocks.map(block => block.text).join('')
}

/** User message text from a user/message event (may carry multi-block content). */
function extractUserText(event: Extract<SessionEvent, { type: 'user/message' }>): string | undefined {
  const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
  const blocks = data.message?.content?.filter(block => block.type === 'text') ?? []
  if (blocks.length === 0) return undefined
  return blocks.map(block => block.text ?? '').join('')
}