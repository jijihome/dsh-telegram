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
import { markdownToHtml, splitMessage } from '../core/format.js';
import { appendFileSync } from 'node:fs';
/** Flush edits at most once per this interval (Telegram: ~1 msg/sec/chat). */
const FLUSH_INTERVAL_MS = 900;
/** Telegram shows a chat action for ~5s; refresh before it fades. */
const TYPING_REFRESH_MS = 4000;
/** One extra retry after a Telegram 429 back-off. */
const RETRY_AFTER = /retry after (\d+)/i;
/** Stable message text for logging, whatever the thrown shape. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Sleep for `ms` milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Handles delivery for one bot. Created per bot so state never leaks across
 * bots and a slow send on one bot cannot stall another.
 */
export class Delivery {
    client;
    maxMessageLength;
    logger;
    forwardLogPath;
    live = new Map();
    /**
     * Per chat: whether the current turn's final answer has already been surfaced
     * to Telegram (either streamed into a live message and finalized, or carried
     * by a `turn/end` cleanup). Prevents `assistant-final` from re-sending the
     * same answer as a second message. Reset on the next `turn/start`.
     */
    answered = new Map();
    /** Per-chat keep-alive timer for the "typing…" chat action. */
    typingTimers = new Map();
    constructor(options) {
        this.client = options.client;
        this.maxMessageLength = options.maxMessageLength ?? 4096;
        this.logger = options.logger;
        this.forwardLogPath = options.forwardLogPath;
    }
    /** Append the exact text about to be sent/edited to the forward log file. */
    logForward(kind, text) {
        if (this.forwardLogPath === undefined)
            return;
        try {
            appendFileSync(this.forwardLogPath, `[${new Date().toISOString()}] [${kind}] ${text}\n`, 'utf8');
        }
        catch {
            // Logging must never break delivery.
        }
    }
    /**
     * Send a final (already complete) message: split into ≤ maxLength chunks;
     * HTML parse failures fall back to plain text for that chunk.
     */
    async sendFinal(chatId, text) {
        for (const chunk of splitMessage(text, this.maxMessageLength)) {
            await this.safeSend(chatId, chunk, 'HTML');
        }
    }
    /** Send a message with an optional inline keyboard (menu navigation). */
    async sendMenu(chatId, text, keyboard) {
        const body = markdownToHtml(text);
        this.logForward('menu', body);
        try {
            await this.client.sendMessage(chatId, body, 'HTML', keyboard);
            return;
        }
        catch (error) {
            this.logger?.warn(`[tg] menu send fallback: ${messageOf(error)}`);
        }
        try {
            await this.client.sendMessage(chatId, text, undefined, keyboard);
        }
        catch (error) {
            this.logger?.error(`[tg] menu send failed: ${messageOf(error)}`);
        }
    }
    /** Show the typing indicator (fire and forget). */
    async typing(chatId) {
        try {
            await this.client.sendChatAction(chatId, 'typing');
        }
        catch (error) {
            this.logger?.warn(`[tg] chat action typing failed: ${messageOf(error)}`);
        }
    }
    /**
     * Keep the "typing…" indicator alive until {@link stopTyping}.
     *
     * Telegram shows a chat action for only a few seconds, so one send fades while
     * a long turn is still running. Re-send it on an interval; Telegram clears the
     * indicator by itself when a message arrives, so stopping the interval is all
     * that is needed once the answer is delivered.
     *
     * @param chatId - chat to keep typing in.
     */
    startTyping(chatId) {
        if (this.typingTimers.has(chatId))
            return;
        void this.typing(chatId);
        const timer = setInterval(() => { void this.typing(chatId); }, TYPING_REFRESH_MS);
        timer.unref?.();
        this.typingTimers.set(chatId, timer);
    }
    /** Stop refreshing the indicator (turn finished / answer delivered). */
    stopTyping(chatId) {
        const timer = this.typingTimers.get(chatId);
        if (timer === undefined)
            return;
        clearInterval(timer);
        this.typingTimers.delete(chatId);
    }
    /** Stop every typing keep-alive (bot stop / plugin unload). */
    stopAllTyping() {
        for (const timer of this.typingTimers.values())
            clearInterval(timer);
        this.typingTimers.clear();
    }
    /**
     * Append a text delta to the chat's live segment, scheduling a throttled
     * in-place edit. Seals (and re-sends) segments that outgrow the cap.
     */
    appendDelta(chatId, delta) {
        if (delta.length === 0)
            return Promise.resolve();
        let seg = this.live.get(chatId);
        if (seg === undefined) {
            seg = { buffer: '' };
            this.live.set(chatId, seg);
        }
        // Saturation: seal the current segment before it would cross the cap.
        if (seg.buffer.length + delta.length > this.maxMessageLength) {
            if (seg.timer !== undefined) {
                clearTimeout(seg.timer);
                seg.timer = undefined;
            }
            if (seg.buffer.length > 0) {
                void this.sealSegment(chatId, seg);
            }
            seg = { buffer: '' };
            this.live.set(chatId, seg);
        }
        seg.buffer += delta;
        // Throttle: coalesce burst deltas into one edit per interval.
        if (seg.timer === undefined && !seg.flushing) {
            seg.timer = setTimeout(() => {
                seg.timer = undefined;
                void this.flushSegment(chatId);
            }, FLUSH_INTERVAL_MS);
        }
        return Promise.resolve();
    }
    /** Reset the per-chat "answer delivered" flag for a fresh turn (`turn/start`). */
    resetStream(chatId) {
        this.answered.set(chatId, false);
    }
    /**
     * Finalize the answer once the turn's `assistant/message` arrives. Whenever
     * the reply was already streamed into a live message (text/reasoning
     * deltas), that live message IS the answer — so we flush any tail, mark it
     * delivered, and do **not** send a duplicate `assistant-final` message.
     * Returns `true` when the answer was surfaced (caller must not re-send),
     * `false` when nothing was live (caller sends the final text fresh).
     */
    async finalizeLive(chatId) {
        if (this.answered.get(chatId) === true)
            return true;
        const seg = this.live.get(chatId);
        if (seg === undefined)
            return false;
        if (seg.timer !== undefined) {
            clearTimeout(seg.timer);
            seg.timer = undefined;
        }
        // Push any tail that is not yet visible into the live message, then drop
        // live state. The streamed live message now carries the whole answer.
        if (seg.buffer.length > 0 && seg.lastText !== this.htmlOf(seg.buffer)) {
            await this.flushSegment(chatId);
        }
        this.live.delete(chatId);
        this.answered.set(chatId, true);
        return true;
    }
    /**
     * End a live stream: push any un-flushed tail into the live message (or
     * send it when no live message exists yet), then drop live state.
     */
    async endLive(chatId) {
        const seg = this.live.get(chatId);
        if (seg === undefined)
            return;
        if (seg.timer !== undefined) {
            clearTimeout(seg.timer);
            seg.timer = undefined;
        }
        if (seg.buffer.length > 0) {
            if (seg.messageId === undefined) {
                // Nothing visible yet: deliver the whole segment as a final message.
                await this.sealSegment(chatId, seg);
                this.answered.set(chatId, true);
            }
            else if (seg.lastText !== this.htmlOf(seg.buffer)) {
                // Live message already visible: push the remaining tail into it.
                await this.flushSegment(chatId);
                this.answered.set(chatId, true);
            }
        }
        else if (seg.messageId !== undefined) {
            // Live message already shows the streamed content; mark it delivered.
            this.answered.set(chatId, true);
        }
        this.live.delete(chatId);
    }
    /** Drop live state without sending (e.g. on cancel where a status msg follows). */
    discardLive(chatId) {
        const seg = this.live.get(chatId);
        if (seg === undefined)
            return;
        if (seg.timer !== undefined)
            clearTimeout(seg.timer);
        this.live.delete(chatId);
    }
    /** Flush one chat's live segment (throttled, serialized, 429-aware). */
    async flushSegment(chatId) {
        const seg = this.live.get(chatId);
        if (seg === undefined || seg.flushing)
            return;
        seg.flushing = true;
        try {
            await this.refreshSegment(chatId, seg);
        }
        catch (error) {
            this.logger?.error(`[tg] live flush failed: ${messageOf(error)}`);
        }
        finally {
            seg.flushing = false;
            // Deltas that arrived during the flush still need a later edit.
            if (this.live.get(chatId) === seg && seg.timer === undefined && seg.buffer.length > 0) {
                if (seg.lastText !== this.htmlOf(seg.buffer)) {
                    seg.timer = setTimeout(() => {
                        seg.timer = undefined;
                        void this.flushSegment(chatId);
                    }, FLUSH_INTERVAL_MS);
                }
            }
        }
    }
    /** Send or edit the current live segment text (with 429 back-off retry). */
    async refreshSegment(chatId, seg) {
        if (seg.buffer.length === 0)
            return;
        const html = this.htmlOf(seg.buffer);
        if (seg.messageId !== undefined && seg.lastText === html)
            return; // already shown
        if (seg.messageId === undefined) {
            // First delivery: send the live message (HTML, plain-text fallback).
            try {
                this.logForward('send', html);
                const sent = await this.with429Retry(() => this.client.sendMessage(chatId, html, 'HTML'));
                seg.messageId = sent.message_id;
                seg.lastText = html;
            }
            catch (error) {
                this.logger?.warn(`[tg] live send fallback: ${messageOf(error)}`);
                try {
                    this.logForward('send', seg.buffer);
                    const sent = await this.with429Retry(() => this.client.sendMessage(chatId, seg.buffer));
                    seg.messageId = sent.message_id;
                    seg.lastText = seg.buffer;
                }
                catch (sendError) {
                    // Keep the messageId undefined: the next flush tries a fresh send.
                    this.logger?.warn(`[tg] live send failed: ${messageOf(sendError)}`);
                }
            }
            return;
        }
        try {
            this.logForward('edit', html);
            await this.with429Retry(() => this.client.editMessageText(chatId, seg.messageId, html, 'HTML'));
            seg.lastText = html;
        }
        catch (error) {
            const message = messageOf(error);
            if (message.includes('message is not modified')) {
                seg.lastText = html; // treat as applied
                return;
            }
            // Non-transient edit failure (e.g. mid-stream entity imbalance):
            // fall back to plain text once.
            this.logger?.warn(`[tg] live edit fallback: ${message}`);
            try {
                await this.with429Retry(() => this.client.editMessageText(chatId, seg.messageId, seg.buffer));
                seg.lastText = seg.buffer;
            }
            catch (plainError) {
                this.logger?.warn(`[tg] live edit failed: ${messageOf(plainError)}`);
            }
        }
    }
    /** Seal a live segment as a final message (split, HTML, plain fallback). */
    async sealSegment(chatId, seg) {
        if (seg.buffer.length > 0)
            await this.sendFinal(chatId, seg.buffer);
    }
    /** Wrap one API call with a single 429 `retry after N` back-off retry. */
    async with429Retry(op) {
        try {
            return await op();
        }
        catch (error) {
            const match = RETRY_AFTER.exec(messageOf(error));
            if (match === null)
                throw error;
            const seconds = Number(match[1]);
            await sleep((seconds + 1) * 1000);
            return await op();
        }
    }
    htmlOf(text) {
        return markdownToHtml(text);
    }
    /** Send one chunk with HTML parse mode and plain-text fallback. */
    async safeSend(chatId, text, parseMode) {
        try {
            const body = parseMode === 'HTML' ? markdownToHtml(text) : text;
            this.logForward('send', body);
            await this.client.sendMessage(chatId, body, parseMode);
        }
        catch (error) {
            if (parseMode === 'HTML') {
                try {
                    await this.client.sendMessage(chatId, text);
                }
                catch (fallbackError) {
                    this.logger?.error(`[tg] delivery failed: ${messageOf(fallbackError)}`);
                }
            }
            else {
                this.logger?.error(`[tg] delivery failed: ${messageOf(error)}`);
            }
        }
    }
}
