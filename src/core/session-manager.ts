/**
 * Session manager: owns one DSH agent session per Telegram chat inside one bot.
 *
 * Isolation invariants (multi-bot strict tenancy):
 * - identity is always the pair `(<botId>, <chatId>)` — no API accepts a bare
 *   chat id, and every state read/write goes through that bot's own store;
 * - a DSH session is owned by exactly one route; binding a session that another
 *   route already owns is refused unless every involved bot opts in with
 *   `allowSharedSessions` (otherwise both bots would receive the same deltas);
 * - `resume` records the **real** resumed session id (previously the template id
 *   was stored, so outbound routing never matched the resumed session);
 * - `/new` (rotate) always mints a brand-new session id and clears the route's
 *   config binding instead of silently re-resuming the old conversation;
 * - the model is per route (chat override → bot default) and is never read from
 *   or written to the host-global `agentDefaultModel`.
 *
 * @module core/session-manager
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentFactoryLike } from '../harness/agent-factory.js'
import { sessionIdOf } from '../harness/agent-factory.js'
import type { BotScope } from './bot-scope.js'
import { routeKey } from './bot-scope.js'
import type { ChatState, StateStore } from './state-store.js'

export interface SessionBinding {
  /** Telegram chat id (numeric). */
  chatId: number
  /** Bot id owning this chat. */
  botId: string
  /** Isolation key `<botId>:<chatId>`. */
  routeKey: string
  /** Current agent handle. */
  handle: AgentHandle
  /** Current session id; rotates on /new and /clear. */
  sessionId: string
  /** Working directory for this chat's agent. */
  cwd: string
  /** Effective provider for this route. */
  provider: string
  /** Effective model for this route. */
  model: string
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
  /** One state store per bot id (each store is itself namespaced). */
  stores: ReadonlyMap<string, StateStore>
  /** One resolved isolation scope per bot id. */
  scopes: ReadonlyMap<string, BotScope>
  defaultCwd: string
  /**
   * Read-only accessor for the host default model (`agent-default-model`), used
   * when a bot does not pin its own provider/model. Must never write.
   */
  defaultSelection?: () => { provider: string; model: string } | undefined
  /**
   * Read-only lookup of the model recorded on a session that has no live agent
   * yet (read from the host's session projection store). Lets the status panel
   * show the inherited model right after a restart, instead of the deployment
   * default, without waiting for the first message to spin the agent up.
   */
  sessionModelLookup?: (sessionId: string) => { provider: string; model: string } | undefined
  /**
   * 把新会话登记进 DSH 工作区（GUI 侧栏按工作区注册表的 sessionIds 分组；
   * `agents.create` 只写会话头 cwd、不进名单，会话会落在「未分组」）。
   * 仅在 fresh 建会话后触发；失败不得影响会话本身。
   */
  attachWorkspace?: (sessionId: string, cwd: string) => Promise<void>
  /**
   * 宿主默认 agent preset id（settings 的 `agentPresets.default`）。会话没有 preset
   * 时其工具世界为空（无 shell/文件工具），故 fresh 建会话必须带 preset：
   * 本 chat 已选（工作方式菜单）优先，其次这个宿主默认。
   */
  defaultPresetId?: () => string | undefined
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

/** Where an effective model came from, for display and debugging. */
export type ModelSource =
  /** The user picked it in the model menu, for the current session. */
  | 'chat'
  /** Inherited from the active session's own recorded model. */
  | 'session'
  /** The deployment default (`agent-default-model`), read-only. */
  | 'host'
  /** This bot's pinned/fallback value. */
  | 'bot'

/** Effective model for one route plus its source. */
export interface ModelInfo {
  provider: string
  model: string
  source: ModelSource
}

/**
 * Decide which session a chat should drive at startup.
 *
 * A config `bindings` entry is a SEED, not an override: once the operator picked
 * a session from the 会话 menu that choice is persisted, and re-applying the
 * static config value on every start silently threw the choice away (the list
 * stopped marking it and the chat jumped back to the config session).
 *
 * @param configSessionId - session declared in the bot's config bindings.
 * @param persistedSessionId - session recorded for this chat in its state file.
 * @returns the session to drive: the persisted one when present.
 */
export function preferSession(configSessionId: string, persistedSessionId: string | undefined): string {
  return persistedSessionId !== undefined && persistedSessionId !== '' ? persistedSessionId : configSessionId
}

