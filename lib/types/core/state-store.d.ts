/**
 * State store: persists the chat↔session mapping, per-chat cwd, and the
 * long-poll offset cursor for every bot as JSON under `<dataDir>/state.json`.
 * Survives a DSH restart so chat bindings and delivery offsets recover.
 *
 * Writes are debounced/atomic-ish: JSON.stringify then rename (windows
 * guard: write to a temp file and replace). In-memory map is the source of
 * truth while running.
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
}
export interface StateStoreOptions {
    /** Directory where state.json lives (default `<cwd>/data`). */
    dataDir: string;
}
/** JSON-backed persistence for chat↔session bindings and poll offsets. */
export declare class StateStore {
    private readonly file;
    private readonly chatStates;
    private readonly offsets;
    private dirty;
    constructor(options: StateStoreOptions);
    private load;
    /** Set (or replace) a chat's binding. */
    setChat(key: string, state: ChatState): void;
    /** Remove a chat's binding. */
    removeChat(key: string): void;
    /** Read a chat binding; undefined for new chats. */
    getChat(key: string): ChatState | undefined;
    /** All persisted bindings. */
    allChats(): Record<string, ChatState>;
    /** Remember a bot's last acknowledged update offset. */
    setOffset(botId: string, offset: number | undefined): void;
    /** Last acknowledged offset for a bot; undefined = resume from newest. */
    getOffset(botId: string): number | undefined;
    /** Persist to disk if dirty (debounced by the caller for hot loops). */
    flush(): void;
}
