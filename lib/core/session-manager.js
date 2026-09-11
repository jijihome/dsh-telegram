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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { sessionIdOf } from '../harness/agent-factory.js';
import { routeKey } from './bot-scope.js';
import { isOwnSessionId } from './session-visibility.js';
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
export function preferSession(configSessionId, persistedSessionId) {
    return persistedSessionId !== undefined && persistedSessionId !== '' ? persistedSessionId : configSessionId;
}
/** Stable message text for logging. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Path equality insensitive to separators and case. Workspace picker spells
 * directories differently (D:\repos vs d:/repos), so a same-directory switch
 * must compare normalized forms.
 */
function sameDir(a, b) {
    const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}
/**
 * True when the host refused a session id because that session already exists on
 * disk (typically one minted by an earlier host run, invisible to our in-memory
 * generation counter). Matched by error name first, message as a fallback.
 */
function isSessionAlreadyExists(error) {
    const name = error?.name;
    if (name === 'SessionAlreadyExistsError')
        return true;
    return /already exists/i.test(messageOf(error));
}
/** Manages per-(bot, chat) agent sessions. */
export class SessionManager {
    factory;
    stores;
    scopes;
    defaultCwd;
    defaultSelection;
    sessionModelLookup;
    attachWorkspace;
    defaultPresetId;
    logger;
    bindings = new Map();
    /** Bound chats keyed by route key (`botId:chatId`) or legacy bare `chatId`. */
    bound = new Map();
    /**
     * Session ids this plugin is responsible for: every telegram agent it created
     * / resumed, plus every session bound via config or the menu. Used as an O(1)
     * gate by the stream listener so events from ANY OTHER session in the host
     * are dropped silently instead of being scanned, routed, and logged.
     */
    relevant = new Set();
    constructor(options) {
        this.factory = options.factory;
        this.stores = options.stores;
        this.scopes = options.scopes;
        this.defaultCwd = options.defaultCwd;
        this.defaultSelection = options.defaultSelection;
        this.sessionModelLookup = options.sessionModelLookup;
        this.attachWorkspace = options.attachWorkspace;
        this.defaultPresetId = options.defaultPresetId;
        this.logger = options.logger;
    }
    /** Number of configured bots (bare-chat bindings are single-bot only). */
    get singleBot() {
        return this.scopes.size === 1;
    }
    /** This bot's isolation scope. */
    scopeOf(botId) {
        const scope = this.scopes.get(botId);
        if (scope === undefined) {
            throw new Error(`dsh-telegram: 未知 bot id "${botId}"(不在配置的 bots[] 中)`);
        }
        return scope;
    }
    /** This bot's private state store. */
    storeFor(botId) {
        const store = this.stores.get(botId);
        if (store === undefined) {
            throw new Error(`dsh-telegram: bot "${botId}" 没有独立状态存储(严格隔离要求每个 Bot 一个 store)`);
        }
        return store;
    }
    /** Live binding for a chat, or undefined. */
    get(chatId, botId) {
        return this.bindings.get(routeKey(botId, chatId));
    }
    /**
     * This chat's persisted working directory (from the bot's own store), or the
     * process default. Used to pick the cwd for a fresh session so a workspace
     * switch survives a `/new` and a DSH restart.
     */
    chatCwd(chatId, botId) {
        return this.storeFor(botId).getChat(routeKey(botId, chatId))?.cwd ?? this.defaultCwd;
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
    activeSessionId(chatId, botId) {
        // An EXPLICIT detach (workspace switch) wins over every source below: the
        // chat deliberately released its conversation and must stay sessionless
        // until the user picks or creates one. Guards against any write path that
        // preserves a stale session id alongside the detach marker.
        const state = this.storeFor(botId).getChat(routeKey(botId, chatId));
        if (state?.sessionDetached === true)
            return undefined;
        const bound = this.getBound(chatId, botId)?.sessionId;
        if (bound !== undefined && bound !== '')
            return bound;
        const live = this.bindings.get(routeKey(botId, chatId))?.sessionId;
        if (live !== undefined && live !== '')
            return live;
        const persisted = state?.sessionId;
        return persisted !== undefined && persisted !== '' ? persisted : undefined;
    }
    /** Mark a session id as one this plugin owns or is bound to (event gate). */
    markRelevant(sessionId) {
        this.relevant.add(sessionId);
    }
    /**
     * O(1) gate: is this session one the plugin should process events for?
     * Everything the host emits other than our own agents / bound chats returns
     * false, so the stream listener can ignore foreign sessions immediately.
     */
    isRelevant(sessionId) {
        return this.relevant.has(sessionId);
    }
    /** Find the binding owning a given DSH session id (for event routing). */
    bySessionId(sessionId) {
        for (const binding of this.bindings.values()) {
            if (binding.sessionId === sessionId)
                return binding;
        }
        return undefined;
    }
    /**
     * Register a bound chat (config `bindings`).
     *
     * @param botId - owning bot. Pass `''` only in single-bot deployments, where
     *   the binding applies to that one bot; with two or more bots the binding is
     *   rejected (a bare chat id has no unambiguous owner).
     * @throws when the bot is unknown or the session is owned by another route.
     */
    bind(chatId, botId, sessionId, cwd) {
        let owner = botId;
        let key;
        if (botId === '') {
            if (!this.singleBot) {
                throw new Error(`dsh-telegram: 裸 chatId 绑定 "${chatId}" 在 ${this.scopes.size} 个 Bot 下无法确定归属;`
                    + `请改写为 "<botId>:<chatId>"(可用: ${[...this.scopes.keys()].join(', ')})。`);
            }
            owner = [...this.scopes.keys()][0];
            key = String(chatId);
        }
        else {
            this.scopeOf(botId);
            key = routeKey(botId, chatId);
        }
        // Single-ownership: a session may be driven by exactly one route.
        for (const [existingKey, entry] of this.bound) {
            if (entry.sessionId !== sessionId || existingKey === key)
                continue;
            const other = this.scopes.get(entry.botId === '' ? owner : entry.botId);
            const mine = this.scopes.get(owner);
            const sharedOptIn = other?.allowSharedSessions === true && mine?.allowSharedSessions === true;
            if (sharedOptIn) {
                this.logger?.warn(`[tg] 会话 ${sessionId} 被显式允许跨 Bot 共享(${existingKey} + ${key})`);
                continue;
            }
            throw new Error(`dsh-telegram: 会话 ${sessionId} 已被路由 "${existingKey}" 绑定,不能同时绑定 "${key}";`
                + '严格隔离下一个 DSH 会话只能属于一个 Bot+chat(否则两边会同时收到该会话的输出)。'
                + '如确需共享,给相关 Bot 显式设置 allowSharedSessions: true。');
        }
        this.bound.set(key, { chatId, botId: owner, sessionId, cwd });
        this.relevant.add(sessionId);
        // Persist the binding into the owning bot's store. Without this a session
        // chosen from the menu survived only in memory: after a DSH restart the chat
        // had no recorded conversation (no ✅ in the list) and the next message would
        // start a fresh session instead of resuming the chosen conversation.
        const store = this.storeFor(owner);
        const stateKey = routeKey(owner, chatId);
        const current = store.getChat(stateKey);
        store.setChat(stateKey, {
            ...(current ?? {}),
            sessionId,
            cwd,
            botId: owner,
            // Binding (config or menu pick) re-attaches the chat: clear any leftover
            // workspace-switch detach marker so the choice is authoritative.
            sessionDetached: false,
        });
        store.flush();
        this.logger?.warn(`[tg] bound chat ${key} -> ${sessionId}`);
    }
    /** Remove a route's config binding (used by `/new` so it really starts over). */
    unbind(chatId, botId) {
        const exact = routeKey(botId, chatId);
        let removed = this.bound.delete(exact);
        if (this.singleBot)
            removed = this.bound.delete(String(chatId)) || removed;
        if (removed)
            this.logger?.warn(`[tg] unbound chat ${exact}`);
        return removed;
    }
    /** Bound chat for a chat/bot (exact key first, bare-chat fallback in single-bot mode). */
    getBound(chatId, botId) {
        const exact = this.bound.get(routeKey(botId, chatId));
        if (exact !== undefined)
            return exact;
        // Bare key only exists in single-bot deployments (bind() rejects it otherwise).
        return this.singleBot ? this.bound.get(String(chatId)) : undefined;
    }
    /** Bound chat whose target DSH session matches (reverse index for routing). */
    byBoundSessionId(sessionId) {
        for (const entry of this.bound.values()) {
            if (entry.sessionId === sessionId)
                return entry;
        }
        return undefined;
    }
    /**
     * Every bound chat whose target DSH session matches. Under strict isolation
     * this is at most one route; multiple entries can only exist when every
     * involved bot explicitly opted into `allowSharedSessions`.
     */
    byBoundSessionIds(sessionId) {
        const out = [];
        for (const entry of this.bound.values()) {
            if (entry.sessionId === sessionId)
                out.push(entry);
        }
        return out;
    }
    /** Session ids this bot owns: live bindings + config bindings + persisted state. */
    sessionIdsFor(botId) {
        const out = new Set();
        for (const binding of this.bindings.values()) {
            if (binding.botId === botId)
                out.add(binding.sessionId);
        }
        for (const [key, entry] of this.bound) {
            if (entry.botId === botId || key.startsWith(`${botId}:`))
                out.add(entry.sessionId);
        }
        for (const state of Object.values(this.storeFor(botId).allChats())) {
            if (state.sessionId !== '')
                out.add(state.sessionId);
        }
        return out;
    }
    /** Does this bot own (create or explicitly bind) the given session? */
    ownsSession(botId, sessionId) {
        return this.sessionIdsFor(botId).has(sessionId);
    }
    /**
     * Send user text into the bound chat's existing DSH session. Prefers the
     * live agent in this process (web GUI conversation); falls back to resuming
     * the session when its agent is not currently running.
     */
    async boundFollowup(chatId, botId, text, onError) {
        const bound = this.getBound(chatId, botId);
        if (bound === undefined)
            return;
        const key = routeKey(botId, chatId);
        try {
            let agent = this.factory.getLive(bound.sessionId);
            if (agent === undefined) {
                this.logger?.warn(`[tg] bound session ${bound.sessionId} not live; resuming`);
                const model = this.modelFor(chatId, botId);
                // Our own sessions must re-join their preset on this resume path too.
                // `create()` already did, but a chat that picked one of OUR sessions
                // from the 会话 menu (e.g. after a workspace switch, or right after a
                // restart) drives it through THIS method — without the mount the
                // resumed conversation ran with an EMPTY tool world (no read/pwsh/…),
                // the exact regression dd5cbac fixed for the other paths.
                // Foreign (GUI) sessions keep the composition their creator mounted.
                const presetId = this.presetIdFor(chatId, botId);
                const handle = await this.factory.resume({
                    sessionId: bound.sessionId,
                    cwd: bound.cwd,
                    provider: model.provider,
                    model: model.model,
                    routeKey: key,
                    ...(isOwnSessionId(bound.sessionId) && presetId !== undefined && presetId !== ''
                        ? { agentPreset: presetId }
                        : {}),
                });
                agent = handle.agent;
            }
            agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }));
            const status = agent.status;
            this.logger?.warn(`[tg] bound followup -> ${bound.sessionId}: ${text.slice(0, 60)} (agent=${status})`);
        }
        catch (error) {
            this.logger?.error(`[tg] bound followup failed for ${bound.sessionId}: ${messageOf(error)}`);
            onError?.(error);
        }
    }
    /**
     * Get the chat's agent, creating it if needed. On first creation it tries to
     * resume a persisted session; otherwise it starts a new one.
     */
    async getOrCreate(chatId, botId, cwd) {
        const key = routeKey(botId, chatId);
        const existing = this.bindings.get(key);
        if (existing !== undefined)
            return existing;
        return this.create(key, chatId, botId, cwd ?? this.chatCwd(chatId, botId), 0, 'resume');
    }
    /**
     * Rotate to a fresh session (`/new` + `/clear`): always mints a brand-new
     * session id (never resumes the old conversation), drops the route's config
     * binding so the fresh session is actually used, and disposes the old agent.
     */
    async rotate(chatId, botId) {
        const key = routeKey(botId, chatId);
        const previous = this.bindings.get(key);
        const generation = (previous?.generation ?? 0) + 1;
        // The PERSISTED chat cwd is authoritative. The workspace picker only writes
        // the store (`setCwd`) and never touches the live binding, so reusing
        // `previous.cwd` here opened the fresh session in the directory the user had
        // just switched away from.
        const cwd = this.chatCwd(chatId, botId);
        const hadBinding = this.unbind(chatId, botId);
        const binding = await this.create(key, chatId, botId, cwd, generation, 'fresh');
        if (previous !== undefined) {
            this.relevant.delete(previous.sessionId);
            await previous.handle.dispose().catch(error => {
                this.logger?.warn(`[tg] dispose old agent failed: ${messageOf(error)}`);
            });
        }
        if (hadBinding)
            this.logger?.warn(`[tg] /new cleared config binding for ${key}`);
        // A model the user picked in the model menu is an intent about THIS CHAT, not
        // about one session — and `modelInfo` treats an override whose
        // `modelSessionId` no longer matches the active session as stale. Without
        // re-anchoring, `/new` silently dropped the pick and fell back to the host
        // default (the wizard's chosen model showed up as the old one). Re-anchor the
        // override onto the session we just created.
        const store = this.storeFor(botId);
        const state = store.getChat(key);
        if (state?.provider !== undefined && state.model !== undefined && state.modelSessionId !== binding.sessionId) {
            store.setChat(key, { ...state, modelSessionId: binding.sessionId });
            store.flush();
            binding.provider = state.provider;
            binding.model = state.model;
            this.logger?.warn(`[tg] 模型选择已跟随新会话: ${state.provider}/${state.model}`);
        }
        this.logger?.warn(`[tg] /new rotate ${key}: ${previous?.sessionId ?? '(none)'} -> ${binding.sessionId} cwd=${cwd}`);
        return binding;
    }
    /** Cancel the chat's current turn (`/stop`); no-op when idle. */
    cancel(chatId, botId) {
        const binding = this.bindings.get(routeKey(botId, chatId));
        if (binding === undefined)
            return false;
        binding.handle.agent.cancel({ kind: 'user' });
        return true;
    }
    /**
     * Effective agent preset id for one route: the chat's 工作方式 pick first,
     * else the host default (`agentPresets.default`). Shared by every path that
     * starts or resumes an agent so none of them can ship an empty tool world.
     */
    presetIdFor(chatId, botId) {
        const chosen = this.storeFor(botId).getChat(routeKey(botId, chatId))?.agentPreset;
        return chosen !== undefined && chosen !== '' ? chosen : this.defaultPresetId?.();
    }
    /** Send a user text into the chat's agent (queued as a normal follow-up). */
    followup(chatId, botId, text, onError) {
        const binding = this.bindings.get(routeKey(botId, chatId));
        if (binding === undefined)
            return;
        try {
            binding.handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }));
            const status = binding.handle.agent.status;
            this.logger?.warn(`[tg] followup sent to ${binding.sessionId}: ${text.slice(0, 60)} (agent=${status})`);
        }
        catch (error) {
            this.logger?.error(`[tg] followup failed for ${binding.sessionId}: ${messageOf(error)}`);
            onError?.(error);
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
    modelFor(chatId, botId) {
        const info = this.modelInfo(chatId, botId);
        return { provider: info.provider, model: info.model };
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
    modelInfo(chatId, botId) {
        const scope = this.scopeOf(botId);
        const state = this.storeFor(botId).getChat(routeKey(botId, chatId));
        const active = this.activeSessionId(chatId, botId);
        if (state?.provider !== undefined && state.model !== undefined) {
            const sameSession = state.modelSessionId === undefined || active === undefined || state.modelSessionId === active;
            if (sameSession)
                return { provider: state.provider, model: state.model, source: 'chat' };
        }
        if (active !== undefined) {
            // Live agent first (authoritative), then the session's own persisted record
            // so a restart shows the inherited model before the first message spins the
            // agent up.
            const inherited = this.factory.sessionSelection?.(active) ?? this.sessionModelLookup?.(active);
            if (inherited !== undefined && inherited.provider !== '' && inherited.model !== '') {
                return { provider: inherited.provider, model: inherited.model, source: 'session' };
            }
        }
        if (!scope.modelPinned) {
            const host = this.defaultSelection?.();
            if (host !== undefined && host.provider !== '' && host.model !== '') {
                return { provider: host.provider, model: host.model, source: 'host' };
            }
        }
        return {
            provider: state?.provider ?? scope.provider,
            model: state?.model ?? scope.model,
            source: 'bot',
        };
    }
    /**
     * Switch this route's model: persist per (bot, chat) and, when the route
     * already has a live agent, mutate its selection ref so the next step uses the
     * new model. Other bots and the GUI are untouched.
     *
     * The pick is recorded together with the session it was made on, so switching
     * this chat to another conversation shows that conversation's own model again.
     */
    setModel(chatId, botId, provider, model) {
        const key = routeKey(botId, chatId);
        const store = this.storeFor(botId);
        const current = store.getChat(key);
        const active = this.activeSessionId(chatId, botId);
        store.setChat(key, {
            ...(current ?? { sessionId: active ?? '', cwd: this.defaultCwd, botId }),
            provider,
            model,
            ...(active !== undefined ? { modelSessionId: active } : {}),
        });
        store.flush();
        const binding = this.bindings.get(key);
        if (binding !== undefined) {
            binding.provider = provider;
            binding.model = model;
        }
        return this.factory.setSelection(key, { provider, model });
    }
    /** Persist a chat's work-mode preset (applied when a fresh session starts). */
    setPreset(chatId, botId, presetId) {
        const key = routeKey(botId, chatId);
        const store = this.storeFor(botId);
        const current = store.getChat(key);
        store.setChat(key, { ...(current ?? { sessionId: '', cwd: this.defaultCwd, botId }), agentPreset: presetId });
        store.flush();
    }
    /** Persist a chat's working directory in its bot's own store. */
    setCwd(chatId, botId, cwd) {
        const key = routeKey(botId, chatId);
        const store = this.storeFor(botId);
        const current = store.getChat(key);
        store.setChat(key, { ...(current ?? { sessionId: '', cwd, botId }), cwd, botId });
        store.flush();
    }
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
    async switchCwd(chatId, botId, cwd) {
        if (sameDir(cwd, this.chatCwd(chatId, botId))) {
            // Same directory (case/separator-insensitive): keep the current session.
            return false;
        }
        const hadSession = await this.releaseSession(chatId, botId, { reason: 'switchCwd', cwd });
        this.logger?.warn(`[tg] switchCwd ${routeKey(botId, chatId)}: 已切换工作目录到 ${cwd},释放会话${hadSession ? '' : '(本无会话)'}`);
        return hadSession;
    }
    /**
     * Release the chat's current session WITHOUT touching its working directory.
     *
     * Used when the user archives the session this chat is driving: an archived
     * conversation disappears from every list, so the chat must fall back to the
     * session-selection flow instead of silently feeding messages into a hidden
     * conversation. Model / preset / cwd stay, exactly like a workspace switch.
     */
    async detach(chatId, botId) {
        const hadSession = await this.releaseSession(chatId, botId, { reason: 'detach' });
        if (hadSession) {
            this.logger?.warn(`[tg] detach ${routeKey(botId, chatId)}: 已释放会话(归档当前会话)`);
        }
        return hadSession;
    }
    /**
     * Shared release: drop config + live bindings, dispose our own agent (a
     * foreign one stays), clear the persisted session id and mark the chat
     * explicitly detached. A `cwd` in the options is persisted as the new
     * directory in the same write; without it the current directory is kept.
     */
    async releaseSession(chatId, botId, options) {
        const key = routeKey(botId, chatId);
        const hadSession = this.activeSessionId(chatId, botId) !== undefined;
        // Release the live binding for this route first (unbinds config + live).
        const previous = this.bindings.get(key);
        this.unbind(chatId, botId);
        // Drop the LIVE binding entry too. Disposing the agent without deleting the
        // map entry left a stale record behind: `activeSessionId()` kept reporting
        // the released session and `getOrCreate()` returned the disposed handle, so
        // the chat silently continued driving a dead conversation.
        this.bindings.delete(key);
        if (previous !== undefined) {
            this.relevant.delete(previous.sessionId);
            // Detach only sessions this chat CREATED. A config-bound or menu-picked
            // foreign session (e.g. a GUI conversation) must never be torn down by a
            // workspace switch — the config/menu binding is dropped, the agent stays.
            if (previous.botId === botId) {
                await previous.handle.dispose().catch(error => {
                    this.logger?.warn(`[tg] ${options.reason} dispose旧 agent 失败: ${messageOf(error)}`);
                });
            }
        }
        // Clear the persisted selection but keep cwd / model / preset / botId
        // (a cwd override from the caller lands in the same write).
        const store = this.storeFor(botId);
        const current = store.getChat(key);
        // cwd is required on ChatState; without an override keep the current one.
        const cwd = options.cwd ?? current?.cwd ?? this.chatCwd(chatId, botId);
        store.setChat(key, {
            ...(current ?? {}),
            sessionId: '',
            cwd,
            botId,
            sessionDetached: true,
        });
        store.flush();
        return hadSession;
    }
    /** Dispose every live binding (plugin unload). */
    async disposeAll() {
        const handles = [...this.bindings.values()].map(binding => binding.handle);
        this.bindings.clear();
        await Promise.allSettled(handles.map(handle => handle.dispose()));
    }
    /** Create a fresh session (mode `fresh`) or resume the persisted one. */
    async create(key, chatId, botId, cwd, generation, mode) {
        const store = this.storeFor(botId);
        this.scopeOf(botId);
        const persisted = store.getChat(key);
        const model = this.modelFor(chatId, botId);
        // The agent preset composes the agent's scoped world (tools, prompt sections).
        // A fresh session created WITHOUT one has no tools at all — no shell, no file
        // access — so always resolve one: the chat's 工作方式 pick first, else the
        // host default (`agentPresets.default`).
        const presetId = this.presetIdFor(chatId, botId);
        let handle;
        let sessionId;
        // A persisted session whose agent is ALREADY live in this process (e.g. a GUI
        // conversation, or a chat binding chosen from the menu before a restart) must
        // be adopted, never resumed: resuming a live session can fail and the old code
        // then fell back to a FRESH session, silently discarding the conversation.
        const liveAgent = mode === 'resume' && persisted !== undefined && persisted.sessionId !== ''
            ? this.factory.getLive(persisted.sessionId)
            : undefined;
        if (liveAgent !== undefined && persisted !== undefined) {
            sessionId = persisted.sessionId;
            // The plugin does not own this agent, so its disposer is a no-op: `/new`
            // and plugin unload must not tear down someone else's live session.
            handle = { agent: liveAgent, dispose: async () => { } };
            this.logger?.warn(`[tg] adopted live session ${sessionId} for ${key}`);
        }
        else if (mode === 'resume' && persisted !== undefined && persisted.sessionId !== '') {
            try {
                handle = await this.factory.resume({
                    sessionId: persisted.sessionId,
                    cwd: persisted.cwd || cwd,
                    provider: model.provider,
                    model: model.model,
                    routeKey: key,
                    // Our own sessions must re-join their preset on resume, or a resumed chat
                    // loses its tool world. Foreign GUI sessions keep the composition their
                    // creator mounted.
                    ...(isOwnSessionId(persisted.sessionId) && presetId !== undefined && presetId !== ''
                        ? { agentPreset: presetId }
                        : {}),
                });
                // Use the REAL resumed session id, not the template id: the two differ
                // whenever a chat is bound to a pre-existing (e.g. GUI) session, and
                // routing matches on the id the host actually emits.
                sessionId = sessionIdOf(handle) || persisted.sessionId;
                this.logger?.warn(`[tg] resumed session ${sessionId} for ${key}`);
            }
            catch (error) {
                // Persisted session no longer available: fall through to a fresh create.
                this.logger?.warn(`[tg] resume failed for ${key}: ${messageOf(error)}; creating fresh`);
                const fresh = await this.createFresh(key, chatId, botId, cwd, generation, model, presetId);
                handle = fresh.handle;
                sessionId = fresh.sessionId;
            }
        }
        else {
            const fresh = await this.createFresh(key, chatId, botId, cwd, generation, model, presetId);
            handle = fresh.handle;
            sessionId = fresh.sessionId;
        }
        store.setChat(key, {
            ...(persisted ?? {}),
            sessionId,
            cwd,
            botId,
            // A create (fresh or resume) re-attaches this chat to a conversation:
            // clear the workspace-switch detach marker so `activeSessionId()` trusts
            // the new session id again.
            sessionDetached: false,
        });
        store.flush();
        const binding = {
            chatId, botId, routeKey: key, handle, sessionId, cwd,
            provider: model.provider, model: model.model, generation,
        };
        this.bindings.set(key, binding);
        this.relevant.add(sessionId);
        // Fresh sessions must join the workspace account for their cwd, or the GUI
        // workspace sidebar groups them under「未分组」(grouping reads the registry's
        // sessionIds membership, never the session's own cwd header).
        if (mode === 'fresh' && this.attachWorkspace !== undefined) {
            void Promise.resolve(this.attachWorkspace(sessionId, cwd)).catch(error => {
                this.logger?.warn(`[tg] 工作区挂载失败(非致命) ${sessionId}: ${messageOf(error)}`);
            });
        }
        return binding;
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
    async createFresh(key, chatId, botId, cwd, generation, model, agentPreset) {
        let n = generation;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const candidate = this.candidateSessionId(botId, chatId, n);
            if (this.isSessionIdTaken(botId, candidate)) {
                n += 1;
                continue;
            }
            try {
                this.logger?.warn(`[tg] fresh session ${candidate} cwd=${cwd} preset=${agentPreset ?? '(宿主默认)'}`);
                const handle = await this.factory.create({
                    sessionId: SessionId(candidate),
                    cwd,
                    provider: model.provider,
                    model: model.model,
                    routeKey: key,
                    ...(agentPreset !== undefined && agentPreset !== '' ? { agentPreset } : {}),
                });
                return { handle, sessionId: sessionIdOf(handle) || candidate };
            }
            catch (error) {
                if (!isSessionAlreadyExists(error))
                    throw error;
                this.logger?.warn(`[tg] session id ${candidate} 已存在于宿主,改试下一个候选`);
                n += 1;
            }
        }
        throw new Error(`dsh-telegram: 连续 50 个候选 session id 都与宿主已有会话冲突(bot=${botId} chat=${chatId})`);
    }
    /** Candidate fresh-session id for generation `n`: `telegram:<bot>:<chat>[:g<n>]`. */
    candidateSessionId(botId, chatId, n) {
        const base = `telegram:${botId}:${chatId}`;
        return n === 0 ? base : `${base}:g${n}`;
    }
    isSessionIdTaken(botId, sessionId) {
        if (this.relevant.has(sessionId))
            return true;
        if (this.factory.getLive(sessionId) !== undefined)
            return true;
        for (const binding of this.bindings.values()) {
            if (binding.sessionId === sessionId)
                return true;
        }
        for (const entry of this.bound.values()) {
            if (entry.sessionId === sessionId)
                return true;
        }
        for (const state of Object.values(this.storeFor(botId).allChats())) {
            if (state.sessionId === sessionId)
                return true;
        }
        return false;
    }
}
