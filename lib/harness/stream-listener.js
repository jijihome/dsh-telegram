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
import { normalizeChunk, normalizeSessionEvent } from '../core/event-normalizer.js';
import { renderStatus } from '../core/renderer.js';
/** Subscribes to session/event and fans normalized messages out to deliveries. */
export class StreamListener {
    ctx;
    sessions;
    deliveries;
    notifyEnd;
    logger;
    disposer;
    /**
     * Per-session last turn already reported as a terminal status. Both
     * `agent/error` and `turn/end(reason:error)` can fire for the same turn, and
     * forwarding both would double-notify the bot. Keyed by session id because
     * turn numbers are monotonic within a session and reset across `/new`.
     */
    terminalReported = new Map();
    constructor(options) {
        this.ctx = options.ctx;
        this.sessions = options.sessions;
        this.deliveries = options.deliveries;
        this.notifyEnd = options.notifyEnd ?? false;
        this.logger = options.logger;
    }
    start() {
        if (this.disposer !== undefined)
            return;
        this.disposer = this.ctx.on('session/event', (session, event) => {
            try {
                this.handle(session, event);
            }
            catch (error) {
                this.logger?.warn(`[tg] session event handling failed: ${String(error)}`);
            }
        }, { global: true });
        // Agent-level diagnostics: driver status transitions and errors are NOT
        // part of session/event — kick() swallows turn failures into agent/error.
        // `agent/status` is a diagnostic only; interruption causes arrive through
        // `turn/end.reason` (authoritative) and `agent/error` (fallback for errors
        // without an in-turn position).
        this.ctx.on('agent/status', (payload) => {
            const sessionId = String(payload.agent?.session?.id ?? '?');
            // Only diagnostics for sessions this plugin is responsible for; every
            // other agent in the host is not our concern and would only add noise.
            if (sessionId === '?' || !this.sessions.isRelevant(sessionId))
                return;
            this.logger?.warn(`[tg] agent/status ${payload.status} for ${sessionId}`);
        });
        // Forward a live agent failure to the bot. Dedup against a later
        // turn/end(error) so the same turn is not reported twice.
        this.ctx.on('agent/error', (payload) => {
            const sessionId = String(payload.agent?.session?.id ?? '');
            const turn = payload.turn ?? -1;
            if (sessionId === '') {
                this.logger?.warn(`[tg] agent/error without session: ${String(payload.error)}`);
                return;
            }
            // Ignore errors from sessions this plugin is not responsible for.
            if (!this.sessions.isRelevant(sessionId))
                return;
            if (this.terminalReported.get(sessionId) === turn) {
                this.logger?.warn(`[tg] agent/error ${sessionId}#${turn} already reported; skipping`);
                return;
            }
            const routes = this.resolveRoutes(sessionId);
            if (routes.length === 0) {
                this.logger?.warn(`[tg] agent/error for unbound ${sessionId}#${turn}; logging only`);
                return;
            }
            this.terminalReported.set(sessionId, turn);
            this.logger?.warn(`[tg] agent/error ${sessionId}#${turn}: ${String(payload.error)}`);
            for (const route of routes) {
                const delivery = this.deliveries.get(route.botId);
                if (delivery !== undefined)
                    void this.applyAgentFailure(route.chatId, delivery, errorText(payload.error));
            }
        });
    }
    stop() {
        if (this.disposer !== undefined) {
            this.disposer();
            this.disposer = undefined;
        }
    }
    handle(session, event) {
        const sessionId = String(session.id);
        // Gate: only process events for sessions this plugin is responsible for
        // (its own telegram agents + bound chats). Every other session in the host
        // is not our concern — skip immediately with an O(1) set probe, so we are
        // never scanned/routed/logged for, and never add latency to, a foreign
        // session's event dispatch. This is what keeps the plugin out of the global
        // hot path (and off other sessions' back).
        if (!this.sessions.isRelevant(sessionId))
            return;
        const routes = this.resolveRoutes(sessionId);
        if (routes.length === 0) {
            // Relevant but momentarily unresolved (e.g. a bound session before its
            // routing settles): drop silently rather than flooding.
            return;
        }
        // Trace the important lifecycle events through the bound path so the
        // daemon log shows whether a turn actually starts and finishes.
        // (Runtime event types are wider than the SessionEvent union.)
        const type = event.type;
        if (type === 'turn/start' || type === 'turn/end' ||
            type === 'assistant/message' || type === 'step/start' ||
            type === 'step/end') {
            this.logger?.warn(`[tg] event ${type} for ${sessionId}`);
        }
        // 1. Chunk events drive the live streaming segment.
        if (event.type === 'assistant/chunk') {
            const chunk = event.data.chunk;
            const message = normalizeChunk(chunk);
            if (message === undefined)
                return;
            for (const route of routes) {
                const delivery = this.deliveries.get(route.botId);
                if (delivery !== undefined)
                    void this.apply(route.chatId, delivery, message);
            }
            return;
        }
        // 2. All other events: normalize then dispatch.
        const message = normalizeSessionEvent(event);
        if (message === undefined)
            return;
        // A terminal `turn/end` (cancel/error/…) also fires `agent/error` for the
        // same turn; record the report once so the bot is not notified twice.
        if (type === 'turn/end' && message.kind === 'status' && message.status !== 'done') {
            const turn = event.data.turn ?? -1;
            if (this.terminalReported.get(sessionId) === turn) {
                this.logger?.warn(`[tg] turn/end ${sessionId}#${turn} already reported; skipping`);
                return;
            }
            this.terminalReported.set(sessionId, turn);
        }
        for (const route of routes) {
            const delivery = this.deliveries.get(route.botId);
            if (delivery !== undefined)
                void this.apply(route.chatId, delivery, message);
        }
    }
    /**
     * Resolve a DSH session id to every bound (chatId, botId) route. Under strict
     * multi-bot isolation this is exactly one route: the plugin's own live binding
     * when the chat owns the session, otherwise its single config binding. A bare
     * chatId binding (botId '') can only exist in a single-bot deployment, where
     * it resolves to that one bot. More than one route here means every involved
     * bot explicitly opted into `allowSharedSessions`, and is logged as such.
     */
    resolveRoutes(sessionId) {
        const binding = this.sessions.bySessionId(sessionId);
        if (binding !== undefined)
            return [{ chatId: binding.chatId, botId: binding.botId }];
        const routes = [];
        for (const bound of this.sessions.byBoundSessionIds(sessionId)) {
            if (bound.botId !== '') {
                routes.push({ chatId: bound.chatId, botId: bound.botId });
                continue;
            }
            // Bare binding: applies to any bot. Single-bot → resolve to that bot;
            // multi-bot → no unique target outbound, skip this entry.
            if (this.deliveries.size === 1) {
                const onlyBot = this.deliveries.keys().next().value;
                if (onlyBot !== undefined)
                    routes.push({ chatId: bound.chatId, botId: onlyBot });
            }
            else {
                this.logger?.warn(`[tg] bound session ${sessionId} has no unique bot (bare binding, multi-bot); skipping`);
            }
        }
        if (routes.length > 1) {
            this.logger?.warn(`[tg] 会话 ${sessionId} 被 ${routes.length} 个路由订阅(allowSharedSessions 已开启);输出将同时投递给 ${routes.map(r => r.botId).join(', ')}`);
        }
        return routes;
    }
    /** End the live segment and report an agent-level failure to the bot. */
    async applyAgentFailure(chatId, delivery, detail) {
        await delivery.endLive(chatId);
        await delivery.sendFinal(chatId, `⚠️ 步骤出错: ${detail}`);
    }
    /** Apply one normalized message to the chat's delivery. */
    async apply(chatId, delivery, message) {
        switch (message.kind) {
            case 'text-delta':
                await delivery.appendDelta(chatId, message.text);
                break;
            case 'reasoning-delta':
                // Reasoning deltas stream into the same live segment with a marker.
                await delivery.appendDelta(chatId, message.text);
                break;
            case 'tool-call-delta':
                // Default: do NOT forward tool-call events to Telegram — tool names /
                // argument deltas render as fragmented text there. A later "message
                // switch" config option will let the user choose which kinds to send.
                break;
            case 'assistant-final':
                // The answer may already have been streamed into the live message
                // (text/reasoning deltas). If so, that message IS the answer — flush
                // any tail and do NOT send a duplicate final message.
                if (!(await delivery.finalizeLive(chatId))) {
                    await delivery.sendFinal(chatId, message.interrupted ? `⛔ [已中断] ${message.text}` : message.text);
                }
                break;
            case 'status':
                if (message.status === 'running') {
                    await delivery.typing(chatId);
                    delivery.resetStream(chatId);
                }
                else if (message.status === 'done') {
                    await delivery.endLive(chatId);
                    // Clean completion: end the live segment, and optionally send an
                    // explicit end line so the bot always knows the turn finished.
                    if (this.notifyEnd)
                        await delivery.sendFinal(chatId, renderStatus('done'));
                }
                else {
                    // Terminal interruption: flush any live partial, then report the cause.
                    await delivery.endLive(chatId);
                    await delivery.sendFinal(chatId, renderStatus(message.status, message.detail));
                }
                break;
            case 'approval':
                await delivery.endLive(chatId);
                await delivery.sendFinal(chatId, `🔐 ${message.summary}`);
                break;
            case 'user-message':
                // A user message in the bound session (e.g. typed in the web GUI) is
                // forwarded so the bot shows the full conversation. Our own echo is
                // kept out of the live stream but still visible as a fixed message.
                await delivery.sendFinal(chatId, `👤 ${message.text}`);
                break;
        }
    }
}
/** Flatten an arbitrary thrown/LlmFailure error into a short message. */
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    if (error !== null && typeof error === 'object') {
        const obj = error;
        const message = typeof obj.message === 'string' ? obj.message : '';
        const code = typeof obj.code === 'string' ? obj.code : '';
        if (message !== '' && code !== '')
            return `${message} (${code})`;
        return message || code || '未知错误';
    }
    return String(error ?? '未知错误');
}
