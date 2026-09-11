/**
 * Rename pending store: holds the 「下一条消息即新标题」 state for one chat.
 *
 * Telegram cannot pop an input dialog, so renaming works in two steps: the
 * menu registers the target session here and tells the user to just send the
 * new title; the next ordinary text message is consumed as the title (or
 * /cancel aborts). One pending per (bot, chat); a bounded timeout (default
 * 120s) clears it so a forgotten wizard cannot swallow a later message.
 *
 * Timers are unref'd: the store must never hold the host/test event loop.
 *
 * @module core/rename-pending
 */

export interface RenamePending {
  /** Session the next text message renames. */
  sessionId: string
}

export interface RenamePendingStoreOptions {
  /** How long the chat stays in rename mode (default 120_000 ms). */
  timeoutMs?: number
  /** Called with the pending when it expires (notify the user). */
  onExpire?: (pending: RenamePending, chatId: number, botId: string) => void
}

const DEFAULT_TIMEOUT_MS = 120_000

/** Per-(bot, chat) rename-in-progress slots with timeout. */
export class RenamePendingStore {
  private readonly timeoutMs: number
  private readonly onExpire: RenamePendingStoreOptions['onExpire']
  private readonly slots = new Map<string, { pending: RenamePending; timer: NodeJS.Timeout }>()

  constructor(options: RenamePendingStoreOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.onExpire = options.onExpire
  }

  private static key(chatId: number, botId: string): string {
    return `${botId}:${chatId}`
  }

  /** Register (or replace) the rename target for one chat. */
  begin(chatId: number, botId: string, sessionId: string): void {
    const key = RenamePendingStore.key(chatId, botId)
    const existing = this.slots.get(key)
    if (existing !== undefined) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.slots.delete(key)
      try { this.onExpire?.(existing?.pending ?? { sessionId }, chatId, botId) } catch { /* 通知不得抛 */ }
    }, this.timeoutMs)
    timer.unref?.()
    this.slots.set(key, { pending: { sessionId }, timer })
  }

  /** The chat's pending rename, or undefined. */
  active(chatId: number, botId: string): RenamePending | undefined {
    return this.slots.get(RenamePendingStore.key(chatId, botId))?.pending
  }

  /** Clear the chat's pending (answered or cancelled). */
  clear(chatId: number, botId: string): void {
    const key = RenamePendingStore.key(chatId, botId)
    const existing = this.slots.get(key)
    if (existing !== undefined) {
      clearTimeout(existing.timer)
      this.slots.delete(key)
    }
  }

  /** Drop every slot (plugin unload). */
  clearAll(): void {
    for (const { timer } of this.slots.values()) clearTimeout(timer)
    this.slots.clear()
  }
}
