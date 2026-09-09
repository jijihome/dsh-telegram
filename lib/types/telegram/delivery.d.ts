/**
 * Delivery layer: final messages (split + HTML fallback), typing indicator,
 * and throttled incremental live editing.
 *
 * One "live segment" per chat buffers incoming text deltas; the segment is
 * edited in place on a throttle (Telegram allows ~1 message/sec/chat, and
 * burst edits trip 429), until it reaches the Telegram length cap (sealed,
 * fresh segment starts) or the stream ends.
 *
 * @module telegram/delivery
 */
import type { TelegramClientLike, TelegramInlineKeyboard } from './api.js';
export interface DeliveryOptions {
    /** Telegram API client (bound to one bot). */
    client: TelegramClientLike;
    /** Per-chunk message length limit (Telegram caps at 4096). */
    maxMessageLength?: number;
    /** Logger (`error(message)` / `warn(message)`). */
    logger?: {
        error(...args: unknown[]): void;
        warn(...args: unknown[]): void;
    };
    /** If set, every text actually sent/edited to Telegram is appended here. */
    forwardLogPath?: string;
}
/**
 * Handles delivery for one bot. Created per bot so state never leaks across
 * bots and a slow send on one bot cannot stall another.
 */
export declare class Delivery {
    private readonly client;
    private readonly maxMessageLength;
    private readonly logger;
    private readonly forwardLogPath;
    private readonly live;
    /**
     * Per chat: whether the current turn's final answer has already been surfaced
     * to Telegram (either streamed into a live message and finalized, or carried
     * by a `turn/end` cleanup). Prevents `assistant-final` from re-sending the
     * same answer as a second message. Reset on the next `turn/start`.
     */
    private readonly answered;
    constructor(options: DeliveryOptions);
    /** Append the exact text about to be sent/edited to the forward log file. */
    private logForward;
    /**
     * Send a final (already complete) message: split into ≤ maxLength chunks;
     * HTML parse failures fall back to plain text for that chunk.
     */
    sendFinal(chatId: number, text: string): Promise<void>;
    /** Send a message with an optional inline keyboard (menu navigation). */
    sendMenu(chatId: number, text: string, keyboard?: TelegramInlineKeyboard): Promise<void>;
    /** Show the typing indicator (fire and forget). */
    typing(chatId: number): Promise<void>;
    /**
     * Append a text delta to the chat's live segment, scheduling a throttled
     * in-place edit. Seals (and re-sends) segments that outgrow the cap.
     */
    appendDelta(chatId: number, delta: string): Promise<void>;
    /** Reset the per-chat "answer delivered" flag for a fresh turn (`turn/start`). */
    resetStream(chatId: number): void;
    /**
     * Finalize the answer once the turn's `assistant/message` arrives. Whenever
     * the reply was already streamed into a live message (text/reasoning
     * deltas), that live message IS the answer — so we flush any tail, mark it
     * delivered, and do **not** send a duplicate `assistant-final` message.
     * Returns `true` when the answer was surfaced (caller must not re-send),
     * `false` when nothing was live (caller sends the final text fresh).
     */
    finalizeLive(chatId: number): Promise<boolean>;
    /**
     * End a live stream: push any un-flushed tail into the live message (or
     * send it when no live message exists yet), then drop live state.
     */
    endLive(chatId: number): Promise<void>;
    /** Drop live state without sending (e.g. on cancel where a status msg follows). */
    discardLive(chatId: number): void;
    /** Flush one chat's live segment (throttled, serialized, 429-aware). */
    private flushSegment;
    /** Send or edit the current live segment text (with 429 back-off retry). */
    private refreshSegment;
    /** Seal a live segment as a final message (split, HTML, plain fallback). */
    private sealSegment;
    /** Wrap one API call with a single 429 `retry after N` back-off retry. */
    private with429Retry;
    private htmlOf;
    /** Send one chunk with HTML parse mode and plain-text fallback. */
    private safeSend;
}
