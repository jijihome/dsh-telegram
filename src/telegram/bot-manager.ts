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

import type { BotConfig } from '../config.js'
import { TelegramClient, TelegramTransportError } from './api.js'
import { LongPoll } from './long-poll.js'
import { Delivery } from './delivery.js'
import type { TelegramUpdate, TelegramCallbackQuery } from './api.js'
import type { CommandContext } from '../commands/index.js'
import { handleCommand } from '../commands/index.js'
import type { SessionManager } from '../core/session-manager.js'
import type { StateStore } from '../core/state-store.js'
import { handleMenuCallback, mainMenuKeyboard, mainMenuText, type MenuCtx } from './menu.js'

export interface BotManagerOptions {
  bots: BotConfig[]
  /** Telegram user ids allowed to talk; empty = none unless allowAllUsers. */
  allowedUserIds: number[]
  /** Allow any user (dev only). */
  allowAllUsers: boolean
  sessions: SessionManager
  store: StateStore
  pollingTimeoutSec: number
  maxMessageLength: number
  workspaceRoots: string[]
  defaultCwd: string
  /** If set, every text sent to Telegram is appended to this file. */
  forwardLogPath?: string
  /**
   * HTTP/HTTPS proxy for Telegram traffic (e.g. `http://127.0.0.1:7897`).
   * Passed to each bot's client; only Telegram requests use it.
   */
  proxy?: string
  /** Build a MenuCtx for a chat/client (injected from the plugin entry). */
  menuCtxFor?: (chatId: number, botId: string) => MenuCtx
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

export interface BotRuntime {
  bot: BotConfig
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

  /** Ready-to-use runtimes (only successfully started bots). */
  get all(): Map<string, BotRuntime> {
    return this.runtimes
  }

