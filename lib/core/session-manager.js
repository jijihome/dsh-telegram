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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
const sessionKey = (botId, chatId) => `${botId}:${chatId}`;
/** Stable message text for logging. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Manages per-chat agent sessions. */
export class SessionManager {
    factory;
    store;
    provider;
    model;
    defaultCwd;
    logger;
    bindings = new Map();
    constructor(options) {
        this.factory = options.factory;
        this.store = options.store;
        this.provider = options.provider;
        this.model = options.model;
        this.defaultCwd = options.defaultCwd;
        this.logger = options.logger;
    }
    /** Live binding for a chat, or undefined. */
    get(chatId, botId) {
        return this.bindings.get(sessionKey(botId, chatId));
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
     * Get the chat's agent, creating it if needed. On first creation it tries
     * to resume a persisted session; otherwise it starts a new one.
     */
    async getOrCreate(chatId, botId, cwd) {
        const key = sessionKey(botId, chatId);
        const existing = this.bindings.get(key);
        if (existing !== undefined)
            return existing;
        return this.create(key, chatId, botId, cwd ?? this.defaultCwd, 0);
    }
    /** Rotate to a fresh session (`/new`); disposes the previous agent. */
    async rotate(chatId, botId) {
        const key = sessionKey(botId, chatId);
        const previous = this.bindings.get(key);
        const generation = (previous?.generation ?? 0) + 1;
        const binding = await this.create(key, chatId, botId, previous?.cwd ?? this.defaultCwd, generation);
        if (previous !== undefined) {
            await previous.handle.dispose().catch(error => {
                this.logger?.warn(`[tg] dispose old agent failed: ${messageOf(error)}`);
            });
        }
        return binding;
    }
    /** Cancel the chat's current turn (`/stop`); no-op when idle. */
    cancel(chatId, botId) {
        const binding = this.bindings.get(sessionKey(botId, chatId));
        if (binding === undefined)
            return false;
        binding.handle.agent.cancel({ kind: 'user' });
        return true;
    }
    /** Send a user text into the chat's agent (queued as a normal follow-up). */
    followup(chatId, botId, text, onError) {
        const binding = this.bindings.get(sessionKey(botId, chatId));
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
    /** Dispose every live binding (plugin unload). */
    async disposeAll() {
        const handles = [...this.bindings.values()].map(binding => binding.handle);
        this.bindings.clear();
        await Promise.allSettled(handles.map(handle => handle.dispose()));
    }
    /** Create (or resume) the binding for a chat. */
    async create(key, chatId, botId, cwd, generation) {
        const persisted = this.store.getChat(key);
        const sessionId = SessionId(`telegram:${key}`);
        let handle;
        if (persisted !== undefined && persisted.sessionId !== '') {
            try {
                handle = await this.factory.resume({
                    sessionId: persisted.sessionId,
                    cwd: persisted.cwd || cwd,
                    provider: this.provider,
                    model: this.model,
                });
                this.logger?.warn(`[tg] resumed session ${persisted.sessionId} for ${key}`);
            }
            catch (error) {
                // Persisted session no longer available: fall through to a fresh create.
                this.logger?.warn(`[tg] resume failed for ${key}: ${messageOf(error)}; creating fresh`);
                handle = await this.factory.create({
                    sessionId,
                    cwd,
                    provider: this.provider,
                    model: this.model,
                });
                this.store.setChat(key, { sessionId: String(sessionId), cwd, botId });
            }
        }
        else {
            handle = await this.factory.create({
                sessionId,
                cwd,
                provider: this.provider,
                model: this.model,
            });
            this.store.setChat(key, { sessionId: String(sessionId), cwd, botId });
        }
        const binding = { chatId, botId, handle, sessionId: String(sessionId), cwd, generation };
        this.bindings.set(key, binding);
        return binding;
    }
}
