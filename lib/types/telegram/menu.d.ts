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
    /**
     * Switch this chat's working directory, releasing its current session so the
     * next message asks the user to create/choose one in the new directory.
     * Selection of the same directory is a no-op. Returns whether a session was
     * actually detached.
     */
    switchCwd(cwd: string): Promise<boolean>;
    /** Persist this chat's working directory (merge + flush) without detaching. */
    setCurrentCwd(cwd: string): void;
    /** Return a host-process snapshot for the ops info panel. */
    getHostInfo(): string;
    /** Schedule a host dsh restart; returns a user-facing confirmation text. */
    restartDsh(): string;
    /**
     * 新建会话向导的草稿（每个 chat 一份）：各步选中的模型/工作方式先记在这里，
     * 最后一步落盘再创建会话。向导期间跨多次 callback，必须有共享状态。
     */
    draft: {
        read(): {
            provider?: string;
            model?: string;
            presetId?: string;
        };
        patch(next: {
            provider?: string;
            model?: string;
            presetId?: string;
        }): void;
        reset(): void;
    };
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
 * Build the session-selection menu for a chat: the sessions THAT BELONG TO the
 * chat's current working directory (time + title rows), scoped to that
 * directory, PLUS an always-visible 「🆕 新建会话」 button.
 *
 * This is what an ordinary message triggers when the chat has no active
 * session (e.g. right after a workspace switch): ask the user to create a new
 * session or pick an existing one in the current directory rather than
 * silently auto-creating or resuming.
 *
 * The directory is the boundary of the list: a session from another directory
 * is never shown here. When the chat's active session lives in another
 * directory the header says so instead of inventing a row for it.
 */
export declare function sessionChoiceMenu(ctx: MenuCtx): Promise<MenuResult>;
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
