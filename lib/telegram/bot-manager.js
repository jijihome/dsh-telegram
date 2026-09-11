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
import { join } from 'node:path';
import { botDataDir } from '../core/state-store.js';
import { TelegramClient, TelegramTransportError } from './api.js';
import { LongPoll } from './long-poll.js';
import { Delivery } from './delivery.js';
import { handleCommand } from '../commands/index.js';
import { handleMenuCallback, mainMenuKeyboard, mainMenuText, sessionChoiceMenu } from './menu.js';
import { registerBotUi } from './bot-commands.js';
/** Normalized bot list: either `bots[]` entries or the single bare `token`. */
export function normalizeBots(bots, token) {
    if (bots.length > 0)
        return bots;
    if (token !== undefined && token !== '')
        return [{ id: 'bot', token }];
    return [];
}
const messageOf = (error) => error instanceof Error ? error.message : String(error);
/** Starts, supervises, and stops all bots. */
export class BotManager {
    options;
    runtimes = new Map();
    /** Pending startup-network retries keyed by bot id (cleared on stop). */
    startupTimers = new Map();
    started = false;
    constructor(options) {
        this.options = options;
    }
    /** Ready-to-use runtimes (only successfully started bots), keyed by bot id. */
    get all() {
        return this.runtimes;
    }
    /** Start every bot; a per-bot startup failure is isolated and recorded. */
    start() {
        if (this.started)
            return;
        this.started = true;
        for (const scope of this.options.scopes) {
            try {
                const runtime = this.launch(scope);
                this.runtimes.set(scope.botId, runtime);
            }
            catch (error) {
                this.options.logger?.error(`[tg] bot "${scope.botId}" failed to start: ${messageOf(error)}`);
            }
        }
    }
    /** Stop every bot (plugin unload / dispose). */
    async stop() {
        this.started = false;
        // Cancel any pending startup-network retries so a late getMe cannot fire
        // after shutdown and start a bot the operator just stopped.
        for (const timer of this.startupTimers.values())
            clearTimeout(timer);
        this.startupTimers.clear();
        const polls = [...this.runtimes.values()].map(runtime => runtime.poll.stop());
        await Promise.allSettled(polls);
        // Dispose each client's proxy connection pool, if one was created.
        for (const runtime of this.runtimes.values()) {
            // 先停 typing 保活定时器, 否则插件卸载后仍会继续打 Telegram API。
            runtime.delivery.stopAllTyping();
            runtime.client.close();
        }
        this.runtimes.clear();
    }
    /** Launch one bot: client + delivery + poll, verify token async, wire updates. */
    launch(scope) {
        const logger = this.options.logger;
        const client = new TelegramClient(scope.token, {
            pollingTimeoutSec: this.options.pollingTimeoutSec,
            ...(scope.proxy !== undefined ? { proxy: scope.proxy } : {}),
        });
        // Each bot logs forward traffic into its own directory, so one bot's
        // conversation can never be read out of another bot's log file.
        const delivery = new Delivery({
            client,
            maxMessageLength: this.options.maxMessageLength,
            logger,
            forwardLogPath: join(botDataDir(scope.dataDir, scope.botId), 'forward.log'),
        });
        // The runtime is captured by the update handler, so a bot can only ever act
        // through its own client/delivery (no id-keyed reverse lookup).
        const runtime = { scope, client, delivery, poll: undefined };
        const poll = new LongPoll({
            client,
            onUpdate: update => void this.handleUpdate(runtime, update),
            onError: (error, attempt, delayMs) => {
                logger?.warn(`[tg] bot "${scope.botId}" poll error #${attempt} (retry ${delayMs}ms): ${messageOf(error)}`);
            },
        });
        runtime.poll = poll;
        // Startup token/network check. Only after it passes does the long-poll
        // start; a network/proxy timeout here must NOT leave the bot silently dead
        // (its getUpdates never runs, offset stalls, inbound messages pile up on the
        // Telegram server). So a transport failure is retried with backoff; only a
        // real token/API error (e.g. 401) is treated as permanent.
        void this.verifyAndStart(runtime, 0);
        return runtime;
    }
    /** getMe → (offset restore + poll.start + menu UI). Re-armed on transport failure. */
    async verifyAndStart(runtime, attempt) {
        const { scope, client, poll } = runtime;
        this.startupTimers.delete(scope.botId);
        try {
            const me = await client.getMe();
            const logger = this.options.logger;
            logger?.warn(`[tg] bot "${scope.botId}" online: @${me.username ?? me.id}`);
            // Restore the persisted offset after the token check passes.
            poll.restoreOffset(this.options.sessions.storeFor(scope.botId).getOffset(scope.botId));
            poll.start();
            // Register the command menu + menu button (non-fatal: log-and-continue).
            registerBotUi(client).catch(error => {
                logger?.warn(`[tg] bot "${scope.botId}" bot UI registration failed (non-fatal): ${messageOf(error)}`);
            });
        }
        catch (error) {
            runtime.lastError = messageOf(error);
            const transport = error instanceof TelegramTransportError;
            const label = transport ? 'startup network check failed' : 'token invalid';
            this.options.logger?.error(`[tg] bot "${scope.botId}" ${label} (attempt ${attempt + 1}): ${runtime.lastError}`);
            // Network/proxy trouble is transient — keep trying so the bot recovers on
            // its own instead of staying dead until a manual host restart. A hard
            // token error (401 etc) is not retried: it can never succeed until config
            // changes.
            if (transport && !this.started) {
                this.options.logger?.warn(`[tg] bot "${scope.botId}" startup deferred (plugin stopping)`);
                return;
            }
            if (transport && this.started) {
                // Backoff capped at 30s so a long outage does not hammer the API.
                const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
                this.options.logger?.warn(`[tg] bot "${scope.botId}" will retry startup in ${delay}ms`);
                this.startupTimers.set(scope.botId, setTimeout(() => {
                    void this.verifyAndStart(runtime, attempt + 1);
                }, delay));
            }
            else if (!transport) {
                // Permanent (token invalid) — nothing to do; the runtime stays marked
                // with lastError and is simply not polling.
            }
        }
    }
    /** Route one Telegram update: authorize, then command or agent follow-up. */
    async handleUpdate(runtime, update) {
        const { scope, delivery } = runtime;
        // Menu button press → run the menu action and show the result.
        const callbackQuery = update.callback_query;
        if (callbackQuery !== undefined) {
            await this.handleCallback(runtime, callbackQuery);
            return;
        }
        const message = update.message;
        if (message === undefined)
            return;
        const chatId = message.chat.id;
        // Authorization (this bot's own whitelist only). The denial names the id so
        // an operator can whitelist exactly the right account instead of guessing.
        const userId = message.from?.id ?? 0;
        if (!this.isAllowed(scope, userId)) {
            this.options.logger?.warn(`[tg] bot "${scope.botId}" 拒绝非白名单用户: user=${userId} chat=${chatId}`
                + ` (生效白名单=[${scope.allowedUserIds.join(',')}] allowAllUsers=${scope.allowAllUsers})`);
            await delivery.sendFinal(chatId, `⛔ 未授权的用户\n你的 Telegram user id: ${userId}\n(生效白名单: [${scope.allowedUserIds.join(',')}];allowAllUsers=${scope.allowAllUsers})`);
            return;
        }
        const text = message.text ?? '';
        // A pending interactive answer consumes a plain-text reply before commands.
        if (text.trim() !== '' && this.options.respond !== undefined) {
            try {
                if (await this.options.respond.onText(text, chatId, scope.botId))
                    return;
            }
            catch (error) {
                this.options.logger?.warn(`[tg] respond.onText failed: ${messageOf(error)}`);
            }
        }
        // /menu shows the inline keyboard menu with the status summary on top.
        if (/^\/(menu)$/.test(text.trim())) {
            const menuCtx = this.options.menuCtxFor?.(chatId, scope.botId);
            if (menuCtx !== undefined) {
                menuCtx.userId = userId;
                menuCtx.canOperate = this.isAllowed(scope, userId);
                await delivery.sendMenu(chatId, await mainMenuText(menuCtx), mainMenuKeyboard());
            }
            else {
                await delivery.sendMenu(chatId, await mainMenuText(), mainMenuKeyboard());
            }
            return;
        }
        // Commands are handled locally.
        const cmdCtx = {
            chatId,
            botId: scope.botId,
            userId: message.from?.id ?? 0,
            delivery,
            sessions: this.options.sessions,
            store: this.options.sessions.storeFor(scope.botId),
            workspaceRoots: scope.workspaceRoots,
            defaultCwd: this.options.defaultCwd,
        };
        const result = await handleCommand(text, cmdCtx);
        if (result.handled) {
            if (result.reply !== undefined) {
                if (result.keyboard !== undefined)
                    await delivery.sendMenu(chatId, result.reply, result.keyboard);
                else
                    await delivery.sendFinal(chatId, result.reply);
            }
            return;
        }
        if (text.trim() === '')
            return;
        // Otherwise: if the chat is bound to an existing session, follow up on it;
        // else decide based on whether it has ANY active session. A chat with a
        // session drives it; a chat with NO session (e.g. after a workspace switch
        // released its old one, or a brand-new chat) is shown the session-selection
        // menu with a New Session button instead of silently auto-creating — the
        // user chose the working directory, and must now pick or start the
        // conversation there.
        try {
            const bound = this.options.sessions.getBound(chatId, scope.botId);
            if (bound !== undefined) {
                this.options.logger?.warn(`[tg] bound msg chat=${chatId}(${scope.botId}) -> ${bound.sessionId}`);
                // 保活 typing: 从收到消息起就显示, 直到答复送达/回合结束。
                delivery.startTyping(chatId);
                void this.options.sessions.boundFollowup(chatId, scope.botId, text, error => {
                    void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`);
                });
                return;
            }
            const active = this.options.sessions.activeSessionId(chatId, scope.botId);
            if (active === undefined) {
                this.options.logger?.warn(`[tg] 无会话 msg chat=${chatId}(${scope.botId}); 发会话选择菜单`);
                const menuCtx = this.options.menuCtxFor?.(chatId, scope.botId);
                if (menuCtx !== undefined) {
                    menuCtx.userId = message.from?.id ?? 0;
                    menuCtx.canOperate = this.isAllowed(scope, menuCtx.userId);
                    const choice = await sessionChoiceMenu(menuCtx);
                    await delivery.sendMenu(chatId, choice.text, choice.keyboard);
                }
                else {
                    await delivery.sendMenu(chatId, await mainMenuText(), mainMenuKeyboard());
                }
                return;
            }
            this.options.logger?.warn(`[tg] unbound-but-session msg chat=${chatId}(${scope.botId}); 驱动会话 ${active}`);
            await this.options.sessions.getOrCreate(chatId, scope.botId);
            delivery.startTyping(chatId);
            this.options.sessions.followup(chatId, scope.botId, text, error => {
                void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`);
            });
        }
        catch (error) {
            await delivery.sendFinal(chatId, `❌ 会话创建失败:${messageOf(error)}`);
        }
    }
    /**
     * Whitelist or allow-all check for one bot. Ids are compared numerically so a
     * string/number mismatch introduced by config serialization cannot lock the
     * operator out of their own bot.
     */
    isAllowed(scope, userId) {
        if (scope.allowAllUsers)
            return true;
        return scope.allowedUserIds.some(id => Number(id) === Number(userId));
    }
    /** Handle a callback_query (menu button press). */
    async handleCallback(runtime, callbackQuery) {
        const { scope, delivery, client } = runtime;
        const chatId = callbackQuery.message?.chat?.id;
        if (chatId === undefined)
            return;
        // Acknowledge the press (stops Telegram's loading spinner).
        try {
            await client.answerCallbackQuery(callbackQuery.id);
        }
        catch (error) {
            this.options.logger?.warn(`[tg] answerCallbackQuery failed: ${messageOf(error)}`);
        }
        const data = callbackQuery.data ?? '';
        // A pending interactive answer (user-questions / approval) consumes the press
        // before any menu routing — but ONLY for an authorized sender, so an
        // unauthorized user cannot answer (e.g. approve / reject) a pending prompt.
        if (this.options.respond !== undefined && this.isAllowed(scope, callbackQuery.from?.id ?? 0)) {
            try {
                if (await this.options.respond.onCallback(data, chatId, scope.botId))
                    return;
            }
            catch (error) {
                this.options.logger?.warn(`[tg] respond.onCallback failed: ${messageOf(error)}`);
            }
        }
        const menuCtx = this.options.menuCtxFor?.(chatId, scope.botId);
        if (menuCtx === undefined) {
            await delivery.sendFinal(chatId, '菜单不可用');
            return;
        }
        // Authorize the callback sender for ops; reuse the same whitelist check as
        // inbound messages so the high-risk actions (restart dsh) cannot be pressed
        // by a non-whitelisted user.
        menuCtx.userId = callbackQuery.from?.id ?? 0;
        menuCtx.canOperate = this.isAllowed(scope, menuCtx.userId);
        // Log every menu press with its sender plus the EFFECTIVE whitelist, so a
        // config that never reached the plugin is distinguishable from an id mismatch.
        this.options.logger?.warn(`[tg] bot "${scope.botId}" menu callback "${data}" user=${menuCtx.userId} chat=${chatId}`
            + ` canOperate=${menuCtx.canOperate} allowedUserIds=[${scope.allowedUserIds.join(',')}] allowAllUsers=${scope.allowAllUsers}`);
        try {
            const result = await handleMenuCallback(data, menuCtx);
            await delivery.sendMenu(chatId, result.text, result.keyboard);
        }
        catch (error) {
            this.options.logger?.error(`[tg] menu callback failed: ${messageOf(error)}`);
            await delivery.sendFinal(chatId, `❌ 菜单执行失败:${messageOf(error)}`);
        }
    }
}
