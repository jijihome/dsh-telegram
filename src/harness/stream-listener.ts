/**
 * Stream listener: subscribes to DSH `session/event` (global) and routes
 * every event that belongs to one of our chat bindings through the
 * event normalizer into the delivery layer.
 *
 * Verified on dsh 0.1.2-rc.1 (headless profile): `session/event` fires for
 * the whole lifecycle; incremental model output arrives as
 * `assistant/chunk` events whose `data.chunk` is a StreamChunk
 * (text-delta / reasoning-delta / tool-call-delta). `agent/assistant-stream`
 * does not fire on headless, so we do not depend on it.
 *
 * @module harness/stream-listener
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeChunk, normalizeSessionEvent } from '../core/event-normalizer.js'
import type { NormalizedMessage } from '../core/event-normalizer.js'
import type { SessionManager } from '../core/session-manager.js'
import type { Delivery } from '../telegram/delivery.js'

export interface StreamListenerOptions {
  ctx: Context
  sessions: SessionManager
  /** One delivery per bot, keyed by bot id. */
  deliveries: ReadonlyMap<string, Delivery>
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

/** Subscribes to session/event and fans normalized messages out to deliveries. */
export class StreamListener {
  private readonly ctx: Context
  private readonly sessions: SessionManager
  private readonly deliveries: ReadonlyMap<string, Delivery>
  private readonly logger: StreamListenerOptions['logger'] | undefined
  private disposer: (() => void) | undefined

  constructor(options: StreamListenerOptions) {
    this.ctx = options.ctx
    this.sessions = options.sessions
    this.deliveries = options.deliveries
    this.logger = options.logger
  }

  start(): void {
    if (this.disposer !== undefined) return
    this.disposer = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      try {
        this.handle(session, event)
      } catch (error) {
        this.logger?.warn(`[tg] session event handling failed: ${String(error)}`)
      }
    }, { global: true })
    // Agent-level diagnostics: driver state transitions and errors are NOT
    // part of session/event — kick() swallows turn failures into agent/error.
    this.ctx.on('agent/status', (payload: { agent?: { session?: Session }; status: string }) => {
      const sessionId = String(payload.agent?.session?.id ?? '?')
      this.logger?.warn(`[tg] agent/status ${payload.status} for ${sessionId}`)
    })
    this.ctx.on('agent/error', (payload: { turn?: number; step?: number; error: unknown }) => {
      this.logger?.warn(`[tg] agent/error turn=${payload.turn ?? '-'} step=${payload.step ?? '-'}: ${String(payload.error)}`)
    })
  }

  stop(): void {
    if (this.disposer !== undefined) {
      this.disposer()
      this.disposer = undefined
    }
  }

  private handle(session: Session, event: SessionEvent): void {
    const binding = this.sessions.bySessionId(String(session.id))
    if (binding === undefined) {
      // Diagnostic: session events we are not bound to (noise), logged once
      // per distinct session id to avoid flooding.
      this.logger?.warn(`[tg] unbound session event ${event.type} for ${String(session.id)}`)
      return
    }
    // Trace the important lifecycle events through the bound path so the
    // daemon log shows whether a turn actually starts and finishes.
    // (Runtime event types are wider than the SessionEvent union.)
    const type: string = event.type
    if (type === 'turn/start' || type === 'turn/end' ||
        type === 'assistant/message' || type === 'step/start' ||
        type === 'step/end' || type === 'session/error' ||
        type === 'turn/error') {
      this.logger?.warn(`[tg] event ${type} for ${String(session.id)}`)
    }
    const delivery = this.deliveries.get(binding.botId)
    if (delivery === undefined) return
    const chatId = binding.chatId

    // 1. Chunk events drive the live streaming segment.
    if (event.type === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: unknown }).chunk as never
      const message: NormalizedMessage | undefined = normalizeChunk(chunk)
      if (message === undefined) return
      void this.apply(chatId, delivery, message)
      return
    }

    // 2. All other events: normalize then dispatch.
    const message = normalizeSessionEvent(event)
    if (message === undefined) return
    void this.apply(chatId, delivery, message)
  }

  /** Apply one normalized message to the chat's delivery. */
  private async apply(chatId: number, delivery: Delivery, message: NormalizedMessage): Promise<void> {
    switch (message.kind) {
      case 'text-delta':
        await delivery.appendDelta(chatId, message.text)
        break
      case 'reasoning-delta':
        // Reasoning deltas stream into the same live segment with a marker.
        await delivery.appendDelta(chatId, message.text)
        break
      case 'tool-call-delta':
        // Overlay: append tool name + argument text into the live segment.
        if (message.name !== '') await delivery.appendDelta(chatId, `\n🛠 ${message.name}`)
        await delivery.appendDelta(chatId, message.argumentsDelta)
        break
      case 'assistant-final':
        await delivery.endLive(chatId)
        await delivery.sendFinal(chatId, message.text)
        break
      case 'status':
        if (message.status === 'running') {
          await delivery.typing(chatId)
        } else if (message.status === 'done') {
          await delivery.endLive(chatId)
        }
        break
      case 'approval':
        await delivery.endLive(chatId)
        await delivery.sendFinal(chatId, `🔐 ${message.summary}`)
        break
      case 'user-message':
        // Echo of our own forwarded text; keep it out of the stream.
        break
    }
  }
}