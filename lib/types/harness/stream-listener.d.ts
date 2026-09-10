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
    constructor(options: StreamListenerOptions);
    start(): void;
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
    /** End the live segment and report an agent-level failure to the bot. */
    private applyAgentFailure;
    /** Apply one normalized message to the chat's delivery. */
    private apply;
}
