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
    private readonly logger;
    private disposer;
    constructor(options: StreamListenerOptions);
    start(): void;
    stop(): void;
    private handle;
    /** Apply one normalized message to the chat's delivery. */
    private apply;
}
