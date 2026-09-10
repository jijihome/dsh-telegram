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

import { join } from 'node:path'
import type { BotConfig, TelegramConfig } from '../config.js'

/** One resolved, isolated bot tenant. */
export interface BotScope {
  /** Unique bot id (matches `/^[A-Za-z0-9._-]+$/`, so `botId:chatId` stays unambiguous). */
  botId: string
  /** Telegram bot token. */
  token: string
  /** chatId → existing DSH session id, declared for this bot only. */
  bindings: Record<string, string>
  /** Telegram user ids allowed to talk to this bot. */
  allowedUserIds: number[]
  /** Allow any user for this bot (development only). */
  allowAllUsers: boolean
  /** Default LLM provider for this bot's agents. */
  provider: string
  /** Default model for this bot's agents. */
  model: string
  /**
   * True when this bot (or the plugin config) pins an explicit provider/model.
   * When false the route follows the host default model at request time
   * (read-only, never written), so a bot continues the conversation on the same
   * model the GUI uses instead of a hardcoded plugin default.
   */
  modelPinned: boolean
  /** Working directory roots this bot may browse. */
  workspaceRoots: string[]
  /** Proxy used for this bot's Telegram traffic, if any. */
  proxy?: string
  /** Root persistence directory; this bot's files live under `<dataDir>/bots/<botId>/`. */
  dataDir: string
  /** May this bot enumerate/attach host-wide DSH sessions and workspaces? */
  allowHostSessions: boolean
  /** May this bot restart the shared host DSH process (stops every bot)? */
  allowOpsRestart: boolean
  /** May this bot bind a DSH session already bound by another bot? */
  allowSharedSessions: boolean
}

/** Ids must survive `${botId}:${chatId}` key composition, so `:` is excluded. */
const BOT_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Last-resort model used only when neither the bot nor the host declares one. */
const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Build the canonical isolation key for one chat inside one bot. */
export function routeKey(botId: string, chatId: number): string {
  return `${botId}:${chatId}`
}

/**
 * Resolve every configured bot into an isolated scope.
 *
 * @param bots - normalized bot list (`bots[]` or the single-token fallback).
 * @param config - plugin-level config supplying defaults for unset bot fields.
 * @param defaultCwd - host process cwd; the last-resort workspace root.
 * @throws when the bot set cannot be isolated (duplicate id/token, bad id, no bots).
 */
export function resolveBotScopes(bots: BotConfig[], config: TelegramConfig, defaultCwd: string): BotScope[] {
  if (bots.length === 0) {
    throw new Error('dsh-telegram: 未配置任何 Bot Token(需在配置中提供 bots[].token 或 token)')
  }
  const problems: string[] = []
  const seenIds = new Map<string, number>()
  const seenTokens = new Map<string, number>()

  bots.forEach((bot, index) => {
    const id = bot.id
    const where = `bots[${index}]`
    if (id === undefined || id === '') {
      problems.push(`${where}: id 不能为空`)
    } else if (!BOT_ID_PATTERN.test(id)) {
      problems.push(`${where}: id "${id}" 含非法字符(只允许字母/数字/._-,且不能含 ':' )`)
    } else if (seenIds.has(id)) {
      problems.push(`bots[${index}]: 重复的 bot id "${id}"(与 bots[${seenIds.get(id)}] 冲突);每个 Bot 必须有唯一 id`)
    } else {
      seenIds.set(id, index)
    }
    if (bot.token === undefined || bot.token === '') {
      problems.push(`${where}: token 不能为空`)
    } else if (seenTokens.has(bot.token)) {
      problems.push(`bots[${index}] ("${id}"): token 与 bots[${seenTokens.get(bot.token)}] 相同;两个 Bot 共用一个 token 会互相抢 getUpdates,必须各用各的 token`)
    } else {
      seenTokens.set(bot.token, index)
    }
  })

  if (problems.length > 0) {
    throw new Error(`dsh-telegram: Bot 配置校验失败(多 Bot 严格隔离要求唯一 id 与唯一 token):\n- ${problems.join('\n- ')}`)
  }

  const globalHostSessions = config.allowHostSessions ?? false
  const globalSharedSessions = config.allowSharedSessions ?? false
  const single = bots.length === 1

  // An explicit provider/model at bot or plugin level pins the route; otherwise
  // the route follows the host default model (see `modelPinned`).
  const configProvider = config.provider
  const configModel = config.model

  return bots.map(bot => {
    const dataDir = bot.dataDir ?? config.dataDir ?? joinDefaultDataDir(defaultCwd)
    const pinnedProvider = bot.provider ?? configProvider
    const pinnedModel = bot.model ?? configModel
    return {
      botId: bot.id,
      token: bot.token,
      bindings: bot.bindings ?? {},
      allowedUserIds: bot.allowedUserIds ?? config.allowedUserIds ?? [],
      allowAllUsers: bot.allowAllUsers ?? config.allowAllUsers ?? false,
      provider: pinnedProvider ?? DEFAULT_PROVIDER,
      model: pinnedModel ?? DEFAULT_MODEL,
      modelPinned: pinnedProvider !== undefined || pinnedModel !== undefined,
      workspaceRoots: bot.workspaceRoots ?? config.workspaceRoots ?? [defaultCwd],
      ...(bot.proxy !== undefined ? { proxy: bot.proxy }
        : config.proxy !== undefined ? { proxy: config.proxy }
          : {}),
      dataDir,
      allowHostSessions: bot.allowHostSessions ?? globalHostSessions,
      // Restarting the host stops every bot, so it is a single-bot-only default.
      allowOpsRestart: bot.allowOpsRestart ?? config.allowOpsRestart ?? single,
      allowSharedSessions: bot.allowSharedSessions ?? globalSharedSessions,
    } satisfies BotScope
  })
}

/** Default state root: `<DSH_HOME>/plugin-data/dsh-telegram`. */
export function joinDefaultDataDir(defaultCwd: string): string {
  const dshHome = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? defaultCwd
  return join(dshHome, 'plugin-data', 'dsh-telegram')
}

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
export function assertSessionOwnership(scopes: readonly BotScope[]): void {
  const owners = new Map<string, BotScope>()
  const conflicts: string[] = []
  for (const scope of scopes) {
    for (const sessionId of Object.values(scope.bindings)) {
      const owner = owners.get(sessionId)
      if (owner === undefined) {
        owners.set(sessionId, scope)
        continue
      }
      if (owner.botId === scope.botId) continue
      if (owner.allowSharedSessions && scope.allowSharedSessions) continue
      conflicts.push(`会话 ${sessionId} 同时被 bot "${owner.botId}" 与 bot "${scope.botId}" 绑定`)
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      'dsh-telegram: 检测到跨 Bot 会话共享(严格隔离下默认拒绝,会导致两个 Bot 同时收到同一会话输出):\n- '
      + conflicts.join('\n- ')
      + '\n修法:把该会话只留给一个 Bot,或给相关 Bot 显式设置 allowSharedSessions: true。',
    )
  }
}
