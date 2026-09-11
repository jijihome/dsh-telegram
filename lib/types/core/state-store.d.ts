/**
 * State store: persists the chat↔session mapping, per-chat cwd, and the
 * long-poll offset cursor for one bot as JSON.
 *
 * Multi-bot isolation: each bot owns a **separate file** under
 * `<dataDir>/bots/<botId>/state.json`. When a `botId` is supplied the store also
 * enforces a write/read guard — every key must be namespaced with that same
 * `botId` prefix, so a routing bug can never read or clobber another bot's chat
 * binding (it throws instead of silently crossing tenants).
 *
 * Writes are atomic-ish: JSON.stringify then rename (windows guard: write to a
 * temp file and replace). The in-memory map is the source of truth while running.
 *
 * @module core/state-store
 */
/** Persisted per-chat binding. */
export interface ChatState {
    /** DSH session id bound to this Telegram chat. */
    sessionId: string;
    /** Working directory the agent uses for this chat. */
    cwd: string;
    /** Bot id that owns this chat. */
    botId: string;
    /** Per-chat model override; falls back to the owning bot's default. */
    provider?: string;
    /** Per-chat model id override; falls back to the owning bot's default. */
    model?: string;
    /**
     * Session the model override was chosen on. The override applies only while
     * this chat still drives that session, so switching to another conversation
     * surfaces that conversation's own (inherited) model again.
     */
    modelSessionId?: string;
    /** Per-chat work-mode preset id (applied when a fresh session is created). */
    agentPreset?: string;
    /** True after a workspace switch detaches the previous conversation. */
    sessionDetached?: boolean;
}
export interface StateStoreOptions {
    /** Root directory holding the per-bot state (default `<cwd>/data`). */
    dataDir: string;
    /**
     * Owning bot id. When set, the store reads/writes only
     * `<dataDir>/bots/<botId>/state.json` and rejects any key that is not
     * namespaced with this bot's id.
     */
    botId?: string;
}
/** Path of one bot's state file (single source of truth for the layout). */
export declare function stateFilePath(dataDir: string, botId: string): string;
/** Root of one bot's private data (state + forward log). */
export declare function botDataDir(dataDir: string, botId: string): string;
/** JSON-backed persistence for chat↔session bindings and poll offsets. */
export declare class StateStore {
    private readonly file;
    private readonly botId;
    private readonly chatStates;
    private readonly offsets;
    private dirty;
    constructor(options: StateStoreOptions);
    /** Path of the backing file (diagnostics / migration). */
    get path(): string;
    private load;
    /**
     * Reject a key that is not namespaced with this store's bot.
     * @throws when a namespaced store is handed a foreign or unprefixed key.
     */
    private assertKey;
    /** Set (or replace) a chat's binding. */
    setChat(key: string, state: ChatState): void;
    /** Remove a chat's binding. */
    removeChat(key: string): void;
    /** Read a chat binding; undefined for new chats. */
    getChat(key: string): ChatState | undefined;
    /** All persisted bindings. */
    allChats(): Record<string, ChatState>;
    /**
     * Remember a bot's last acknowledged update offset.
     *
     * An `undefined` offset is IGNORED rather than stored: the periodic flush runs
     * from plugin start, while the bot's poll cursor is still unset until its first
     * `getUpdates` returns, and writing that `undefined` would erase the restored
     * cursor — Telegram would then re-deliver already-answered updates after the
     * next restart.
     */
    setOffset(botId: string, offset: number | undefined): void;
    /** Last acknowledged offset for a bot; undefined = resume from newest. */
    getOffset(botId: string): number | undefined;
    /** Persist to disk if dirty (debounced by the caller for hot loops). */
    flush(): void;
}
/** Outcome of an one-time legacy-state migration. */
export interface MigrationReport {
    /** Legacy `<dataDir>/state.json` path when it existed. */
    legacyFile?: string;
    /** Bot ids whose per-bot file was written. */
    migrated: string[];
    /** Chat keys dropped because their `botId:` prefix matches no configured bot. */
    orphans: string[];
    /** Where the legacy file was preserved (never deleted). */
    backup?: string;
}
/**
 * One-time migration from the shared legacy `state.json` into per-bot files.
 *
 * Rules (fail loud, never destructive):
 * - `botId:chatId` keys are routed to their bot's file; prefixes matching no
 *   configured bot are reported as orphans and skipped.
 * - bare `chatId` keys are unambiguous only with a single bot; with two or more
 *   bots the migration **aborts** so the operator assigns an owner explicitly.
 * - the legacy file is renamed to `state.json.migrated-<timestamp>` (a backup
 *   copy is written first); nothing is deleted.
 *
 * @throws when bare chat keys exist while multiple bots are configured.
 */
export declare function migrateLegacyState(dataDir: string, botIds: readonly string[], logger?: {
    warn(...args: unknown[]): void;
}): MigrationReport;
