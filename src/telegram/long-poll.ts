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

import type { TelegramClientLike, TelegramUpdate } from './api.js'

/** One long-poll cycle outcome, so the manager can re-arm or report. */
export type PollOutcome = 'continue' | 'stopped'

export interface LongPollOptions {
  /** Telegram API client (already bound to a token). */
  client: TelegramClientLike
  /** Called for each message-bearing update. */
  onUpdate(update: TelegramUpdate): Promise<void> | void
  /** Called when a poll cycle failed (offset NOT advanced). */
  onError?(error: unknown, attempt: number, nextDelayMs: number): void
  /** Delay seam; tests substitute an instant sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Floor between empty polls so an instant-empty transport cannot hot-loop. */
  cadenceMs?: number
}

/** Long-pollloop with offset cursor, retry backoff, and clean stop. */
export class LongPoll {
  private readonly client: TelegramClientLike
  private readonly onUpdate: LongPollOptions['onUpdate']
  private readonly onError: LongPollOptions['onError']
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cadenceMs: number
  private offset: number | undefined
  private stopped = false
  private errorCount = 0
  private runPromise: Promise<void> | undefined

  constructor(options: LongPollOptions) {
    this.client = options.client
    this.onUpdate = options.onUpdate
    this.onError = options.onError
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
    this.cadenceMs = options.cadenceMs ?? 50
  }

  /** Restore a previously saved offset so an acknowledged update is never re-fetched. */
  restoreOffset(offset: number | undefined): void {
    this.offset = offset
  }

  /** Current offset cursor; the manager persists it after each cycle. */
  get currentOffset(): number | undefined {
    return this.offset
  }

  /** Whether the loop is (still) running. */
  get running(): boolean {
    return this.runPromise !== undefined && !this.stopped
  }

  /** Start polling. Idempotent. */
  start(): void {
    if (this.runPromise !== undefined) return
    this.stopped = false
    this.runPromise = this.run()
  }

  /** Stop polling; resolves when the current cycle settles. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.runPromise
    this.runPromise = undefined
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let updates: TelegramUpdate[]
      try {
        updates = await this.client.getUpdates(this.offset)
        this.errorCount = 0
      } catch (error) {
        this.errorCount += 1
        const delay = Math.min(1000 * this.errorCount, 10000)
        this.onError?.(error, this.errorCount, delay)
        await this.sleep(delay)
        continue
      }
      for (const update of updates) {
        // Only message and callback_query updates matter; both must advance
        // the offset and reach the handler (callback_query has no message).
        if (update.message === undefined && update.callback_query === undefined) continue
        this.offset = update.update_id + 1
        try {
          await this.onUpdate(update)
        } catch (error) {
          // Update-level failure must not kill the poll loop.
          this.onError?.(error, 0, 0)
        }
      }
      if (updates.length === 0) await this.sleep(this.cadenceMs)
    }
  }
}