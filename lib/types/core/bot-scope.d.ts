/**
 * Bot scope: the per-bot isolation domain.
 *
 * Every capability a bot uses (authorization, model defaults, workspace roots,
 * proxy, persistence directory, host-session visibility, ops rights) is resolved
 * into one immutable `BotScope`. Nothing downstream reads plugin-level config
 * directly, so a bot can never inherit another bot's policy by accident.
 *
 * Validation is fail-loud: duplicate ids, duplicate tokens, malformed ids and
 * ambiguous bare-chat bindings abort plugin activation with an actionable error
 * instead of silently merging two bots into one runtime.
 *
 * @module core/bot-scope
 */
import type { BotConfig, TelegramConfig } from '../config.js';
/** One resolved, isolated bot tenant. */
export interface BotScope {
    /** Unique bot id (matches `/^[A-Za-z0-9._-]+$/`, so `botId:chatId` stays unambiguous). */
    botId: string;
    /** Telegram bot token. */
    token: string;
    /** chatId → existing DSH session id, declared for this bot only. */
    bindings: Record<string, string>;
    /** Telegram user ids allowed to talk to this bot. */
    allowedUserIds: number[];
    /** Allow any user for this bot (development only). */
    allowAllUsers: boolean;
    /** Default LLM provider for this bot's agents. */
    provider: string;
    /** Default model for this bot's agents. */
    model: string;
    /**
     * True when this bot (or the plugin config) pins an explicit provider/model.
     * When false the route follows the host default model at request time
     * (read-only, never written), so a bot continues the conversation on the same
     * model the GUI uses instead of a hardcoded plugin default.
     */
    modelPinned: boolean;
    /** Working directory roots this bot may browse. */
    workspaceRoots: string[];
    /** Proxy used for this bot's Telegram traffic, if any. */
    proxy?: string;
    /** Root persistence directory; this bot's files live under `<dataDir>/bots/<botId>/`. */
    dataDir: string;
    /** May this bot enumerate/attach host-wide DSH sessions and workspaces? */
    allowHostSessions: boolean;
    /** May this bot restart the shared host DSH process (stops every bot)? */
    allowOpsRestart: boolean;
    /** May this bot bind a DSH session already bound by another bot? */
    allowSharedSessions: boolean;
}
/** Build the canonical isolation key for one chat inside one bot. */
export declare function routeKey(botId: string, chatId: number): string;
/**
 * Resolve every configured bot into an isolated scope.
 *
 * @param bots - normalized bot list (`bots[]` or the single-token fallback).
 * @param config - plugin-level config supplying defaults for unset bot fields.
 * @param defaultCwd - host process cwd; the last-resort workspace root.
 * @param envProxy - proxy inherited from the environment (`TELEGRAM_PROXY` /
 *   `HTTPS_PROXY`), used when neither the bot nor the plugin config sets one.
 *   Without it a deployment that only relied on the machine-wide proxy variable
 *   would talk to Telegram directly and time out.
 * @throws when the bot set cannot be isolated (duplicate id/token, bad id, no bots).
 */
export declare function resolveBotScopes(bots: BotConfig[], config: TelegramConfig, defaultCwd: string, envProxy?: string): BotScope[];
/** Default state root: `<DSH_HOME>/plugin-data/dsh-telegram`. */
export declare function joinDefaultDataDir(defaultCwd: string): string;
/**
 * Validate cross-bot session ownership before any bind is registered.
 *
 * A DSH session may be driven by exactly one bot route. Binding the same session
 * to two bots would fan every delta of that conversation into both of them —
 * the classic 串台 — so it is refused unless every involved bot explicitly opts
 * in with `allowSharedSessions: true`.
 *
 * @throws when a session would be shared by two bots without opt-in.
 */
export declare function assertSessionOwnership(scopes: readonly BotScope[]): void;
