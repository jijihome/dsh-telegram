/**
 * Bot UI registration: the Telegram "command menu" (`setMyCommands`) and the
 * input-field menu button (`setChatMenuButton`) for one bot.
 *
 * Kept as a standalone module (no Cordis dependency) so it can be unit-tested
 * against a fake client and reused by every bot in a multi-bot deployment.
 * A registration failure is deliberately non-fatal: the bot still works via
 * `/menu` and typed commands, so we log and continue rather than abort startup.
 *
 * @module telegram/bot-commands
 */
import type { TelegramClientLike, BotCommand, MenuButton } from './api.js';
/**
 * The command list advertised to the bot's own menu (`/` in the input field),
 * plus `/menu`/`/start`. Shared by every telegram agent this plugin drives.
 */
export declare const BOT_COMMANDS: BotCommand[];
/** Default menu-button type. Telegram only supports a command list or web_app. */
export declare const DEFAULT_MENU_BUTTON: MenuButton;
/**
 * Register a bot's Telegram command menu (`setMyCommands`).
 * @param client - the bot's Telegram API client.
 * @param commands - commands to advertise; defaults to {@link BOT_COMMANDS}.
 */
export declare function registerBotCommands(client: TelegramClientLike, commands?: BotCommand[]): Promise<void>;
/**
 * Set the bot's input-field menu button (`setChatMenuButton`) to a command
 * list toggle, so Telegram shows a button beside the input field. This is the
 * closest Telegram offers to an always-visible menu entry (a real inline
 * keyboard can only be attached to a message).
 * @param client - the bot's Telegram API client.
 * @param button - the button config; defaults to `{ type: 'commands' }`.
 */
export declare function registerMenuButton(client: TelegramClientLike, button?: MenuButton): Promise<void>;
/**
 * Apply BOTH registrations for one bot: command menu then menu button. Runs
 * once per bot after `getMe` succeeds. Throws propagate to the caller, which
 * should log-and-continue (never abort bot startup on a UI-registration hiccup).
 * @param client - the bot's Telegram API client.
 */
export declare function registerBotUi(client: TelegramClientLike): Promise<void>;