  /** Start every bot; a per-bot startup failure is isolated and recorded. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const bot of this.options.bots) {
      try {
        const runtime = this.launch(bot)
        this.runtimes.set(bot.id, runtime)
      } catch (error) {
        this.options.logger?.error(`[tg] bot "${bot.id}" failed to start: ${messageOf(error)}`)
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
  private launch(bot: BotConfig): BotRuntime {
    const logger = this.options.logger
    const client = new TelegramClient(bot.token, {
      pollingTimeoutSec: this.options.pollingTimeoutSec,
      ...(this.options.proxy !== undefined ? { proxy: this.options.proxy } : {}),
    })
    const delivery = new Delivery({
      client,
      maxMessageLength: this.options.maxMessageLength,
      logger,
      ...(this.options.forwardLogPath !== undefined ? { forwardLogPath: this.options.forwardLogPath } : {}),
    })
    const poll = new LongPoll({
      client,
      onUpdate: update => void this.handleUpdate(bot, update),
      onError: (error, attempt, delayMs) => {
        logger?.warn(`[tg] bot "${bot.id}" poll error #${attempt} (retry ${delayMs}ms): ${messageOf(error)}`)
      },
    })

    const runtime: BotRuntime = { bot, client, delivery, poll }
    void client.getMe().then(me => {
      logger?.warn(`[tg] bot "${bot.id}" online: @${me.username ?? me.id}`)
      // Restore the persisted offset after the token check passes.
      poll.restoreOffset(this.options.store.getOffset(bot.id))
      poll.start()
    }).catch(error => {
      runtime.lastError = messageOf(error)
      // Transport failures ("network down", proxy, DNS…) must not be blamed
      // on the token; only an HTTP/API error such as 401 makes the token
      // itself invalid.
      const label = error instanceof TelegramTransportError ? 'startup network check failed' : 'token invalid'
      logger?.error(`[tg] bot "${bot.id}" ${label}: ${runtime.lastError}`)
    })
    return runtime
  }

  /** Route one Telegram update: authorize, then command or agent follow-up. */
  private async handleUpdate(bot: BotConfig, update: TelegramUpdate): Promise<void> {
    const api = this.runtimes.get(bot.id)?.client
    // Menu button press → run the menu action and show the result.
    const callbackQuery = update.callback_query
    if (callbackQuery !== undefined) {
      await this.handleCallback(bot, callbackQuery)
      return
    }
    const message = update.message
    if (message === undefined) return
    const chatId = message.chat.id

    // Authorization.
    if (!this.isAllowed(message.from?.id ?? 0)) {
      await this.runtimes.get(bot.id)?.delivery.sendFinal(chatId, '⛔ 未授权的用户')
      return
    }

    const runtime = this.runtimes.get(bot.id)
    if (runtime === undefined) return
    const { delivery, bot: cfg } = runtime
    const text = message.text ?? ''

    // /menu shows the inline keyboard menu with the status summary on top.
    if (/^\/(menu)$/.test(text.trim())) {
      const menuCtx = this.options.menuCtxFor?.(chatId, cfg.id)
      if (menuCtx !== undefined) {
        menuCtx.userId = message.from?.id ?? 0
        menuCtx.canOperate = this.isAllowed(menuCtx.userId)
        await delivery.sendMenu(chatId, await mainMenuText(menuCtx), mainMenuKeyboard())
      } else {
        await delivery.sendMenu(chatId, await mainMenuText(), mainMenuKeyboard())
      }
      return
    }

    // Commands are handled locally.
    const cmdCtx: CommandContext = {
      chatId,
      botId: cfg.id,
      userId: message.from?.id ?? 0,
      delivery,
      sessions: this.options.sessions,
      store: this.options.store,
      workspaceRoots: this.options.workspaceRoots,
      defaultCwd: this.options.defaultCwd,
    }
    const result = await handleCommand(text, cmdCtx)
    if (result.handled) {
      if (result.reply !== undefined) await delivery.sendFinal(chatId, result.reply)
      return
    }
    if (text.trim() === '') return

    // Otherwise: if the chat is bound to an existing session, follow up on it;
    // else bind the chat to its own agent and follow up.
    try {
      const bound = this.options.sessions.getBound(chatId, cfg.id)
      if (bound !== undefined) {
        this.options.logger?.warn(`[tg] bound msg chat=${chatId}(${cfg.id}) -> ${bound.sessionId}`)
        await delivery.typing(chatId)
        void this.options.sessions.boundFollowup(chatId, cfg.id, text, error => {
          void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`)
        })
        return
      }
      this.options.logger?.warn(`[tg] unbound msg chat=${chatId}(${cfg.id}); creating own session`)
      const binding = await this.options.sessions.getOrCreate(chatId, cfg.id)
      const persisted = this.options.store.getChat(`${cfg.id}:${chatId}`)
      if (binding.cwd !== (persisted?.cwd ?? this.options.defaultCwd)) {
        // A /workspace switch was recorded for a later /new; nothing to do
        // for the live binding — keep on the current cwd.
      }
      await delivery.typing(chatId)
      this.options.sessions.followup(chatId, cfg.id, text, error => {
        void delivery.sendFinal(chatId, `❌ 消息处理失败:${messageOf(error)}`)
      })
    } catch (error) {
      await delivery.sendFinal(chatId, `❌ 会话创建失败:${messageOf(error)}`)
    }
  }

  /** Whitelist or allow-all check. */
  private isAllowed(userId: number): boolean {
    if (this.options.allowAllUsers) return true
    return this.options.allowedUserIds.includes(userId)
  }

  /** Handle a callback_query (menu button press). */
  private async handleCallback(bot: BotConfig, callbackQuery: TelegramCallbackQuery): Promise<void> {
    const runtime = this.runtimes.get(bot.id)
    if (runtime === undefined) return
    const { delivery, bot: cfg, client } = runtime
    const chatId = callbackQuery.message?.chat?.id
    if (chatId === undefined) return
    // Acknowledge the press (stops Telegram's loading spinner).
    try {
      await client.answerCallbackQuery(callbackQuery.id)
    } catch (error) {
      this.options.logger?.warn(`[tg] answerCallbackQuery failed: ${messageOf(error)}`)
    }
    const data = callbackQuery.data ?? ''
    const menuCtx = this.options.menuCtxFor?.(chatId, cfg.id)
    if (menuCtx === undefined) {
      await delivery.sendFinal(chatId, '菜单不可用')
      return
    }
    // Authorize the callback sender for ops; reuse the same whitelist check as
    // inbound messages so the high-risk actions (restart dsh) cannot be pressed
    // by a non-whitelisted user.
    menuCtx.userId = callbackQuery.from?.id ?? 0
    menuCtx.canOperate = this.isAllowed(menuCtx.userId)
    try {
      const result = await handleMenuCallback(data, menuCtx)
      await delivery.sendMenu(chatId, result.text, result.keyboard)
    } catch (error) {
      this.options.logger?.error(`[tg] menu callback failed: ${messageOf(error)}`)
      await delivery.sendFinal(chatId, `❌ 菜单执行失败:${messageOf(error)}`)
    }
  }
}