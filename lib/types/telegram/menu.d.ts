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
    getCurrentModel(): {
        provider: string;
        model: string;
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
    listWorkspaces(): Promise<string[]>;
    listSessions(): Promise<Array<{
        id: string;
        cwd?: string;
        title?: string;
    }>>;
}
/** Result of handling one menu callback: text + optional follow-up keyboard. */
export interface MenuResult {
    text: string;
    keyboard?: TelegramInlineKeyboard;
}
/** Main menu keyboard. */
export declare function mainMenuText(): string;
/** Main menu keyboard (rows). */
export declare function mainMenuKeyboard(): TelegramInlineKeyboard;
/** Handle one callback `data`. Returns the text + keyboard to send/show. */
export declare function handleMenuCallback(data: string, ctx: MenuCtx): Promise<MenuResult>;
