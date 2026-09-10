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
import type { Context } from '@deepseek-ai/cordis';
import type { SessionManager } from '../core/session-manager.js';
import type { Delivery } from '../telegram/delivery.js';
export interface StreamListenerOptions {
    ctx: Context;
    sessions: SessionManager;
    /** One delivery per bot, keyed by bot id. */
    deliveries: ReadonlyMap<string, Delivery>;
    /**
     * Send a visible "✅ 完成" line on a clean `turn/end`. Defaults to true so the
     * bot always gets an explicit end-of-session signal; set false to suppress the
     * extra line on clean completions. Interruption causes are always surfaced.
     */
    notifyEnd?: boolean;
    /**
     * B (time-based watchdog): while a turn is open, if NO session activity
     * arrives for this many milliseconds, report a suspected stall to the bot.
     * Defaults to 120000 (2 min); `0` disables the watchdog. Complements the
     * event-based A notice (which catches a *deliberate* pause) by also catching
     * a wedged turn that never reaches a stop boundary.
     */
    stallNoticeMs?: number;
    /**
     * Quiescence window (ms) before the event-based "waiting for input" notice is
     * sent. Defaults to 2500: long enough that a normal `turn/end` cancels it,
     * short enough to feel responsive. Exposed mainly for tests.
     */
    waitQuiescenceMs?: number;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** Subscribes to session/event and fans normalized messages out to deliveries. */
export declare class StreamListener {
    private readonly ctx;
    private readonly sessions;
    private readonly deliveries;
    private readonly notifyEnd;
    private readonly logger;
    private disposer;
    /**
     * Per-session last turn already reported as a terminal status. Both
     * `agent/error` and `turn/end(reason:error)` can fire for the same turn, and
     * forwarding both would double-notify the bot. Keyed by session id because
     * turn numbers are monotonic within a session and reset across `/new`.
     */
    private readonly terminalReported;
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
    private readonly pendingWait;
    /**
     * B (watchdog): per-session timer armed while a turn is open. Any session
     * activity resets it; firing means the turn produced nothing for
     * `stallNoticeMs`. `openTurn` records the turn number so a stale timer can be
     * ignored, and `stallNotified` ensures at most one stall line per turn.
     */
    private readonly stallWatch;
    private readonly openTurn;
    private readonly stallNotified;
    /** Watchdog window in ms; 0 disables the time-based stall notice. */
    private readonly stallNoticeMs;
    /** Quiescence window (ms) for the event-based "waiting" notice. */
    private readonly waitQuiescenceMs;
    constructor(options: StreamListenerOptions);
    start(): void;
    /**
     * A (event-based) "waiting for user" notice. Arms a short quiescence window:
     * if no session activity arrives before it elapses, the agent is paused on
     * user input and the bot is told so. Re-arming replaces the previous timer, so
     * repeated stop/idle signals cannot stack notices.
     */
    private armWaitNotice;
    stop(): void;
    private handle;
    /**
     * Resolve a DSH session id to every bound (chatId, botId) route. Under strict
     * multi-bot isolation this is exactly one route: the plugin's own live binding
     * when the chat owns the session, otherwise its single config binding. A bare
     * chatId binding (botId '') can only exist in a single-bot deployment, where
     * it resolves to that one bot. More than one route here means every involved
     * bot explicitly opted into `allowSharedSessions`, and is logged as such.
     */
    private resolveRoutes;
    /** Cancel a pending "waiting for input" notice (session became active again). */
    private cancelPendingWait;
    /** B: (re)arm the stall watchdog for an open turn. No-op when disabled. */
    private armStallWatch;
    /** B: clear the stall watchdog (turn closed, or a newer turn took over). */
    private cancelStallWatch;
    /** End the live segment and report an agent-level failure to the bot. */
    private applyAgentFailure;
    /** Apply one normalized message to the chat's delivery. */
    private apply;
}
