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
import { TelegramClient } from './api.js'
import { LongPoll } from './long-poll.js'
import { Delivery } from './delivery.js'
import type { TelegramUpdate } from './api.js'
import type { CommandContext } from '../commands/index.js'
import { handleCommand } from '../commands/index.js'
import type { SessionManager } from '../core/session-manager.js'
import type { StateStore } from '../core/state-store.js'

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
    this.runtimes.clear()
  }

  /** Launch one bot: client + delivery + poll, verify token async, wire updates. */
  private launch(bot: BotConfig): BotRuntime {
    const logger = this.options.logger
    const client = new TelegramClient(bot.token, {
      pollingTimeoutSec: this.options.pollingTimeoutSec,
    })
    const delivery = new Delivery({
      client,
      maxMessageLength: this.options.maxMessageLength,
      logger,
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
      logger?.error(`[tg] bot "${bot.id}" token invalid: ${runtime.lastError}`)
    })
    return runtime
  }

  /** Route one Telegram update: authorize, then command or agent follow-up. */
  private async handleUpdate(bot: BotConfig, update: TelegramUpdate): Promise<void> {
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

    // Otherwise: bind the chat to an agent and follow up.
    try {
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
}