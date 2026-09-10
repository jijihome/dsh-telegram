/**
 * Bot manager: owns the set of bots, each with an independent long-poll
 * connection, delivery, and failure isolation. One bot failing (bad token,
 * network outage, API error) logs and stops only itself; the others keep
 * polling. On poll errors the LongPoll backoff reconnects automatically.
 *
 * Multi-bot isolation: every decision (authorization, proxy, forward log path,
 * workspace roots, persistence file, offset cursor) is read from the bot's own
 * `BotScope`, never from shared plugin state. The update handler receives its
 * runtime explicitly, so no lookup can ever resolve to another bot's client
 * (the previous `runtimes.get(bot.id)` path could reply through the wrong token
 * when two bots shared an id).
 *
 * Structure follows @loserfox/telegram's bridge/apply split (BSD-3-Clause),
 * generalized to N isolated bots and wired to the session manager + commands.
 *
 * @module telegram/bot-manager
 */
import type { BotConfig } from '../config.js';
import type { BotScope } from '../core/bot-scope.js';
import { TelegramClient } from './api.js';
import { LongPoll } from './long-poll.js';
import { Delivery } from './delivery.js';
import type { SessionManager } from '../core/session-manager.js';
import { type MenuCtx } from './menu.js';
export interface BotManagerOptions {
    /** One resolved isolation scope per configured bot. */
    scopes: readonly BotScope[];
    sessions: SessionManager;
    pollingTimeoutSec: number;
    maxMessageLength: number;
    defaultCwd: string;
    /** Build a MenuCtx for one (chat, bot) pair (injected from the plugin entry). */
    menuCtxFor?: (chatId: number, botId: string) => MenuCtx;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
export interface BotRuntime {
    scope: BotScope;
    client: TelegramClient;
    delivery: Delivery;
    poll: LongPoll;
    /** Set when the bot could not be started (bad token etc). */
    lastError?: string;
}
/** Normalized bot list: either `bots[]` entries or the single bare `token`. */
export declare function normalizeBots(bots: BotConfig[], token?: string): BotConfig[];
/** Starts, supervises, and stops all bots. */
export declare class BotManager {
    private readonly options;
    private readonly runtimes;
    private started;
    constructor(options: BotManagerOptions);
    /** Ready-to-use runtimes (only successfully started bots), keyed by bot id. */
    get all(): Map<string, BotRuntime>;
    /** Start every bot; a per-bot startup failure is isolated and recorded. */
    start(): void;
    /** Stop every bot (plugin unload / dispose). */
    stop(): Promise<void>;
    /** Launch one bot: client + delivery + poll, verify token async, wire updates. */
    private launch;
    /** Route one Telegram update: authorize, then command or agent follow-up. */
    private handleUpdate;
    /** Whitelist or allow-all check for one bot. */
    private isAllowed;
    /** Handle a callback_query (menu button press). */
    private handleCallback;
}
