/**
 * dsh-telegram deployment config. 极简:只配置一个或多个 Bot Token 即可运行。
 * @module telegram/config
 */
import Schema from '@deepseek-ai/schemastery';
/** One bot instance: independent token, long-poll connection, failure isolation. */
export interface BotConfig {
    /** Stable short id used in logs/session ids; defaults to 'bot'. */
    id: string;
    /** Bot token from @BotFather. */
    token: string;
    /**
     * Per-bot session binding: chatId → existing DSH session, so this bot's chat
     * participates in that conversation bidirectionally. The chat id is keyed
     * directly under the bot (no `botId:chatId` prefix needed).
     */
    bindings?: Record<string, string>;
}
/** dsh-telegram plugin config. */
export interface TelegramConfig {
    /** One or more bots; each gets an independent long-poll connection. */
    bots: BotConfig[];
    /** Fallback: accept a single bare token (becomes one bot with id 'bot'). */
    token?: string;
    /** Telegram user ids allowed to talk to the bots; empty means none unless `allowAllUsers`. */
    allowedUserIds?: number[];
    /** Allow any Telegram user (development only). */
    allowAllUsers?: boolean;
    /** LLM provider id passed to each created agent. */
    provider?: string;
    /** Model id passed to each created agent. */
    model?: string;
    /** Per-chunk message length limit (Telegram caps at 4096). */
    maxMessageLength?: number;
    /** Long-polling timeout in seconds. */
    pollingTimeoutSec?: number;
    /** Base working directory roots for /workspace browsing. Defaults to process.cwd(). */
    workspaceRoots?: string[];
    /** Directory for persistent state (chat↔session map, offsets). Default: <cwd>/data. */
    dataDir?: string;
    /**
     * HTTP/HTTPS proxy for Telegram traffic (for example `http://127.0.0.1:7897`).
     * Falls back to `TELEGRAM_PROXY`/`HTTPS_PROXY` env vars when omitted. Only
     * Telegram requests use it; other host network calls are untouched.
     */
    proxy?: string;
    /** Keep the host process alive for long-polling daemon operation. */
    keepAlive?: boolean;
    /**
     * Session binding: map a Telegram chat to an existing DSH session so the
     * bot participates in that conversation bidirectionally. Keys are either
     * `botId:chatId` (exact) or a bare `chatId` (any bot); values are DSH
     * session ids (e.g. `session-<uuid>` for a web GUI conversation).
     */
    bindings?: Record<string, string>;
}
export declare const Config: Schema<TelegramConfig>;
