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

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
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

/** A bound chat: the bot participates in an existing DSH session. */
export interface BoundChat {
  /** Telegram chat id (numeric). */
  chatId: number
  /** Bot id owning this chat, or '' when the binding applies to any bot. */
  botId: string
  /** The existing DSH session the chat is bound to. */
  sessionId: string
  /** Working directory hint used when resuming an offline session. */
  cwd: string
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
  /** Bound chats keyed by config key (`botId:chatId` or bare `chatId`). */
  private readonly bound = new Map<string, BoundChat>()
  /**
   * Session ids this plugin is responsible for: every telegram agent it created
   * / resumed, plus every session bound via config or the menu. Used as an O(1)
   * gate by the stream listener so events from ANY OTHER session in the host
   * are dropped silently instead of being scanned, routed, and logged.
   */
  private readonly relevant = new Set<string>()

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

  /**
   * This chat's persisted working directory (from the state store), or the
   * process default. Used to pick the cwd for a fresh session so a workspace
   * switch survives a `/new` and a DSH restart.
   */
  chatCwd(chatId: number, botId: string): string {
    return this.store.getChat(sessionKey(botId, chatId))?.cwd ?? this.defaultCwd
  }

  /** Mark a session id as one this plugin owns or is bound to (event gate). */
  markRelevant(sessionId: string): void {
    this.relevant.add(sessionId)
  }

  /**
   * O(1) gate: is this session one the plugin should process events for?
   * Everything the host emits other than our own agents / bound chats returns
   * false, so the stream listener can ignore foreign sessions immediately.
   */
  isRelevant(sessionId: string): boolean {
    return this.relevant.has(sessionId)
  }

  /** Find the binding owning a given DSH session id (for event routing). */
  bySessionId(sessionId: string): SessionBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId) return binding
    }
    return undefined
  }

  /**
   * Register a bound chat (config `bindings`). `botId` may be '' to apply the
   * binding to any bot. Re-registering a chat overwrites its binding.
   */
  bind(chatId: number, botId: string, sessionId: string, cwd: string): void {
    const key = botId === '' ? String(chatId) : sessionKey(botId, chatId)
    this.bound.set(key, { chatId, botId, sessionId, cwd })
    this.relevant.add(sessionId)
    this.logger?.warn(`[tg] bound chat ${key} -> ${sessionId}`)
  }

  /** Bound chat for a chat/bot (exact key first, then bare-chat fallback). */
  getBound(chatId: number, botId: string): BoundChat | undefined {
    return this.bound.get(sessionKey(botId, chatId))
      ?? this.bound.get(String(chatId))
  }

  /** Bound chat whose target DSH session matches (reverse index for routing). */
  byBoundSessionId(sessionId: string): BoundChat | undefined {
    for (const entry of this.bound.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  /**
   * Every bound chat whose target DSH session matches. In multi-bot mode a
   * single session can be bound to several bot chats at once (e.g. two bots
   * driving the same GUI conversation); outbound routing must then fan out to
   * all of them instead of silently picking one.
   */
  byBoundSessionIds(sessionId: string): BoundChat[] {
    const out: BoundChat[] = []
    for (const entry of this.bound.values()) {
      if (entry.sessionId === sessionId) out.push(entry)
    }
    return out
  }

  /**
   * Send user text into the bound chat's existing DSH session. Prefers the
   * live agent in this process (web GUI conversation); falls back to resuming
   * the session when its agent is not currently running.
   */
  async boundFollowup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): Promise<void> {
    const bound = this.getBound(chatId, botId)
    if (bound === undefined) return
    try {
      let agent = this.factory.getLive(bound.sessionId)
      if (agent === undefined) {
        this.logger?.warn(`[tg] bound session ${bound.sessionId} not live; resuming`)
        const handle = await this.factory.resume({
          sessionId: bound.sessionId as SessionId,
          cwd: bound.cwd,
          provider: this.provider,
          model: this.model,
        })
        agent = handle.agent
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      const status = (agent as { status?: string }).status
      this.logger?.warn(`[tg] bound followup -> ${bound.sessionId}: ${text.slice(0, 60)} (agent=${status})`)
    } catch (error) {
      this.logger?.error(`[tg] bound followup failed for ${bound.sessionId}: ${messageOf(error)}`)
      onError?.(error)
    }
  }

  /**
   * Get the chat's agent, creating it if needed. On first creation it tries
   * to resume a persisted session; otherwise it starts a new one.
   */
  async getOrCreate(chatId: number, botId: string, cwd?: string): Promise<SessionBinding> {
    const key = sessionKey(botId, chatId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    return this.create(key, chatId, botId, cwd ?? this.chatCwd(chatId, botId), 0)
  }

  /** Rotate to a fresh session (`/new`); disposes the previous agent. */
  async rotate(chatId: number, botId: string): Promise<SessionBinding> {
    const key = sessionKey(botId, chatId)
    const previous = this.bindings.get(key)
    const generation = (previous?.generation ?? 0) + 1
    const binding = await this.create(key, chatId, botId, previous?.cwd ?? this.chatCwd(chatId, botId), generation)
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
    this.relevant.add(binding.sessionId)
    return binding
  }
}