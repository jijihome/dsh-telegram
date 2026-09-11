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
    sessionId: string;
}
export interface RenamePendingStoreOptions {
    /** How long the chat stays in rename mode (default 120_000 ms). */
    timeoutMs?: number;
    /** Called with the pending when it expires (notify the user). */
    onExpire?: (pending: RenamePending, chatId: number, botId: string) => void;
}
/** Per-(bot, chat) rename-in-progress slots with timeout. */
export declare class RenamePendingStore {
    private readonly timeoutMs;
    private readonly onExpire;
    private readonly slots;
    constructor(options?: RenamePendingStoreOptions);
    private static key;
    /** Register (or replace) the rename target for one chat. */
    begin(chatId: number, botId: string, sessionId: string): void;
    /** The chat's pending rename, or undefined. */
    active(chatId: number, botId: string): RenamePending | undefined;
    /** Clear the chat's pending (answered or cancelled). */
    clear(chatId: number, botId: string): void;
    /** Drop every slot (plugin unload). */
    clearAll(): void;
}
