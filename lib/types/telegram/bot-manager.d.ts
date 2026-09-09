/**
 * Bot manager: owns the set of bots, each with an independent long-poll
 * connection, delivery, and failure isolation. One bot failing (bad token,
 * network outage, API error) logs and stops only itself; the others keep
 * polling. On poll errors the LongPoll backoff reconnects automatically.
 *
 * Structure follows @loserfox/telegram's bridge/apply split (BSD-3-Clause),
 * generalized to N bots and wired to the session manager + commands.
 *
 * @module telegram/bot-manager
 */
import type { BotConfig } from '../config.js';
import { TelegramClient } from './api.js';
import { LongPoll } from './long-poll.js';
import { Delivery } from './delivery.js';
import type { SessionManager } from '../core/session-manager.js';
import type { StateStore } from '../core/state-store.js';
export interface BotManagerOptions {
    bots: BotConfig[];
    /** Telegram user ids allowed to talk; empty = none unless allowAllUsers. */
    allowedUserIds: number[];
    /** Allow any user (dev only). */
    allowAllUsers: boolean;
    sessions: SessionManager;
    store: StateStore;
    pollingTimeoutSec: number;
    maxMessageLength: number;
    workspaceRoots: string[];
    defaultCwd: string;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
export interface BotRuntime {
    bot: BotConfig;
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
    /** Ready-to-use runtimes (only successfully started bots). */
    get all(): Map<string, BotRuntime>;
    /** Start every bot; a per-bot startup failure is isolated and recorded. */
    start(): void;
    /** Stop every bot (plugin unload / dispose). */
    stop(): Promise<void>;
    /** Launch one bot: client + delivery + poll, verify token async, wire updates. */
    private launch;
    /** Route one Telegram update: authorize, then command or agent follow-up. */
    private handleUpdate;
    /** Whitelist or allow-all check. */
    private isAllowed;
}
