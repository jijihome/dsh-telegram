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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** JSON-backed persistence for chat↔session bindings and poll offsets. */
export class StateStore {
    file;
    chatStates = {};
    offsets = {};
    dirty = false;
    constructor(options) {
        this.file = join(options.dataDir, 'state.json');
        this.load();
    }
    load() {
        try {
            const raw = readFileSync(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.chats !== undefined)
                Object.assign(this.chatStates, parsed.chats);
            if (parsed.offsets !== undefined)
                Object.assign(this.offsets, parsed.offsets);
        }
        catch {
            // Fresh install or corrupt file: start empty.
        }
    }
    /** Set (or replace) a chat's binding. */
    setChat(key, state) {
        this.chatStates[key] = state;
        this.dirty = true;
    }
    /** Remove a chat's binding. */
    removeChat(key) {
        delete this.chatStates[key];
        this.dirty = true;
    }
    /** Read a chat binding; undefined for new chats. */
    getChat(key) {
        return this.chatStates[key];
    }
    /** All persisted bindings. */
    allChats() {
        return { ...this.chatStates };
    }
    /** Remember a bot's last acknowledged update offset. */
    setOffset(botId, offset) {
        this.offsets[botId] = offset;
        this.dirty = true;
    }
    /** Last acknowledged offset for a bot; undefined = resume from newest. */
    getOffset(botId) {
        return this.offsets[botId];
    }
    /** Persist to disk if dirty (debounced by the caller for hot loops). */
    flush() {
        if (!this.dirty)
            return;
        this.dirty = false;
        const payload = { chats: this.chatStates, offsets: this.offsets };
        const dir = dirname(this.file);
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch {
            /* best effort */
        }
        const tmp = this.file + '.tmp';
        try {
            writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            try {
                renameSync(tmp, this.file);
            }
            catch {
                // Windows: rename over existing file may fail; remove then rename.
                rmSync(this.file, { force: true });
                renameSync(tmp, this.file);
            }
        }
        catch (error) {
            // Never let persistence failures break the bot loop.
            console.error('[dsh-telegram] state flush failed:', error);
        }
    }
}
