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
import { ProxyAgent, fetch as undiciFetch } from 'undici';
/** Replace the token with a placeholder in an error text. */
function redactToken(text, token) {
    return text.split(token).join('***');
}
/**
 * Flatten an error and its `cause` chain into one string (max 6 hops).
 * Node's fetch (undici) only ever throws a generic `TypeError: fetch
 * failed` and keeps the real reason (DNS / TCP / TLS / proxy / timeout)
 * in `cause`; without unwrapping it the log says nothing diagnosable.
 * Every level is redacted so the token never leaks.
 */
function redactedMessage(error, token) {
    const parts = [];
    let current = error;
    for (let depth = 0; current != null && depth < 6; depth++) {
        const text = current instanceof Error ? current.message : String(current);
        parts.push(redactToken(text, token));
        current = current instanceof Error ? current.cause : undefined;
    }
    return parts.join('; cause: ');
}
/**
 * Thrown when the Bot API request fails before a response is received
 * (DNS, TCP, TLS, proxy, timeout). Distinct from an HTTP/API error such
 * as `401 Unauthorized`, so callers can tell "network problem" from
 * "bad token".
 */
export class TelegramTransportError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'TelegramTransportError';
    }
}
/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export class TelegramClient {
    token;
    fetchImpl;
    baseUrl;
    proxyAgent;
    /** Long-polling timeout in seconds; controls each getUpdates call. */
    pollingTimeoutSec;
    /**
     * @param token - bot token from @BotFather.
     * @param options - client options.
     */
    constructor(token, options = {}) {
        if (token === '')
            throw new Error('telegram client: token must not be empty');
        this.token = token;
        this.proxyAgent = options.proxy ? new ProxyAgent(options.proxy) : undefined;
        // When a proxy is set, use undici's own `fetch` with the same-version
        // `ProxyAgent` as the dispatcher. The Node global fetch rejects a ProxyAgent
        // from a mismatched undici/undici-types version (`invalid onRequestStart
        // method`), so we must not pass the dispatcher to `globalThis.fetch`.
        if (this.proxyAgent !== undefined) {
            const proxyFetch = (input, init) => undiciFetch(input, { ...(init ?? {}), dispatcher: this.proxyAgent });
            this.fetchImpl = proxyFetch;
        }
        else {
            this.fetchImpl = options.fetch ?? globalThis.fetch;
        }
        this.baseUrl = options.baseUrl ?? 'https://api.telegram.org';
        this.pollingTimeoutSec = options.pollingTimeoutSec ?? 30;
    }
    /** Dispose the proxy connection pool, if one was created. */
    close() {
        void this.proxyAgent?.close();
    }
    url(method) {
        return `${this.baseUrl}/bot${this.token}/${method}`;
    }
    /** POST `method` with `body`; throws on transport failure or a non-ok response. */
    async call(method, body) {
        let response;
        try {
            response = await this.fetchImpl(this.url(method), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        catch (error) {
            throw new TelegramTransportError(`telegram ${method} transport error: ${redactedMessage(error, this.token)}`, { cause: error });
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok !== true) {
            const description = payload?.description ?? `HTTP ${response.status}`;
            throw new Error(`telegram ${method} failed: ${redactToken(description, this.token)}`);
        }
        return payload.result;
    }
    /**
     * Fetch the bot identity; fails when the token is invalid.
     * @returns the bot user object.
     */
    getMe() {
        return this.call('getMe', {});
    }
    /**
     * Long-poll for message updates. Pass the previous update id plus one to
     * acknowledge already-seen updates; `undefined` starts from the newest.
     * @param offset - the update id to start from.
     * @returns the batch of updates received within the polling timeout.
     */
    getUpdates(offset) {
        const body = {
            timeout: this.pollingTimeoutSec,
            allowed_updates: ['message', 'callback_query'],
        };
        if (offset !== undefined)
            body.offset = offset;
        return this.call('getUpdates', body);
    }
    /**
     * Send a text message, optionally with HTML parse mode and an inline keyboard.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @param replyMarkup - inline keyboard to attach (for menu navigation).
     * @returns the delivered message object.
     */
    sendMessage(chatId, text, parseMode, replyMarkup) {
        const body = { chat_id: chatId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        if (replyMarkup !== undefined)
            body.reply_markup = replyMarkup;
        return this.call('sendMessage', body);
    }
    /**
     * Replace the text of a previously sent message. Used to stream incremental
     * model output into one growing message instead of spamming new ones.
     * @param chatId - target chat id.
     * @param messageId - the message to edit (from a prior sendMessage).
     * @param text - the new full text (Telegram HTML or plain).
     * @param parseMode - `HTML` when `text` is Telegram-HTML, else plain text.
     * @returns the edited message object.
     */
    editMessageText(chatId, messageId, text, parseMode) {
        const body = { chat_id: chatId, message_id: messageId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        return this.call('editMessageText', body);
    }
    /**
     * Acknowledge a callback_query (menu button press) so Telegram stops the
     * loading spinner; optionally show a short toast.
     * @param callbackQueryId - the callback query id.
     * @param text - optional toast text (shown briefly near the button).
     */
    answerCallbackQuery(callbackQueryId, text) {
        const body = { callback_query_id: callbackQueryId };
        if (text !== undefined)
            body.text = text;
        return this.call('answerCallbackQuery', body);
    }
    /**
     * Send a chat action such as `typing`; Telegram shows it briefly while a
     * real message is on the way.
     * @param chatId - target chat id.
     * @param action - the action name (for example `typing`).
     * @returns whether the action was accepted.
     */
    sendChatAction(chatId, action) {
        return this.call('sendChatAction', { chat_id: chatId, action });
    }
}
