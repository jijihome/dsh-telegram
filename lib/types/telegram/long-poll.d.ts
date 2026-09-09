/**
 * Single-bot long-poll loop. Owns the `getUpdates` offset cursor (persisted
 * across restarts by the bot manager), a bounded retry/backoff, and dispatch
 * of each update to the update handler. One instance per bot, so a failing
 * bot never blocks the others.
 *
 * Structure follows @loserfox/telegram's bridge poll loop (BSD-3-Clause),
 * made standalone and offline-tolerant.
 *
 * @module telegram/long-poll
 */
import type { TelegramClientLike, TelegramUpdate } from './api.js';
/** One long-poll cycle outcome, so the manager can re-arm or report. */
export type PollOutcome = 'continue' | 'stopped';
export interface LongPollOptions {
    /** Telegram API client (already bound to a token). */
    client: TelegramClientLike;
    /** Called for each message-bearing update. */
    onUpdate(update: TelegramUpdate): Promise<void> | void;
    /** Called when a poll cycle failed (offset NOT advanced). */
    onError?(error: unknown, attempt: number, nextDelayMs: number): void;
    /** Delay seam; tests substitute an instant sleep. */
    sleep?: (ms: number) => Promise<void>;
    /** Floor between empty polls so an instant-empty transport cannot hot-loop. */
    cadenceMs?: number;
}
/** Long-pollloop with offset cursor, retry backoff, and clean stop. */
export declare class LongPoll {
    private readonly client;
    private readonly onUpdate;
    private readonly onError;
    private readonly sleep;
    private readonly cadenceMs;
    private offset;
    private stopped;
    private errorCount;
    private runPromise;
    constructor(options: LongPollOptions);
    /** Restore a previously saved offset so an acknowledged update is never re-fetched. */
    restoreOffset(offset: number | undefined): void;
    /** Current offset cursor; the manager persists it after each cycle. */
    get currentOffset(): number | undefined;
    /** Whether the loop is (still) running. */
    get running(): boolean;
    /** Start polling. Idempotent. */
    start(): void;
    /** Stop polling; resolves when the current cycle settles. */
    stop(): Promise<void>;
    private run;
}
