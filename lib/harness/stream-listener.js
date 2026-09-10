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
    /**
     * "等待输入" detection: DSH surface event vocabulary has no "waiting for the
     * user" event. The closest signal is `agent/turn-stopping` (the agent reached
     * its stop boundary and is about to hand control back), but that also fires
     * right before a normal `turn/end`. We therefore delay the "waiting" line by a
     * short quiescence window: if NO session activity arrives for the session
     * within that window, the agent is genuinely paused waiting for input, so the
     * bot gets an explicit "⏳ 等待你的回复…" instead of appearing stalled. Any
     * chunk/step/turn/assistant activity cancels the pending notice.
     */
    pendingWait = new Map();
    /**
     * B (watchdog): per-session timer armed while a turn is open. Any session
     * activity resets it; firing means the turn produced nothing for
     * `stallNoticeMs`. `openTurn` records the turn number so a stale timer can be
     * ignored, and `stallNotified` ensures at most one stall line per turn.
     */
    stallWatch = new Map();
    openTurn = new Map();
    stallNotified = new Map();
    /** Turn already reported as "waiting for input" (A), so B does not duplicate it. */
    waitNotified = new Map();
    /**
     * Whether the session currently has a step in flight (`step/start` seen with
     * no `step/end`). A long-running tool call or model request lives INSIDE a
     * step, so silence there is expected and must NOT be reported as a stall —
     * this is what stops the watchdog from crying wolf while the agent is happily
     * grinding through a slow read/command. Only silence with no open step (the
     * agent produced nothing and is between steps) is a real stall signal.
     */
    openStep = new Map();
    /** Watchdog window in ms; 0 disables the time-based stall notice. */
    stallNoticeMs;
    /** Quiescence window (ms) for the event-based "waiting" notice. */
    waitQuiescenceMs;
    constructor(options) {
        this.ctx = options.ctx;
        this.sessions = options.sessions;
        this.deliveries = options.deliveries;
        this.notifyEnd = options.notifyEnd ?? true;
        this.stallNoticeMs = options.stallNoticeMs ?? 120_000;
        this.waitQuiescenceMs = options.waitQuiescenceMs ?? 2500;
        this.logger = options.logger;
    }
    start() {
        if (this.disposer !== undefined)
            return;
        const offSessionEvent = this.ctx.on('session/event', (session, event) => {
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
            // A (event-based): an agent going idle right after a turn began, with no
            // turn/end following, is the "paused, waiting for the user" shape. Arm the
            // quiescence notice; any real session activity cancels it, and a normal
            // completion's turn/end arrives inside the window.
            if (payload.status === 'idle') {
                this.cancelStallWatch(sessionId);
                this.armWaitNotice(sessionId);
            }
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
        // "Waiting for user input" notice: `agent/turn-stopping` fires when the agent
        // reaches its stop boundary. If nothing else happens on the session shortly
        // after, the agent is paused awaiting user input — surface that so the bot
        // doesn't look like it stalled. Any subsequent session activity cancels it.
        this.ctx.on('agent/turn-stopping', (payload) => {
            const sessionId = String(payload.agent?.session?.id ?? '');
            if (sessionId === '?' || sessionId === '')
                return;
            if (!this.sessions.isRelevant(sessionId))
                return;
            // Reaching the stop boundary means the agent is done producing; if the
            // turn does not actually close shortly after, it is waiting on the user.
            this.cancelStallWatch(sessionId);
            this.armWaitNotice(sessionId);
        });
        // Compose every subscription's disposer so stop() releases them all.
        this.disposer = () => {
            offSessionEvent();
            for (const timer of this.pendingWait.values())
                clearTimeout(timer);
            this.pendingWait.clear();
            for (const timer of this.stallWatch.values())
                clearTimeout(timer);
            this.stallWatch.clear();
        };
    }
    /**
     * A (event-based) "waiting for user" notice. Arms a short quiescence window:
     * if no session activity arrives before it elapses, the agent is paused on
     * user input and the bot is told so. Re-arming replaces the previous timer, so
     * repeated stop/idle signals cannot stack notices.
     */
    armWaitNotice(sessionId) {
        const routes = this.resolveRoutes(sessionId);
        if (routes.length === 0)
            return;
        this.cancelPendingWait(sessionId);
        const timer = setTimeout(() => {
            this.pendingWait.delete(sessionId);
            // Only a turn that is still OPEN can be "waiting": a normal completion
            // fires agent/status idle too, but it already emitted turn/end (so the
            // turn was cleared) and must not produce a bogus waiting line.
            if (!this.openTurn.has(sessionId))
                return;
            const stillRoutes = this.resolveRoutes(sessionId);
            this.logger?.warn(`[tg] agent ${sessionId} paused; notifying "waiting for input"`);
            for (const route of stillRoutes) {
                const delivery = this.deliveries.get(route.botId);
                if (delivery !== undefined) {
                    // Record the turn so B's stall watchdog will not double-report it.
                    const turn = this.openTurn.get(sessionId);
                    if (turn !== undefined)
                        this.waitNotified.set(sessionId, turn);
                    void delivery.endLive(route.chatId);
                    void delivery.sendFinal(route.chatId, '⏳ agent 已暂停，正在等待你的回复/继续…');
                }
            }
        }, this.waitQuiescenceMs);
        // Advisory timers must never hold the event loop open (host shutdown, tests).
        timer.unref?.();
        this.pendingWait.set(sessionId, timer);
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
        // Session activity erases any "waiting" notice: the agent is clearly not
        // paused on user input right now.
        this.cancelPendingWait(sessionId);
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
        // B (watchdog) bookkeeping: an open turn is watched for silence; every
        // activity pushes the deadline out, and the turn closing stops the watch.
        const turn = event.data.turn ?? -1;
        if (type === 'step/start') {
            this.openStep.set(sessionId, true);
        }
        else if (type === 'step/end') {
            this.openStep.set(sessionId, false);
        }
        if (type === 'turn/start') {
            this.openTurn.set(sessionId, turn);
            this.stallNotified.delete(sessionId);
            this.waitNotified.delete(sessionId);
            this.openStep.set(sessionId, false);
            this.armStallWatch(sessionId, turn);
        }
        else if (type === 'turn/end') {
            this.openTurn.delete(sessionId);
            this.openStep.delete(sessionId);
            this.cancelStallWatch(sessionId);
        }
        else {
            const open = this.openTurn.get(sessionId);
            // Re-arm on activity only while no step is in flight: an open step already
            // suppresses the watchdog, and re-arming inside one would keep postponing
            // the check past the step's end.
            if (open !== undefined && this.openStep.get(sessionId) !== true)
                this.armStallWatch(sessionId, open);
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
    /** Cancel a pending "waiting for input" notice (session became active again). */
    cancelPendingWait(sessionId) {
        const timer = this.pendingWait.get(sessionId);
        if (timer === undefined)
            return;
        clearTimeout(timer);
        this.pendingWait.delete(sessionId);
    }
    /** B: (re)arm the stall watchdog for an open turn. No-op when disabled. */
    armStallWatch(sessionId, turn) {
        if (this.stallNoticeMs <= 0)
            return;
        this.cancelStallWatch(sessionId);
        const timer = setTimeout(() => {
            this.stallWatch.delete(sessionId);
            // Only report while that same turn is still open, and only once per turn.
            if (this.openTurn.get(sessionId) !== turn)
                return;
            if (this.stallNotified.get(sessionId) === turn)
                return;
            // A step is in flight → the agent is inside a (possibly slow) tool call or
            // model request; silence is expected. Keep waiting instead of crying wolf.
            if (this.openStep.get(sessionId) === true) {
                this.armStallWatch(sessionId, turn);
                return;
            }
            // The event-based notice already told the user this turn is waiting; do not
            // contradict it with a "stalled" line for the same turn.
            if (this.waitNotified.get(sessionId) === turn)
                return;
            this.stallNotified.set(sessionId, turn);
            const routes = this.resolveRoutes(sessionId);
            this.logger?.warn(`[tg] agent ${sessionId}#${turn} idle ${this.stallNoticeMs}ms with no step open; notifying stall`);
            for (const route of routes) {
                const delivery = this.deliveries.get(route.botId);
                if (delivery !== undefined) {
                    void delivery.sendFinal(route.chatId, `⚠️ 已 ${Math.round(this.stallNoticeMs / 1000)} 秒无输出且无进行中的步骤,agent 可能已停滞。可发消息催一下,或 /stop 取消。`);
                }
            }
        }, this.stallNoticeMs);
        // Advisory timers must never hold the event loop open (host shutdown, tests).
        timer.unref?.();
        this.stallWatch.set(sessionId, timer);
    }
    /** B: clear the stall watchdog (turn closed, or a newer turn took over). */
    cancelStallWatch(sessionId) {
        const timer = this.stallWatch.get(sessionId);
        if (timer === undefined)
            return;
        clearTimeout(timer);
        this.stallWatch.delete(sessionId);
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
