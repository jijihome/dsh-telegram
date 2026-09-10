/**
 * Menu module: Telegram inline-keyboard menus for chat controls. A menu button
 * press emits a `callback_query` whose `data` encodes the action; that action
 * either shows a submenu (with a back button) or performs a chat operation.
 *
 * @module telegram/menu
 */
import type { Delivery } from './delivery.js';
import type { SessionManager } from '../core/session-manager.js';
import type { StateStore } from '../core/state-store.js';
import type { TelegramInlineKeyboard } from './api.js';
/** Capabilities a menu action needs (injected from the plugin entry point). */
export interface MenuCtx {
    chatId: number;
    botId: string;
    delivery: Delivery;
    sessions: SessionManager;
    store: StateStore;
    workspaceRoots: string[];
    defaultCwd: string;
    provider: string;
    model: string;
    /** The Telegram user id pressing the button (for ops authorization). */
    userId: number;
    /** Whether the current user is allowed to run ops (restart dsh). */
    canOperate: boolean;
    getCurrentModel(): {
        provider: string;
        model: string;
    };
    /**
     * Effective model plus its source (`chat` / `session` / `host` / `bot`), so the
     * status panel can show that the model is inherited from the current session.
     */
    getModelInfo?(): {
        provider: string;
        model: string;
        source: 'chat' | 'session' | 'host' | 'bot';
    };
    listModels(): Promise<Array<{
        provider: string;
        model: string;
    }>>;
    setModel(provider: string, model: string): Promise<void>;
    listPresets(): Promise<Array<{
        id: string;
        name: string;
    }>>;
    setPreset(id: string): Promise<void>;
    /** Display name of the current work mode (selected preset, or the default). */
    getCurrentPresetName(): Promise<string>;
    /** Current work-mode preset id (per-chat selection, else the default). */
    getCurrentPresetId(): Promise<string>;
    listWorkspaces(): Promise<string[]>;
    listSessions(): Promise<Array<{
        id: string;
        cwd?: string;
        title?: string;
        displayTitle?: string;
        updatedAt?: number;
    }>>;
    /** Switch this chat to an existing DSH session (bind + persist). */
    switchSession(sessionId: string, cwd?: string): Promise<void>;
    /** This chat's currently selected working directory (persisted cwd or default). */
    currentCwd(): string;
    /** Persist this chat's working directory (merge + flush). */
    setCurrentCwd(cwd: string): void;
    /** Return a host-process snapshot for the ops info panel. */
    getHostInfo(): string;
    /** Schedule a host dsh restart; returns a user-facing confirmation text. */
    restartDsh(): string;
}
/** Result of handling one menu callback: text + optional follow-up keyboard. */
export interface MenuResult {
    text: string;
    keyboard?: TelegramInlineKeyboard;
}
/** Main menu text: status summary (when ctx is given), no menu-title banner. */
export declare function mainMenuText(ctx?: MenuCtx): Promise<string>;
/** Main menu keyboard (rows). */
export declare function mainMenuKeyboard(): TelegramInlineKeyboard;
/** Handle one callback `data`. Returns the text + keyboard to send/show. */
export declare function handleMenuCallback(data: string, ctx: MenuCtx): Promise<MenuResult>;
/**
 * Scope a roster to one working directory (newest first) and report whether the
 * chat's active session is part of that scope.
 *
 * Path comparison is separator/case-insensitive: the roster and the workspace
 * picker do not always spell the same directory the same way.
 */
export declare function scopeSessionsToDir<T extends {
    id: string;
    cwd?: string;
    updatedAt?: number;
}>(list: readonly T[], currentCwd: string, activeSessionId: string | undefined): {
    scoped: T[];
    activeInScope: boolean;
};
