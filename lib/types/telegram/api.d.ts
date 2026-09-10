/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes, `editMessageText`,
 * `sendChatAction`, and `getMe`.
 *
 * Based on @loserfox/telegram's client.ts (BSD-3-Clause), extended with
 * `editMessageText` for incremental streaming updates.
 * The token is embedded in the request URL, so every error path redacts it.
 *
 * @module telegram/api
 */
/** Telegram user object (sender of a message). */
export interface TelegramUser {
    readonly id: number;
    readonly first_name?: string;
    readonly username?: string;
    readonly is_bot?: boolean;
}
/** Telegram chat object (private chat, group, or channel). */
export interface TelegramChat {
    readonly id: number;
    readonly type: string;
    readonly title?: string;
    readonly username?: string;
    readonly first_name?: string;
}
/** Telegram message object; only the text-relevant fields are modeled. */
export interface TelegramMessage {
    readonly message_id: number;
    readonly chat: TelegramChat;
    readonly from?: TelegramUser;
    readonly text?: string;
    readonly date: number;
}
/** Telegram update envelope; only message updates are modeled. */
export interface TelegramUpdate {
    readonly update_id: number;
    readonly message?: TelegramMessage;
    readonly callback_query?: TelegramCallbackQuery;
}
/** Inline keyboard button (menu). */
export interface TelegramInlineButton {
    readonly text: string;
    readonly callback_data?: string;
}
/** Inline keyboard (rows of buttons) attached to a message. */
export interface TelegramInlineKeyboard {
    readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[];
}
/** A callback_query update (a menu button was pressed). */
export interface TelegramCallbackQuery {
    readonly id: string;
    readonly from?: TelegramUser;
    readonly message?: TelegramMessage;
    readonly data?: string;
}
/** A bot command advertised by `setMyCommands`. */
export interface BotCommand {
    readonly command: string;
    readonly description: string;
}
/**
 * Scope of a `setMyCommands` call. Only the default scope (all private chats)
 * is modeled, which is what this plugin registers.
 */
export interface BotCommandScopeDefault {
    readonly type: 'default';
}
/** Telegram `MenuButton` — this plugin only ads the command-list toggle. */
export type MenuButton = {
    readonly type: 'commands';
};
/** Runtime seam surface tests substitute with a fake. */
export interface TelegramClientLike {
    /** Fetch the bot identity; validates the token. */
    getMe(): Promise<TelegramUser>;
    /** Long-poll for updates at or after `offset`. */
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    /** Send a message, optionally with HTML parse mode and an inline keyboard. */
    sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: TelegramInlineKeyboard): Promise<TelegramMessage>;
    /** Replace the text of a previously sent message (incremental streaming). */
    editMessageText(chatId: number, messageId: number, text: string, parseMode?: 'HTML'): Promise<TelegramMessage>;
    /** Acknowledge a callback_query; optionally show a toast. */
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    /** Send a chat action such as `typing`. */
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    /** Register the command list shown in the bot's menu (`setMyCommands`). */
    setMyCommands(commands: readonly BotCommand[], scope: BotCommandScopeDefault): Promise<boolean>;
    /** Set the bot's input-field menu button (`setChatMenuButton`). */
    setChatMenuButton(button: MenuButton): Promise<boolean>;
}
/** Options for {@link TelegramClient}. */
export interface TelegramClientOptions {
    /** HTTP client seam; production uses the global `fetch`. */
    fetch?: typeof fetch;
    /** API base URL; production uses the public Bot API. */
    baseUrl?: string;
    /** Long-polling timeout in seconds; production default is 30. */
    pollingTimeoutSec?: number;
    /**
     * HTTP/HTTPS proxy URL (for example `http://127.0.0.1:7897`). When set, all
     * Telegram traffic is routed through the proxy via an undici `ProxyAgent`.
     * Only this client's requests go through the proxy — the host process's other
     * network calls are untouched. Prefer `TELEGRAM_PROXY`/`HTTPS_PROXY` env vars.
     */
    proxy?: string;
}
/**
 * Thrown when the Bot API request fails before a response is received
 * (DNS, TCP, TLS, proxy, timeout). Distinct from an HTTP/API error such
 * as `401 Unauthorized`, so callers can tell "network problem" from
 * "bad token".
 */
export declare class TelegramTransportError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export declare class TelegramClient implements TelegramClientLike {
    private readonly token;
    private readonly fetchImpl;
    private readonly baseUrl;
    private readonly proxyAgent?;
    /** Long-polling timeout in seconds; controls each getUpdates call. */
    readonly pollingTimeoutSec: number;
    /**
     * @param token - bot token from @BotFather.
     * @param options - client options.
     */
    constructor(token: string, options?: TelegramClientOptions);
    /** Dispose the proxy connection pool, if one was created. */
    close(): void;
    private url;
    /** POST `method` with `body`; throws on transport failure or a non-ok response. */
    private call;
    /**
     * Fetch the bot identity; fails when the token is invalid.
     * @returns the bot user object.
     */
    getMe(): Promise<TelegramUser>;
    /**
     * Long-poll for message updates. Pass the previous update id plus one to
     * acknowledge already-seen updates; `undefined` starts from the newest.
     * @param offset - the update id to start from.
     * @returns the batch of updates received within the polling timeout.
     */
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    /**
     * Send a text message, optionally with HTML parse mode and an inline keyboard.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @param replyMarkup - inline keyboard to attach (for menu navigation).
     * @returns the delivered message object.
     */
    sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: TelegramInlineKeyboard): Promise<TelegramMessage>;
    /**
     * Replace the text of a previously sent message. Used to stream incremental
     * model output into one growing message instead of spamming new ones.
     * @param chatId - target chat id.
     * @param messageId - the message to edit (from a prior sendMessage).
     * @param text - the new full text (Telegram HTML or plain).
     * @param parseMode - `HTML` when `text` is Telegram-HTML, else plain text.
     * @returns the edited message object.
     */
    editMessageText(chatId: number, messageId: number, text: string, parseMode?: 'HTML'): Promise<TelegramMessage>;
    /**
     * Acknowledge a callback_query (menu button press) so Telegram stops the
     * loading spinner; optionally show a short toast.
     * @param callbackQueryId - the callback query id.
     * @param text - optional toast text (shown briefly near the button).
     */
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    /**
     * Send a chat action such as `typing`; Telegram shows it briefly while a
     * real message is on the way.
     * @param chatId - target chat id.
     * @param action - the action name (for example `typing`).
     * @returns whether the action was accepted.
     */
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    /**
     * Register the command list advertised in the bot's `/` menu.
     * @param commands - the commands to advertise.
     * @param scope - the scope to register for (default scope covers all private chats).
     * @returns whether the registration was accepted.
     */
    setMyCommands(commands: readonly BotCommand[], scope: BotCommandScopeDefault): Promise<boolean>;
    /**
     * Set the bot's input-field menu button.
     * @param button - the menu-button config (this plugin uses the command-list toggle).
     * @returns whether the registration was accepted.
     */
    setChatMenuButton(button: MenuButton): Promise<boolean>;
}
