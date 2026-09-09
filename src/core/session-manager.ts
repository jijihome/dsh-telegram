/**
 * Session manager: owns one DSH agent session per Telegram chat.
 * - `getOrCreate` binds a chat to an agent (session id `telegram:<botId>:<chatId>`).
 * - `rotate` implements `/new` + `/clear`: disposes the old agent, starts a fresh one.
 * - `cancel` implements `/stop`: aborts the running turn via `agent.cancel`.
 * - On startup, bindings persisted by the StateStore are resumed via
 *   `ctx.agents.resume` so the conversation history survives a DSH restart.
 *
 * @module core/session-manager
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentFactoryLike } from '../harness/agent-factory.js'
import type { ChatState, StateStore } from './state-store.js'

export interface SessionBinding {
  /** Telegram chat id (numeric). */
  chatId: number
  /** Bot id owning this chat. */
  botId: string
  /** Current agent handle. */
  handle: AgentHandle
  /** Current session id; rotates on /new and /clear. */
  sessionId: string
  /** Working directory for this chat's agent. */
  cwd: string
  /** Monotonic rotation counter for session ids. */
  generation: number
}

export interface SessionManagerOptions {
  factory: AgentFactoryLike
  store: StateStore
  provider: string
  model: string
  defaultCwd: string
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

const sessionKey = (botId: string, chatId: number) => `${botId}:${chatId}`

/** Stable message text for logging. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Manages per-chat agent sessions. */
export class SessionManager {
  private readonly factory: AgentFactoryLike
  private readonly store: StateStore
  private readonly provider: string
  private readonly model: string
  private readonly defaultCwd: string
  private readonly logger: SessionManagerOptions['logger'] | undefined
  private readonly bindings = new Map<string, SessionBinding>()

  constructor(options: SessionManagerOptions) {
    this.factory = options.factory
    this.store = options.store
    this.provider = options.provider
    this.model = options.model
    this.defaultCwd = options.defaultCwd
    this.logger = options.logger
  }

  /** Live binding for a chat, or undefined. */
  get(chatId: number, botId: string): SessionBinding | undefined {
    return this.bindings.get(sessionKey(botId, chatId))
  }

  /** Find the binding owning a given DSH session id (for event routing). */
  bySessionId(sessionId: string): SessionBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId) return binding
    }
    return undefined
  }

  /**
   * Get the chat's agent, creating it if needed. On first creation it tries
   * to resume a persisted session; otherwise it starts a new one.
   */
  async getOrCreate(chatId: number, botId: string, cwd?: string): Promise<SessionBinding> {
    const key = sessionKey(botId, chatId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    return this.create(key, chatId, botId, cwd ?? this.defaultCwd, 0)
  }

  /** Rotate to a fresh session (`/new`); disposes the previous agent. */
  async rotate(chatId: number, botId: string): Promise<SessionBinding> {
    const key = sessionKey(botId, chatId)
    const previous = this.bindings.get(key)
    const generation = (previous?.generation ?? 0) + 1
    const binding = await this.create(key, chatId, botId, previous?.cwd ?? this.defaultCwd, generation)
    if (previous !== undefined) {
      await previous.handle.dispose().catch(error => {
        this.logger?.warn(`[tg] dispose old agent failed: ${messageOf(error)}`)
      })
    }
    return binding
  }

  /** Cancel the chat's current turn (`/stop`); no-op when idle. */
  cancel(chatId: number, botId: string): boolean {
    const binding = this.bindings.get(sessionKey(botId, chatId))
    if (binding === undefined) return false
    binding.handle.agent.cancel({ kind: 'user' })
    return true
  }

  /** Send a user text into the chat's agent (queued as a normal follow-up). */
  followup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): void {
    const binding = this.bindings.get(sessionKey(botId, chatId))
    if (binding === undefined) return
    try {
      binding.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      const status = (binding.handle.agent as { status?: string }).status
      this.logger?.warn(`[tg] followup sent to ${binding.sessionId}: ${text.slice(0, 60)} (agent=${status})`)
    } catch (error) {
      this.logger?.error(`[tg] followup failed for ${binding.sessionId}: ${messageOf(error)}`)
      onError?.(error)
    }
  }

  /** Dispose every live binding (plugin unload). */
  async disposeAll(): Promise<void> {
    const handles = [...this.bindings.values()].map(binding => binding.handle)
    this.bindings.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  /** Create (or resume) the binding for a chat. */
  private async create(key: string, chatId: number, botId: string, cwd: string, generation: number): Promise<SessionBinding> {
    const persisted = this.store.getChat(key)
    const sessionId = SessionId(`telegram:${key}`)
    let handle: AgentHandle
    if (persisted !== undefined && persisted.sessionId !== '') {
      try {
        handle = await this.factory.resume({
          sessionId: persisted.sessionId as SessionId,
          cwd: persisted.cwd || cwd,
          provider: this.provider,
          model: this.model,
        })
        this.logger?.warn(`[tg] resumed session ${persisted.sessionId} for ${key}`)
      } catch (error) {
        // Persisted session no longer available: fall through to a fresh create.
        this.logger?.warn(`[tg] resume failed for ${key}: ${messageOf(error)}; creating fresh`)
        handle = await this.factory.create({
          sessionId,
          cwd,
          provider: this.provider,
          model: this.model,
        })
        this.store.setChat(key, { sessionId: String(sessionId), cwd, botId } satisfies ChatState)
      }
    } else {
      handle = await this.factory.create({
        sessionId,
        cwd,
        provider: this.provider,
        model: this.model,
      })
      this.store.setChat(key, { sessionId: String(sessionId), cwd, botId } satisfies ChatState)
    }
    const binding: SessionBinding = { chatId, botId, handle, sessionId: String(sessionId), cwd, generation }
    this.bindings.set(key, binding)
    return binding
  }
}