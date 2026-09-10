/**
 * Command system: slash commands handled locally (never sent to the model).
 * Mirrors @loserfox/telegram's command set, extended with /stop (cancel the
 * running turn), /workspace (browse & switch working directories), and
 * /session (inspect the chat↔session binding).
 *
 * @module commands
 */
import type { Delivery } from '../telegram/delivery.js';
import type { SessionManager } from '../core/session-manager.js';
import type { StateStore } from '../core/state-store.js';
import type { TelegramInlineKeyboard } from '../telegram/api.js';
export interface CommandContext {
    chatId: number;
    botId: string;
    /** Telegram user id of the sender (for per-user workspace roots later). */
    userId: number;
    delivery: Delivery;
    sessions: SessionManager;
    store: StateStore;
    workspaceRoots: string[];
    defaultCwd: string;
}
export interface CommandResult {
    handled: boolean;
    /** Command-specific reply text when the command is handled. */
    reply?: string;
    /** Inline keyboard to attach to the reply (sent via the menu delivery path). */
    keyboard?: TelegramInlineKeyboard;
}
/** Detect a command at the start of a message; returns the bare command name. */
export declare function isCommand(text: string): string | undefined;
/**
 * Handle a slash command. Returns `{ handled: false }` when `text` is not a
 * command (or an unknown command, whose unknownness is reported in reply).
 */
export declare function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult>;
/** Display name of a workspace root for listing. */
export declare function displayRoot(root: string): string;
