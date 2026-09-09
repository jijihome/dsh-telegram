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
/** Long-pollloop with offset cursor, retry backoff, and clean stop. */
export class LongPoll {
    client;
    onUpdate;
    onError;
    sleep;
    cadenceMs;
    offset;
    stopped = false;
    errorCount = 0;
    runPromise;
    constructor(options) {
        this.client = options.client;
        this.onUpdate = options.onUpdate;
        this.onError = options.onError;
        this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
        this.cadenceMs = options.cadenceMs ?? 50;
    }
    /** Restore a previously saved offset so an acknowledged update is never re-fetched. */
    restoreOffset(offset) {
        this.offset = offset;
    }
    /** Current offset cursor; the manager persists it after each cycle. */
    get currentOffset() {
        return this.offset;
    }
    /** Whether the loop is (still) running. */
    get running() {
        return this.runPromise !== undefined && !this.stopped;
    }
    /** Start polling. Idempotent. */
    start() {
        if (this.runPromise !== undefined)
            return;
        this.stopped = false;
        this.runPromise = this.run();
    }
    /** Stop polling; resolves when the current cycle settles. */
    async stop() {
        this.stopped = true;
        await this.runPromise;
        this.runPromise = undefined;
    }
    async run() {
        while (!this.stopped) {
            let updates;
            try {
                updates = await this.client.getUpdates(this.offset);
                this.errorCount = 0;
            }
            catch (error) {
                this.errorCount += 1;
                const delay = Math.min(1000 * this.errorCount, 10000);
                this.onError?.(error, this.errorCount, delay);
                await this.sleep(delay);
                continue;
            }
            for (const update of updates) {
                // Only message and callback_query updates matter; both must advance
                // the offset and reach the handler (callback_query has no message).
                if (update.message === undefined && update.callback_query === undefined)
                    continue;
                this.offset = update.update_id + 1;
                try {
                    await this.onUpdate(update);
                }
                catch (error) {
                    // Update-level failure must not kill the poll loop.
                    this.onError?.(error, 0, 0);
                }
            }
            if (updates.length === 0)
                await this.sleep(this.cadenceMs);
        }
    }
}
