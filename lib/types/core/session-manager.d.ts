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
    /**
     * Read-only accessor for the host default model (`agent-default-model`), used
     * when a bot does not pin its own provider/model. Must never write.
     */
    defaultSelection?: () => {
        provider: string;
        model: string;
    } | undefined;
    /**
     * Read-only lookup of the model recorded on a session that has no live agent
     * yet (read from the host's session projection store). Lets the status panel
     * show the inherited model right after a restart, instead of the deployment
     * default, without waiting for the first message to spin the agent up.
     */
    sessionModelLookup?: (sessionId: string) => {
        provider: string;
        model: string;
    } | undefined;
    /**
     * 把新会话登记进 DSH 工作区（GUI 侧栏按工作区注册表的 sessionIds 分组；
     * `agents.create` 只写会话头 cwd、不进名单，会话会落在「未分组」）。
     * 仅在 fresh 建会话后触发；失败不得影响会话本身。
     */
    attachWorkspace?: (sessionId: string, cwd: string) => Promise<void>;
    /**
     * 宿主默认 agent preset id（settings 的 `agentPresets.default`）。会话没有 preset
     * 时其工具世界为空（无 shell/文件工具），故 fresh 建会话必须带 preset：
     * 本 chat 已选（工作方式菜单）优先，其次这个宿主默认。
     */
    defaultPresetId?: () => string | undefined;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** Where an effective model came from, for display and debugging. */
export type ModelSource = 
/** The user picked it in the model menu, for the current session. */
'chat'
/** Inherited from the active session's own recorded model. */
 | 'session'
/** The deployment default (`agent-default-model`), read-only. */
 | 'host'
/** This bot's pinned/fallback value. */
 | 'bot';
/** Effective model for one route plus its source. */
export interface ModelInfo {
    provider: string;
    model: string;
    source: ModelSource;
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
export declare function preferSession(configSessionId: string, persistedSessionId: string | undefined): string;
/** Manages per-(bot, chat) agent sessions. */
export declare class SessionManager {
    private readonly factory;
    private readonly stores;
    private readonly scopes;
    private readonly defaultCwd;
    private readonly defaultSelection;
    private readonly sessionModelLookup;
    private readonly attachWorkspace;
    private readonly defaultPresetId;
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
    /**
     * The session this chat is currently driving, in priority order: its config
     * binding, its live binding, then the session id persisted for it.
     *
     * The persisted id matters right after a DSH restart: a session chosen from the
     * menu is stored but not re-registered as a binding, so without this fallback
     * the 会话 menu would show no ✅ on the conversation that is actually going to
     * be resumed (it looked like the session was lost, while the id was intact).
     */
    activeSessionId(chatId: number, botId: string): string | undefined;
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
    /**
     * Effective agent preset id for one route: the chat's 工作方式 pick first,
     * else the host default (`agentPresets.default`). Shared by every path that
     * starts or resumes an agent so none of them can ship an empty tool world.
     */
    private presetIdFor;
    /** Send a user text into the chat's agent (queued as a normal follow-up). */
    followup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): void;
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
    modelFor(chatId: number, botId: string): {
        provider: string;
        model: string;
    };
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
    modelInfo(chatId: number, botId: string): ModelInfo;
    /**
     * Switch this route's model: persist per (bot, chat) and, when the route
     * already has a live agent, mutate its selection ref so the next step uses the
     * new model. Other bots and the GUI are untouched.
     *
     * The pick is recorded together with the session it was made on, so switching
     * this chat to another conversation shows that conversation's own model again.
     */
    setModel(chatId: number, botId: string, provider: string, model: string): boolean;
    /** Persist a chat's work-mode preset (applied when a fresh session starts). */
    setPreset(chatId: number, botId: string, presetId: string): void;
    /** Persist a chat's working directory in its bot's own store. */
    setCwd(chatId: number, botId: string, cwd: string): void;
    /**
     * Switch this chat's working directory, DETACHING its current session.
     *
     * The user's intent when picking a new working directory is to start fresh
     * there, NOT to keep driving the conversation that belongs to the previous
     * directory. So this:
     *  - persists the new `cwd` (and keeps model / preset / botId);
     *  - clears the persisted session id and marks the chat as explicitly
     *    detached (`sessionDetached`), so `activeSessionId()` returns undefined;
     *  - removes any config/live binding for the route;
     *  - disposes only the chat's OWN live agent (never a bound foreign session).
     *
     * The next ordinary message therefore routes to the session-selection menu
     * (create / choose) instead of resuming the old conversation. Selecting the
     * same directory is a no-op, so a stray repress cannot throw the chat off a
     * session it is mid-conversation on. Returns true when the chat was detached
     * (i.e. it had a session that was released), false for a no-op.
     */
    switchCwd(chatId: number, botId: string, cwd: string): Promise<boolean>;
    /** Dispose every live binding (plugin unload). */
    disposeAll(): Promise<void>;
    /** Create a fresh session (mode `fresh`) or resume the persisted one. */
    private create;
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
    private createFresh;
    /** Candidate fresh-session id for generation `n`: `telegram:<bot>:<chat>[:g<n>]`. */
    private candidateSessionId;
    private isSessionIdTaken;
}
