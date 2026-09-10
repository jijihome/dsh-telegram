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
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { AgentFactoryLike } from '../harness/agent-factory.js';
import type { BotScope } from './bot-scope.js';
import type { StateStore } from './state-store.js';
export interface SessionBinding {
    /** Telegram chat id (numeric). */
    chatId: number;
    /** Bot id owning this chat. */
    botId: string;
    /** Isolation key `<botId>:<chatId>`. */
    routeKey: string;
    /** Current agent handle. */
    handle: AgentHandle;
    /** Current session id; rotates on /new and /clear. */
    sessionId: string;
    /** Working directory for this chat's agent. */
    cwd: string;
    /** Effective provider for this route. */
    provider: string;
    /** Effective model for this route. */
    model: string;
    /** Monotonic rotation counter for session ids. */
    generation: number;
}
/** A bound chat: the bot participates in an existing DSH session. */
export interface BoundChat {
    /** Telegram chat id (numeric). */
    chatId: number;
    /** Bot id owning this chat, or '' when the binding applies to any bot. */
    botId: string;
    /** The existing DSH session the chat is bound to. */
    sessionId: string;
    /** Working directory hint used when resuming an offline session. */
    cwd: string;
}
export interface SessionManagerOptions {
    factory: AgentFactoryLike;
    /** One state store per bot id (each store is itself namespaced). */
    stores: ReadonlyMap<string, StateStore>;
    /** One resolved isolation scope per bot id. */
    scopes: ReadonlyMap<string, BotScope>;
    defaultCwd: string;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** Manages per-(bot, chat) agent sessions. */
export declare class SessionManager {
    private readonly factory;
    private readonly stores;
    private readonly scopes;
    private readonly defaultCwd;
    private readonly logger;
    private readonly bindings;
    /** Bound chats keyed by route key (`botId:chatId`) or legacy bare `chatId`. */
    private readonly bound;
    /**
     * Session ids this plugin is responsible for: every telegram agent it created
     * / resumed, plus every session bound via config or the menu. Used as an O(1)
     * gate by the stream listener so events from ANY OTHER session in the host
     * are dropped silently instead of being scanned, routed, and logged.
     */
    private readonly relevant;
    constructor(options: SessionManagerOptions);
    /** Number of configured bots (bare-chat bindings are single-bot only). */
    private get singleBot();
    /** This bot's isolation scope. */
    scopeOf(botId: string): BotScope;
    /** This bot's private state store. */
    storeFor(botId: string): StateStore;
    /** Live binding for a chat, or undefined. */
    get(chatId: number, botId: string): SessionBinding | undefined;
    /**
     * This chat's persisted working directory (from the bot's own store), or the
     * process default. Used to pick the cwd for a fresh session so a workspace
     * switch survives a `/new` and a DSH restart.
     */
    chatCwd(chatId: number, botId: string): string;
    /** Mark a session id as one this plugin owns or is bound to (event gate). */
    markRelevant(sessionId: string): void;
    /**
     * O(1) gate: is this session one the plugin should process events for?
     * Everything the host emits other than our own agents / bound chats returns
     * false, so the stream listener can ignore foreign sessions immediately.
     */
    isRelevant(sessionId: string): boolean;
    /** Find the binding owning a given DSH session id (for event routing). */
    bySessionId(sessionId: string): SessionBinding | undefined;
    /**
     * Register a bound chat (config `bindings`).
     *
     * @param botId - owning bot. Pass `''` only in single-bot deployments, where
     *   the binding applies to that one bot; with two or more bots the binding is
     *   rejected (a bare chat id has no unambiguous owner).
     * @throws when the bot is unknown or the session is owned by another route.
     */
    bind(chatId: number, botId: string, sessionId: string, cwd: string): void;
    /** Remove a route's config binding (used by `/new` so it really starts over). */
    unbind(chatId: number, botId: string): boolean;
    /** Bound chat for a chat/bot (exact key first, bare-chat fallback in single-bot mode). */
    getBound(chatId: number, botId: string): BoundChat | undefined;
    /** Bound chat whose target DSH session matches (reverse index for routing). */
    byBoundSessionId(sessionId: string): BoundChat | undefined;
    /**
     * Every bound chat whose target DSH session matches. Under strict isolation
     * this is at most one route; multiple entries can only exist when every
     * involved bot explicitly opted into `allowSharedSessions`.
     */
    byBoundSessionIds(sessionId: string): BoundChat[];
    /** Session ids this bot owns: live bindings + config bindings + persisted state. */
    sessionIdsFor(botId: string): Set<string>;
    /** Does this bot own (create or explicitly bind) the given session? */
    ownsSession(botId: string, sessionId: string): boolean;
    /**
     * Send user text into the bound chat's existing DSH session. Prefers the
     * live agent in this process (web GUI conversation); falls back to resuming
     * the session when its agent is not currently running.
     */
    boundFollowup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): Promise<void>;
    /**
     * Get the chat's agent, creating it if needed. On first creation it tries to
     * resume a persisted session; otherwise it starts a new one.
     */
    getOrCreate(chatId: number, botId: string, cwd?: string): Promise<SessionBinding>;
    /**
     * Rotate to a fresh session (`/new` + `/clear`): always mints a brand-new
     * session id (never resumes the old conversation), drops the route's config
     * binding so the fresh session is actually used, and disposes the old agent.
     */
    rotate(chatId: number, botId: string): Promise<SessionBinding>;
    /** Cancel the chat's current turn (`/stop`); no-op when idle. */
    cancel(chatId: number, botId: string): boolean;
    /** Send a user text into the chat's agent (queued as a normal follow-up). */
    followup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): void;
    /**
     * Effective model for one route: the chat's persisted override first, then the
     * owning bot's default. Never consults the host-global default model.
     */
    modelFor(chatId: number, botId: string): {
        provider: string;
        model: string;
    };
    /**
     * Switch this route's model: persist per (bot, chat) and, when the route
     * already has a live agent, mutate its selection ref so the next step uses the
     * new model. Other bots and the GUI are untouched.
     */
    setModel(chatId: number, botId: string, provider: string, model: string): boolean;
    /** Persist a chat's work-mode preset (applied when a fresh session starts). */
    setPreset(chatId: number, botId: string, presetId: string): void;
    /** Persist a chat's working directory in its bot's own store. */
    setCwd(chatId: number, botId: string, cwd: string): void;
    /** Dispose every live binding (plugin unload). */
    disposeAll(): Promise<void>;
    /** Create a fresh session (mode `fresh`) or resume the persisted one. */
    private create;
    /**
     * A session id that no live agent, binding or persisted record is using.
     * `/new` must never collide with a previous generation, otherwise the host
     * would resurrect the old conversation instead of starting a clean one.
     */
    private uniqueSessionId;
    private isSessionIdTaken;
}
