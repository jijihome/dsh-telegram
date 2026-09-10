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

import { join } from 'node:path'
import type { BotConfig } from '../config.js'
import type { BotScope } from '../core/bot-scope.js'
import { botDataDir } from '../core/state-store.js'
import { TelegramClient, TelegramTransportError } from './api.js'
import { LongPoll } from './long-poll.js'
import { Delivery } from './delivery.js'
import type { TelegramUpdate, TelegramCallbackQuery } from './api.js'
import type { CommandContext } from '../commands/index.js'
import { handleCommand } from '../commands/index.js'
import type { SessionManager } from '../core/session-manager.js'
import { handleMenuCallback, mainMenuKeyboard, mainMenuText, type MenuCtx } from './menu.js'
import { registerBotUi } from './bot-commands.js'

export interface BotManagerOptions {
  /** One resolved isolation scope per configured bot. */
  scopes: readonly BotScope[]
  sessions: SessionManager
  pollingTimeoutSec: number
  maxMessageLength: number
  defaultCwd: string
  /** Build a MenuCtx for one (chat, bot) pair (injected from the plugin entry). */
  menuCtxFor?: (chatId: number, botId: string) => MenuCtx
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

export interface BotRuntime {
  scope: BotScope
  client: TelegramClient
  delivery: Delivery
  poll: LongPoll
  /** Set when the bot could not be started (bad token etc). */
  lastError?: string
}

/** Normalized bot list: either `bots[]` entries or the single bare `token`. */
export function normalizeBots(bots: BotConfig[], token?: string): BotConfig[] {
  if (bots.length > 0) return bots
  if (token !== undefined && token !== '') return [{ id: 'bot', token }]
  return []
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Starts, supervises, and stops all bots. */
export class BotManager {
  private readonly options: BotManagerOptions
  private readonly runtimes = new Map<string, BotRuntime>()
  private started = false

  constructor(options: BotManagerOptions) {
    this.options = options
  }

  /** Ready-to-use runtimes (only successfully started bots), keyed by bot id. */
  get all(): Map<string, BotRuntime> {
    return this.runtimes
  }

  /** Start every bot; a per-bot startup failure is isolated and recorded. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const scope of this.options.scopes) {
      try {
        const runtime = this.launch(scope)
        this.runtimes.set(scope.botId, runtime)
      } catch (error) {
        this.options.logger?.error(`[tg] bot "${scope.botId}" failed to start: ${messageOf(error)}`)
      }
    }
  }

  /** Stop every bot (plugin unload / dispose). */
  async stop(): Promise<void> {
    this.started = false
    const polls = [...this.runtimes.values()].map(runtime => runtime.poll.stop())
    await Promise.allSettled(polls)
    // Dispose each client's proxy connection pool, if one was created.
    for (const runtime of this.runtimes.values()) runtime.client.close()
    this.runtimes.clear()
  }

  /** Launch one bot: client + delivery + poll, verify token async, wire updates. */
  private launch(scope: BotScope): BotRuntime {
    const logger = this.options.logger
    const client = new TelegramClient(scope.token, {
      pollingTimeoutSec: this.options.pollingTimeoutSec,
      ...(scope.proxy !== undefined ? { proxy: scope.proxy } : {}),
    })
    // Each bot logs forward traffic into its own directory, so one bot's
    // conversation can never be read out of another bot's log file.
    const delivery = new Delivery({
      client,
      maxMessageLength: this.options.maxMessageLength,
      logger,
      forwardLogPath: join(botDataDir(scope.dataDir, scope.botId), 'forward.log'),
    })
    // The runtime is captured by the update handler, so a bot can only ever act
    // through its own client/delivery (no id-keyed reverse lookup).
    const runtime: BotRuntime = { scope, client, delivery, poll: undefined as unknown as LongPoll }
    const poll = new LongPoll({
      client,
      onUpdate: update => void this.handleUpdate(runtime, update),
      onError: (error, attempt, delayMs) => {
        logger?.warn(`[tg] bot "${scope.botId}" poll error #${attempt} (retry ${delayMs}ms): ${messageOf(error)}`)
      },
    })
    runtime.poll = poll

    void client.getMe().then(me => {
      logger?.warn(`[tg] bot "${scope.botId}" online: @${me.username ?? me.id}`)
      // Restore the persisted offset after the token check passes.
      poll.restoreOffset(this.options.sessions.storeFor(scope.botId).getOffset(scope.botId))
      poll.start()
      // Register the command menu + menu button (non-fatal: log-and-continue).
      registerBotUi(client).catch(error => {
        logger?.warn(`[tg] bot "${scope.botId}" bot UI registration failed (non-fatal): ${messageOf(error)}`)
      })
    }).catch(error => {
      runtime.lastError = messageOf(error)
      // Transport failures ("network down", proxy, DNS…) must not be blamed
      // on the token; only an HTTP/API error such as 401 makes the token
      // itself invalid.
      const label = error instanceof TelegramTransportError ? 'startup network check failed' : 'token invalid'
      logger?.error(`[tg] bot "${scope.botId}" ${label}: ${runtime.lastError}`)
    })
    return runtime
  }

  /** Route one Telegram update: authorize, then command or agent follow-up. */
  private async handleUpdate(runtime: BotRuntime, update: TelegramUpdate): Promise<void> {
    const { scope, delivery } = runtime
    // Menu button press → run the menu action and show the result.
    const callbackQuery = update.callback_query
    if (callbackQuery !== undefined) {
      await this.handleCallback(runtime, callbackQuery)
      return
    }
    const message = update.message
    if (message === undefined) return
    const chatId = message.chat.id

    // Authorization (this bot's own whitelist only). The denial names the id so
    // an operator can whitelist exactly the right account instead of guessing.
    const userId = message.from?.id ?? 0
    if (!this.isAllowed(scope, userId)) {
      this.options.logger?.warn(
        `[tg] bot "${scope.botId}" 拒绝非白名单用户: user=${userId} chat=${chatId}`
        + ` (生效白名单=[${scope.allowedUserIds.join(',')}] allowAllUsers=${scope.allowAllUsers})`,
      )
      await delivery.sendFinal(chatId, `⛔ 未授权的用户\n你的 Telegram user id: ${userId}\n(生效白名单: [${scope.allowedUserIds.join(',')}];allowAllUsers=${scope.allowAllUsers})`)
      return
    }

    const text = message.text ?? ''

    // /menu shows the inline keyboard menu with the status summary on top.
    if (/^\/(menu)$/.test(text.trim())) {
      const menuCtx = this.options.menuCtxFor?.(chatId, scope.botId)
      if (menuCtx !== undefined) {
        menuCtx.userId = userId
        menuCtx.canOperate = this.isAllowed(scope, userId)
        await delivery.sendMenu(chatId, await mainMenuText(menuCtx), mainMenuKeyboard())
      } else {
        await delivery.sendMenu(chatId, await mainMenuText(), mainMenuKeyboard())
      }
      return
    }

    // Commands are handled locally.
    const cmdCtx: CommandContext = {
      chatId,
      botId: scope.botId,
      userId: message.from?.id ?? 0,
      delivery,
      sessions: this.options.sessions,
      store: this.options.sessions.storeFor(scope.botId),
      workspaceRoots: scope.workspaceRoots,
      defaultCwd: this.options.defaultCwd,
    }
    const result = await handleCommand(text, cmdCtx)
    if (result.handled) {
      if (result.reply !== undefined) {
        if (result.keyboard !== undefined) await delivery.sendMenu(chatId, result.reply, result.keyboard)
        else await delivery.sendFinal(chatId, result.reply)
      }
      return
    }
    if (text.trim() === '') return

    // Otherwise: if the chat is bound to an existing session, follow up on it;
    // else bind the chat to its own agent and follow up.
    try {
      const bound = this.options.sessions.getBound(chatId, scope.botId)
      if (bound !== undefined) {
        this.options.logger?.warn(`[tg] bound msg chat=${chatId}(${scope.botId}) -> ${bound.sessionId}`)
        await delivery.typing(chatId)
        void this.options.sessions.boundFollowup(chatId, scope.botId, text, error => {
          void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`)
        })
        return
      }
      this.options.logger?.warn(`[tg] unbound msg chat=${chatId}(${scope.botId}); creating own session`)
      await this.options.sessions.getOrCreate(chatId, scope.botId)
      await delivery.typing(chatId)
      this.options.sessions.followup(chatId, scope.botId, text, error => {
        void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`)
      })
    } catch (error) {
      await delivery.sendFinal(chatId, `❌ 会话创建失败:${messageOf(error)}`)
    }
  }

  /**
   * Whitelist or allow-all check for one bot. Ids are compared numerically so a
   * string/number mismatch introduced by config serialization cannot lock the
   * operator out of their own bot.
   */
  private isAllowed(scope: BotScope, userId: number): boolean {
    if (scope.allowAllUsers) return true
    return scope.allowedUserIds.some(id => Number(id) === Number(userId))
  }

  /** Handle a callback_query (menu button press). */
  private async handleCallback(runtime: BotRuntime, callbackQuery: TelegramCallbackQuery): Promise<void> {
    const { scope, delivery, client } = runtime
    const chatId = callbackQuery.message?.chat?.id
    if (chatId === undefined) return
    // Acknowledge the press (stops Telegram's loading spinner).
    try {
      await client.answerCallbackQuery(callbackQuery.id)
    } catch (error) {
      this.options.logger?.warn(`[tg] answerCallbackQuery failed: ${messageOf(error)}`)
    }
    const data = callbackQuery.data ?? ''
    const menuCtx = this.options.menuCtxFor?.(chatId, scope.botId)
    if (menuCtx === undefined) {
      await delivery.sendFinal(chatId, '菜单不可用')
      return
    }
    // Authorize the callback sender for ops; reuse the same whitelist check as
    // inbound messages so the high-risk actions (restart dsh) cannot be pressed
    // by a non-whitelisted user.
    menuCtx.userId = callbackQuery.from?.id ?? 0
    menuCtx.canOperate = this.isAllowed(scope, menuCtx.userId)
    // Log every menu press with its sender plus the EFFECTIVE whitelist, so a
    // config that never reached the plugin is distinguishable from an id mismatch.
    this.options.logger?.warn(
      `[tg] bot "${scope.botId}" menu callback "${data}" user=${menuCtx.userId} chat=${chatId}`
      + ` canOperate=${menuCtx.canOperate} allowedUserIds=[${scope.allowedUserIds.join(',')}] allowAllUsers=${scope.allowAllUsers}`,
    )
    try {
      const result = await handleMenuCallback(data, menuCtx)
      await delivery.sendMenu(chatId, result.text, result.keyboard)
    } catch (error) {
      this.options.logger?.error(`[tg] menu callback failed: ${messageOf(error)}`)
      await delivery.sendFinal(chatId, `❌ 菜单执行失败:${messageOf(error)}`)
    }
  }
}