/** Stable message text for logging. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True when the host refused a session id because that session already exists on
 * disk (typically one minted by an earlier host run, invisible to our in-memory
 * generation counter). Matched by error name first, message as a fallback.
 */
function isSessionAlreadyExists(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name
  if (name === 'SessionAlreadyExistsError') return true
  return /already exists/i.test(messageOf(error))
}

/** Manages per-(bot, chat) agent sessions. */
export class SessionManager {
  private readonly factory: AgentFactoryLike
  private readonly stores: ReadonlyMap<string, StateStore>
  private readonly scopes: ReadonlyMap<string, BotScope>
  private readonly defaultCwd: string
  private readonly defaultSelection: SessionManagerOptions['defaultSelection']
  private readonly sessionModelLookup: SessionManagerOptions['sessionModelLookup']
  private readonly attachWorkspace: SessionManagerOptions['attachWorkspace']
  private readonly defaultPresetId: SessionManagerOptions['defaultPresetId']
  private readonly logger: SessionManagerOptions['logger'] | undefined
  private readonly bindings = new Map<string, SessionBinding>()
  /** Bound chats keyed by route key (`botId:chatId`) or legacy bare `chatId`. */
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
    this.stores = options.stores
    this.scopes = options.scopes
    this.defaultCwd = options.defaultCwd
    this.defaultSelection = options.defaultSelection
    this.sessionModelLookup = options.sessionModelLookup
    this.attachWorkspace = options.attachWorkspace
    this.defaultPresetId = options.defaultPresetId
    this.logger = options.logger
  }

  /** Number of configured bots (bare-chat bindings are single-bot only). */
  private get singleBot(): boolean {
    return this.scopes.size === 1
  }

  /** This bot's isolation scope. */
  scopeOf(botId: string): BotScope {
    const scope = this.scopes.get(botId)
    if (scope === undefined) {
      throw new Error(`dsh-telegram: 未知 bot id "${botId}"(不在配置的 bots[] 中)`)
    }
    return scope
  }

  /** This bot's private state store. */
  storeFor(botId: string): StateStore {
    const store = this.stores.get(botId)
    if (store === undefined) {
      throw new Error(`dsh-telegram: bot "${botId}" 没有独立状态存储(严格隔离要求每个 Bot 一个 store)`)
    }
    return store
  }

  /** Live binding for a chat, or undefined. */
  get(chatId: number, botId: string): SessionBinding | undefined {
    return this.bindings.get(routeKey(botId, chatId))
  }

  /**
   * This chat's persisted working directory (from the bot's own store), or the
   * process default. Used to pick the cwd for a fresh session so a workspace
   * switch survives a `/new` and a DSH restart.
   */
  chatCwd(chatId: number, botId: string): string {
    return this.storeFor(botId).getChat(routeKey(botId, chatId))?.cwd ?? this.defaultCwd
  }

  /**
   * The session this chat is currently driving, in priority order: its config
   * binding, its live binding, then the session id persisted for it.
   *
   * The persisted id matters right after a DSH restart: a session chosen from the
   * menu is stored but not re-registered as a binding, so without this fallback
   * the 会话 menu would show no ✅ on the conversation that is actually going to
   * be resumed (it looked like the session was lost, while the id was intact).
   */
  activeSessionId(chatId: number, botId: string): string | undefined {
    const bound = this.getBound(chatId, botId)?.sessionId
    if (bound !== undefined && bound !== '') return bound
    const live = this.bindings.get(routeKey(botId, chatId))?.sessionId
    if (live !== undefined && live !== '') return live
    const persisted = this.storeFor(botId).getChat(routeKey(botId, chatId))?.sessionId
    return persisted !== undefined && persisted !== '' ? persisted : undefined
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
   * Register a bound chat (config `bindings`).
   *
   * @param botId - owning bot. Pass `''` only in single-bot deployments, where
   *   the binding applies to that one bot; with two or more bots the binding is
   *   rejected (a bare chat id has no unambiguous owner).
   * @throws when the bot is unknown or the session is owned by another route.
   */
  bind(chatId: number, botId: string, sessionId: string, cwd: string): void {
    let owner = botId
    let key: string
    if (botId === '') {
      if (!this.singleBot) {
        throw new Error(
          `dsh-telegram: 裸 chatId 绑定 "${chatId}" 在 ${this.scopes.size} 个 Bot 下无法确定归属;`
          + `请改写为 "<botId>:<chatId>"(可用: ${[...this.scopes.keys()].join(', ')})。`,
        )
      }
      owner = [...this.scopes.keys()][0]!
      key = String(chatId)
    } else {
      this.scopeOf(botId)
      key = routeKey(botId, chatId)
    }
    // Single-ownership: a session may be driven by exactly one route.
    for (const [existingKey, entry] of this.bound) {
      if (entry.sessionId !== sessionId || existingKey === key) continue
      const other = this.scopes.get(entry.botId === '' ? owner : entry.botId)
      const mine = this.scopes.get(owner)
      const sharedOptIn = other?.allowSharedSessions === true && mine?.allowSharedSessions === true
      if (sharedOptIn) {
        this.logger?.warn(`[tg] 会话 ${sessionId} 被显式允许跨 Bot 共享(${existingKey} + ${key})`)
        continue
      }
      throw new Error(
        `dsh-telegram: 会话 ${sessionId} 已被路由 "${existingKey}" 绑定,不能同时绑定 "${key}";`
        + '严格隔离下一个 DSH 会话只能属于一个 Bot+chat(否则两边会同时收到该会话的输出)。'
        + '如确需共享,给相关 Bot 显式设置 allowSharedSessions: true。',
      )
    }
    this.bound.set(key, { chatId, botId: owner, sessionId, cwd })
    this.relevant.add(sessionId)
    // Persist the binding into the owning bot's store. Without this a session
    // chosen from the menu survived only in memory: after a DSH restart the chat
    // had no recorded conversation (no ✅ in the list) and the next message would
    // start a fresh session instead of resuming the chosen conversation.
    const store = this.storeFor(owner)
    const stateKey = routeKey(owner, chatId)
    const current = store.getChat(stateKey)
    store.setChat(stateKey, {
      ...(current ?? {}),
      sessionId,
      cwd,
      botId: owner,
    })
    store.flush()
    this.logger?.warn(`[tg] bound chat ${key} -> ${sessionId}`)
  }

  /** Remove a route's config binding (used by `/new` so it really starts over). */
  unbind(chatId: number, botId: string): boolean {
    const exact = routeKey(botId, chatId)
    let removed = this.bound.delete(exact)
    if (this.singleBot) removed = this.bound.delete(String(chatId)) || removed
    if (removed) this.logger?.warn(`[tg] unbound chat ${exact}`)
    return removed
  }

  /** Bound chat for a chat/bot (exact key first, bare-chat fallback in single-bot mode). */
  getBound(chatId: number, botId: string): BoundChat | undefined {
    const exact = this.bound.get(routeKey(botId, chatId))
    if (exact !== undefined) return exact
    // Bare key only exists in single-bot deployments (bind() rejects it otherwise).
    return this.singleBot ? this.bound.get(String(chatId)) : undefined
  }

  /** Bound chat whose target DSH session matches (reverse index for routing). */
  byBoundSessionId(sessionId: string): BoundChat | undefined {
    for (const entry of this.bound.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  /**
   * Every bound chat whose target DSH session matches. Under strict isolation
   * this is at most one route; multiple entries can only exist when every
   * involved bot explicitly opted into `allowSharedSessions`.
   */
  byBoundSessionIds(sessionId: string): BoundChat[] {
    const out: BoundChat[] = []
    for (const entry of this.bound.values()) {
      if (entry.sessionId === sessionId) out.push(entry)
    }
    return out
  }

  /** Session ids this bot owns: live bindings + config bindings + persisted state. */
  sessionIdsFor(botId: string): Set<string> {
    const out = new Set<string>()
    for (const binding of this.bindings.values()) {
      if (binding.botId === botId) out.add(binding.sessionId)
    }
    for (const [key, entry] of this.bound) {
      if (entry.botId === botId || key.startsWith(`${botId}:`)) out.add(entry.sessionId)
    }
    for (const state of Object.values(this.storeFor(botId).allChats())) {
      if (state.sessionId !== '') out.add(state.sessionId)
    }
    return out
  }

  /** Does this bot own (create or explicitly bind) the given session? */
  ownsSession(botId: string, sessionId: string): boolean {
    return this.sessionIdsFor(botId).has(sessionId)
  }

  /**
   * Send user text into the bound chat's existing DSH session. Prefers the
   * live agent in this process (web GUI conversation); falls back to resuming
   * the session when its agent is not currently running.
   */
  async boundFollowup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): Promise<void> {
    const bound = this.getBound(chatId, botId)
    if (bound === undefined) return
    const key = routeKey(botId, chatId)
    try {
      let agent = this.factory.getLive(bound.sessionId)
      if (agent === undefined) {
        this.logger?.warn(`[tg] bound session ${bound.sessionId} not live; resuming`)
        const model = this.modelFor(chatId, botId)
        const handle = await this.factory.resume({
          sessionId: bound.sessionId as SessionId,
          cwd: bound.cwd,
          provider: model.provider,
          model: model.model,
          routeKey: key,
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
   * Get the chat's agent, creating it if needed. On first creation it tries to
   * resume a persisted session; otherwise it starts a new one.
   */
  async getOrCreate(chatId: number, botId: string, cwd?: string): Promise<SessionBinding> {
    const key = routeKey(botId, chatId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    return this.create(key, chatId, botId, cwd ?? this.chatCwd(chatId, botId), 0, 'resume')
  }

  /**
   * Rotate to a fresh session (`/new` + `/clear`): always mints a brand-new
   * session id (never resumes the old conversation), drops the route's config
   * binding so the fresh session is actually used, and disposes the old agent.
   */
  async rotate(chatId: number, botId: string): Promise<SessionBinding> {
    const key = routeKey(botId, chatId)
    const previous = this.bindings.get(key)
    const generation = (previous?.generation ?? 0) + 1
    // The PERSISTED chat cwd is authoritative. The workspace picker only writes
    // the store (`setCwd`) and never touches the live binding, so reusing
    // `previous.cwd` here opened the fresh session in the directory the user had
    // just switched away from.
    const cwd = this.chatCwd(chatId, botId)
    const hadBinding = this.unbind(chatId, botId)
    const binding = await this.create(key, chatId, botId, cwd, generation, 'fresh')
    if (previous !== undefined) {
      this.relevant.delete(previous.sessionId)
      await previous.handle.dispose().catch(error => {
        this.logger?.warn(`[tg] dispose old agent failed: ${messageOf(error)}`)
      })
    }
    if (hadBinding) this.logger?.warn(`[tg] /new cleared config binding for ${key}`)
    this.logger?.warn(
      `[tg] /new rotate ${key}: ${previous?.sessionId ?? '(none)'} -> ${binding.sessionId} cwd=${cwd}`,
    )
    return binding
  }

  /** Cancel the chat's current turn (`/stop`); no-op when idle. */
  cancel(chatId: number, botId: string): boolean {
    const binding = this.bindings.get(routeKey(botId, chatId))
    if (binding === undefined) return false
    binding.handle.agent.cancel({ kind: 'user' })
    return true
  }

  /** Send a user text into the chat's agent (queued as a normal follow-up). */
  followup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): void {
    const binding = this.bindings.get(routeKey(botId, chatId))
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

  /**
   * Effective model for one route, in strict priority order:
   * 1. the chat's persisted override (the user picked it in the model menu);
   * 2. the host default model when this bot does not pin one — read-only, so the
   *    bot continues the conversation on the same model the GUI uses;
   * 3. the bot scope default (explicit pin, or the last-resort fallback).
   *
   * The host-global selection is only ever READ here; the plugin never writes it,
   * so one bot's model choice can never leak into another bot or the GUI.
   */
  modelFor(chatId: number, botId: string): { provider: string; model: string } {
    const info = this.modelInfo(chatId, botId)
    return { provider: info.provider, model: info.model }
  }

  /**
   * Effective model plus where it came from, in strict priority order:
   *
   * 1. `chat` — the user picked it in the model menu, and only for the session it
   *    was picked on (a stale pick must not masquerade as another session's model);
   * 2. `session` — the model the active session itself is continuing with
   *    (`modelSelection` projection), i.e. the inherited conversation model;
   * 3. `host` — the deployment default (`agent-default-model`), read-only;
   * 4. `bot` — this bot's pinned/fallback value.
   *
   * The host-global selection is only ever READ; the plugin never writes it.
   */
  modelInfo(chatId: number, botId: string): ModelInfo {
    const scope = this.scopeOf(botId)
    const state = this.storeFor(botId).getChat(routeKey(botId, chatId))
    const active = this.activeSessionId(chatId, botId)
    if (state?.provider !== undefined && state.model !== undefined) {
      const sameSession = state.modelSessionId === undefined || active === undefined || state.modelSessionId === active
      if (sameSession) return { provider: state.provider, model: state.model, source: 'chat' }
    }
    if (active !== undefined) {
      // Live agent first (authoritative), then the session's own persisted record
      // so a restart shows the inherited model before the first message spins the
      // agent up.
      const inherited = this.factory.sessionSelection?.(active) ?? this.sessionModelLookup?.(active)
      if (inherited !== undefined && inherited.provider !== '' && inherited.model !== '') {
        return { provider: inherited.provider, model: inherited.model, source: 'session' }
      }
    }
    if (!scope.modelPinned) {
      const host = this.defaultSelection?.()
      if (host !== undefined && host.provider !== '' && host.model !== '') {
        return { provider: host.provider, model: host.model, source: 'host' }
      }
    }
    return {
      provider: state?.provider ?? scope.provider,
      model: state?.model ?? scope.model,
      source: 'bot',
    }
  }

  /**
   * Switch this route's model: persist per (bot, chat) and, when the route
   * already has a live agent, mutate its selection ref so the next step uses the
   * new model. Other bots and the GUI are untouched.
   *
   * The pick is recorded together with the session it was made on, so switching
   * this chat to another conversation shows that conversation's own model again.
   */
  setModel(chatId: number, botId: string, provider: string, model: string): boolean {
    const key = routeKey(botId, chatId)
    const store = this.storeFor(botId)
    const current = store.getChat(key)
    const active = this.activeSessionId(chatId, botId)
    store.setChat(key, {
      ...(current ?? { sessionId: active ?? '', cwd: this.defaultCwd, botId }),
      provider,
      model,
      ...(active !== undefined ? { modelSessionId: active } : {}),
    } as ChatState)
    store.flush()
    const binding = this.bindings.get(key)
    if (binding !== undefined) {
      binding.provider = provider
      binding.model = model
    }
    return this.factory.setSelection(key, { provider, model })
  }

  /** Persist a chat's work-mode preset (applied when a fresh session starts). */
  setPreset(chatId: number, botId: string, presetId: string): void {
    const key = routeKey(botId, chatId)
    const store = this.storeFor(botId)
    const current = store.getChat(key)
    store.setChat(key, { ...(current ?? { sessionId: '', cwd: this.defaultCwd, botId }), agentPreset: presetId } as ChatState)
    store.flush()
  }

  /** Persist a chat's working directory in its bot's own store. */
  setCwd(chatId: number, botId: string, cwd: string): void {
    const key = routeKey(botId, chatId)
    const store = this.storeFor(botId)
    const current = store.getChat(key)
    store.setChat(key, { ...(current ?? { sessionId: '', cwd, botId }), cwd, botId } as ChatState)
    store.flush()
  }

  /** Dispose every live binding (plugin unload). */
  async disposeAll(): Promise<void> {
    const handles = [...this.bindings.values()].map(binding => binding.handle)
    this.bindings.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  /** Create a fresh session (mode `fresh`) or resume the persisted one. */
  private async create(
    key: string,
    chatId: number,
    botId: string,
    cwd: string,
    generation: number,
    mode: 'resume' | 'fresh',
  ): Promise<SessionBinding> {
    const store = this.storeFor(botId)
    this.scopeOf(botId)
    const persisted = store.getChat(key)
    const model = this.modelFor(chatId, botId)
    // The agent preset composes the agent's scoped world (tools, prompt sections).
    // A fresh session created WITHOUT one has no tools at all — no shell, no file
    // access — so always resolve one: the chat's 工作方式 pick first, else the
    // host default (`agentPresets.default`).
    const chosenPreset = persisted?.agentPreset
    const presetId = chosenPreset !== undefined && chosenPreset !== ''
      ? chosenPreset
      : this.defaultPresetId?.()
    let handle: AgentHandle
    let sessionId: string
    // A persisted session whose agent is ALREADY live in this process (e.g. a GUI
    // conversation, or a chat binding chosen from the menu before a restart) must
    // be adopted, never resumed: resuming a live session can fail and the old code
    // then fell back to a FRESH session, silently discarding the conversation.
    const liveAgent = mode === 'resume' && persisted !== undefined && persisted.sessionId !== ''
      ? this.factory.getLive(persisted.sessionId)
      : undefined
    if (liveAgent !== undefined && persisted !== undefined) {
      sessionId = persisted.sessionId
      // The plugin does not own this agent, so its disposer is a no-op: `/new`
      // and plugin unload must not tear down someone else's live session.
      handle = { agent: liveAgent, dispose: async () => {} }
      this.logger?.warn(`[tg] adopted live session ${sessionId} for ${key}`)
    } else if (mode === 'resume' && persisted !== undefined && persisted.sessionId !== '') {
      try {
        handle = await this.factory.resume({
          sessionId: persisted.sessionId as SessionId,
          cwd: persisted.cwd || cwd,
          provider: model.provider,
          model: model.model,
          routeKey: key,
        })
        // Use the REAL resumed session id, not the template id: the two differ
        // whenever a chat is bound to a pre-existing (e.g. GUI) session, and
        // routing matches on the id the host actually emits.
        sessionId = sessionIdOf(handle) || persisted.sessionId
        this.logger?.warn(`[tg] resumed session ${sessionId} for ${key}`)
      } catch (error) {
        // Persisted session no longer available: fall through to a fresh create.
        this.logger?.warn(`[tg] resume failed for ${key}: ${messageOf(error)}; creating fresh`)
        const fresh = await this.createFresh(key, chatId, botId, cwd, generation, model, presetId)
        handle = fresh.handle
        sessionId = fresh.sessionId
      }
    } else {
      const fresh = await this.createFresh(key, chatId, botId, cwd, generation, model, presetId)
      handle = fresh.handle
      sessionId = fresh.sessionId
    }
    store.setChat(key, {
      ...(persisted ?? {}),
      sessionId,
      cwd,
      botId,
    } satisfies ChatState)
    store.flush()
    const binding: SessionBinding = {
      chatId, botId, routeKey: key, handle, sessionId, cwd,
      provider: model.provider, model: model.model, generation,
    }
    this.bindings.set(key, binding)
    this.relevant.add(sessionId)
    // Fresh sessions must join the workspace account for their cwd, or the GUI
    // workspace sidebar groups them under「未分组」(grouping reads the registry's
    // sessionIds membership, never the session's own cwd header).
    if (mode === 'fresh' && this.attachWorkspace !== undefined) {
      void Promise.resolve(this.attachWorkspace(sessionId, cwd)).catch(error => {
        this.logger?.warn(`[tg] 工作区挂载失败(非致命) ${sessionId}: ${messageOf(error)}`)
      })
    }
    return binding
  }

  /**
   * Create a fresh agent, skipping session ids the HOST already owns.
   *
   * The in-memory generation counter and {@link isSessionIdTaken} cannot see
   * sessions persisted by an EARLIER host run (generation is not durable, and the
   * per-chat state only records the latest id). After a restart the next `g<N>`
   * can therefore collide with an existing session and `agents.create` rejects
   * with SessionAlreadyExistsError. Retry with the next candidate until the host
   * accepts one — self-healing without needing a durable counter.
   */
  private async createFresh(
    key: string,
    chatId: number,
    botId: string,
    cwd: string,
    generation: number,
    model: { provider: string; model: string },
    agentPreset?: string,
  ): Promise<{ handle: AgentHandle; sessionId: string }> {
    let n = generation
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = this.candidateSessionId(botId, chatId, n)
      if (this.isSessionIdTaken(botId, candidate)) {
        n += 1
        continue
      }
      try {
        this.logger?.warn(`[tg] fresh session ${candidate} cwd=${cwd} preset=${agentPreset ?? '(宿主默认)'}`)
        const handle = await this.factory.create({
          sessionId: SessionId(candidate),
          cwd,
          provider: model.provider,
          model: model.model,
          routeKey: key,
          ...(agentPreset !== undefined && agentPreset !== '' ? { agentPreset } : {}),
        })
        return { handle, sessionId: sessionIdOf(handle) || candidate }
      } catch (error) {
        if (!isSessionAlreadyExists(error)) throw error
        this.logger?.warn(`[tg] session id ${candidate} 已存在于宿主,改试下一个候选`)
        n += 1
      }
    }
    throw new Error(
      `dsh-telegram: 连续 50 个候选 session id 都与宿主已有会话冲突(bot=${botId} chat=${chatId})`,
    )
  }

  /** Candidate fresh-session id for generation `n`: `telegram:<bot>:<chat>[:g<n>]`. */
  private candidateSessionId(botId: string, chatId: number, n: number): string {
    const base = `telegram:${botId}:${chatId}`
    return n === 0 ? base : `${base}:g${n}`
  }

  private isSessionIdTaken(botId: string, sessionId: string): boolean {
    if (this.relevant.has(sessionId)) return true
    if (this.factory.getLive(sessionId) !== undefined) return true
    for (const binding of this.bindings.values()) {
      if (binding.sessionId === sessionId) return true
    }
    for (const entry of this.bound.values()) {
      if (entry.sessionId === sessionId) return true
    }
    for (const state of Object.values(this.storeFor(botId).allChats())) {
      if (state.sessionId === sessionId) return true
    }
    return false
  }
}
