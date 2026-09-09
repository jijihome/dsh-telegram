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

/**
 * A turn-terminating status that is NOT a clean success. The plugin surfaces
 * each interruption cause as a distinct line so the bot always learns why a
 * turn ended (cancel / error / blocked / token ceiling / crash-orphaned).
 */
export type TerminalStatus = 'cancelled' | 'error' | 'blocked' | 'max-tokens' | 'interrupted'

/** One normalized outbound message for the renderer/delivery. */
export type NormalizedMessage =
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-call-delta'; name: string; argumentsDelta: string }
  | { kind: 'assistant-final'; text: string; interrupted?: boolean }
  | { kind: 'status'; status: 'running' | 'done' | TerminalStatus; detail?: string }
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
    case 'turn/end':
      // `turn/end` carries the authoritative `reason` (completed / aborted /
      // blocked / error / max-tokens / interrupted). Map it so interruption
      // causes surface instead of being flattened into "done".
      return normalizeTurnEndReason(event.data.reason) ?? { kind: 'status', status: 'done' }
    case 'user/message': {
      const text = extractUserText(event)
      if (text === undefined) return undefined
      return { kind: 'user-message', text }
    }
    case 'assistant/message': {
      const text = extractAssistantText(event)
      if (text === undefined) return undefined
      // `interrupted: true` marks a partial answer from a turn cancelled
      // mid-stream; keep the delivered prefix but flag it.
      return { kind: 'assistant-final', text, interrupted: event.data.interrupted === true }
    }
    default:
      return undefined
  }
}

/**
 * Map a `turn/end` reason to a status message. Returns **undefined** for a
 * clean `completed` (the caller then emits `done`), and a specific status for
 * every interruption cause. Unknown reasons are treated leniently as success.
 */
function normalizeTurnEndReason(reason: unknown): NormalizedMessage | undefined {
  const kind = (reason as { kind?: string } | undefined)?.kind
  switch (kind) {
    case 'completed':
    case undefined:
    case null:
      return undefined
    case 'aborted':
      return { kind: 'status', status: 'cancelled', detail: cancelCauseLabel((reason as { reason?: unknown }).reason) }
    case 'error':
      return { kind: 'status', status: 'error', detail: errorMessage((reason as { error?: unknown }).error) }
    case 'blocked':
      return { kind: 'status', status: 'blocked' }
    case 'max-tokens':
      return { kind: 'status', status: 'max-tokens' }
    case 'interrupted':
      return { kind: 'status', status: 'interrupted' }
    default:
      // Unknown future reason type: surface as a clean end rather than explode.
      return undefined
  }
}

/** Human label for the `aborted` cancellation cause (user / parent / hook / disposed). */
function cancelCauseLabel(cause: unknown): string {
  const kind = (cause as { kind?: string } | undefined)?.kind
  switch (kind) {
    case 'user': return '用户 /stop 取消'
    case 'parent': return '父级取消'
    case 'hook': return '钩子取消'
    case 'disposed': return 'agent 已释放'
    case 'legacy': return '取消'
    default: return '取消'
  }
}

/** Flatten a failure to a short message (LlmFailure has `message` and `code`). */
function errorMessage(error: unknown): string {
  const e = (error ?? undefined)
  if (e instanceof Error) return errorMessage(e.message)
  if (typeof e === 'string') return e
  if (e !== null && typeof e === 'object') {
    const obj = e as { message?: unknown; code?: unknown }
    const message = typeof obj.message === 'string' ? obj.message : ''
    const code = typeof obj.code === 'string' ? obj.code : ''
    if (message !== '' && code !== '') return `${message} (${code})`
    return message || code || '未知错误'
  }
  return '未知错误'
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