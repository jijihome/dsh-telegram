/**
 * Renderer: turns normalized messages into human-readable Telegram display
 * text. Pure and synchronous for easy testing.
 *
 * @module core/renderer
 */

import type { NormalizedMessage } from './event-normalizer.js'

/** Per-chat live rendering state: reasoning/tool buffers that accompany the text stream. */
export interface RenderState {
  /** Currently visible tool call name (reset on block-end/assistant-final). */
  toolName?: string
  /** Prefix marker so the live segment reads as e.g. `> tool_name ...`. */
}

/**
 * Render one normalized message into a display line (or undefined for pure
 * deltas that the delivery layer already appends directly).
 *
 * Design: text-delta and reasoning-delta are *streamed* (delivery appends
 * them raw), so renderer only produces discrete status/echo lines:
 * - tool-call-delta → inline overlay line
 * - assistant-final → the final answer (delivery sends it as a fresh message)
 * - status → status line
 * - approval → approval line
 * - user-message → echo line
 */
export function renderMessage(message: NormalizedMessage, state: RenderState): string | undefined {
  switch (message.kind) {
    case 'text-delta':
    case 'reasoning-delta':
      // Streamed raw by delivery; nothing to render as a separate line.
      return undefined
    case 'tool-call-delta': {
      if (message.name !== '') state.toolName = message.name
      const name = state.toolName ?? 'tool'
      return `🛠 <code>${escapeDisplay(name)}</code> ${message.argumentsDelta}`
    }
    case 'assistant-final':
      state.toolName = undefined
      return message.text
    case 'status':
      switch (message.status) {
        case 'running':
          return '⏳ agent 开始运行…'
        case 'done':
          return '✅ 完成'
        case 'cancelled':
          return '⛔ 已取消'
        case 'error':
          return `❌ 错误${message.detail ? `: ${message.detail}` : ''}`
      }
      break
    case 'approval':
      return `🔐 审批:${message.summary}`
    case 'user-message':
      return `🧑 {quote}${message.text}`
  }
}

/** Escape angle brackets for display inside <code> spans. */
function escapeDisplay(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Short summary of a LiveState line prefix for the streaming segment. */
export function renderSegmentHeader(state: RenderState): string {
  return state.toolName !== undefined ? `🛠 ${state.toolName}` : '🤖'
}