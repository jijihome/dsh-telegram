/**
 * dsh-telegram deployment config. 极简:只配置一个或多个 Bot Token 即可运行。
 *
 * 多 Bot 采用「严格租户隔离」模型:每一个 Bot 是一个隔离域(BotScope)。
 * 插件级字段提供默认值,`bots[].<field>` 可以逐 Bot 覆盖;任何跨 Bot 的
 * 隐式共享(裸 chatId 绑定、同一 DSH 会话被多个 Bot 绑定)默认被拒绝,
 * 必须显式开启 `allowSharedSessions`。
 *
 * @module telegram/config
 */

import Schema from '@deepseek-ai/schemastery'

/** One bot instance: an isolated tenant with its own token, poll connection and policy. */
export interface BotConfig {
  /** Stable short id used in logs/session ids. Must be unique; `:` is not allowed. */
  id: string
  /** Bot token from @BotFather. Must be unique across bots. */
  token: string
  /**
   * Per-bot session binding: chatId → existing DSH session, so this bot's chat
   * participates in that conversation bidirectionally. The chat id is keyed
   * directly under the bot (no `botId:chatId` prefix needed).
   */
  bindings?: Record<string, string>
  /** Override: Telegram user ids allowed to talk to THIS bot. */
  allowedUserIds?: number[]
  /** Override: allow any Telegram user for THIS bot (development only). */
  allowAllUsers?: boolean
  /** Override: LLM provider id for agents created for THIS bot. */
  provider?: string
  /** Override: model id for agents created for THIS bot. */
  model?: string
  /** Override: base working directory roots browsable by THIS bot's /workspace. */
  workspaceRoots?: string[]
  /** Override: HTTP/HTTPS proxy used for THIS bot's Telegram traffic. */
  proxy?: string
  /** Override: root directory for THIS bot's persistent state (per-bot subdir). */
  dataDir?: string
  /**
   * Allow THIS bot's menus to enumerate and attach to host-wide DSH sessions and
   * workspaces (GUI conversations, other bots' sessions). Default `false`:
   * a bot only sees sessions it owns, plus its explicit `bindings`.
   */
  allowHostSessions?: boolean
  /**
   * Allow THIS bot to restart the shared host DSH process (stops every bot).
   * Defaults to `true` only when the plugin runs exactly one bot.
   */
  allowOpsRestart?: boolean
  /** Allow THIS bot to bind a DSH session that another bot already bound. */
  allowSharedSessions?: boolean
}

/** dsh-telegram plugin config. */
export interface TelegramConfig {
  /** One or more bots; each gets an independent long-poll connection. */
  bots: BotConfig[]
  /** Fallback: accept a single bare token (becomes one bot with id 'bot'). */
  token?: string
  /** Telegram user ids allowed to talk to the bots; empty means none unless `allowAllUsers`. */
  allowedUserIds?: number[]
  /** Allow any Telegram user (development only). */
  allowAllUsers?: boolean
  /**
   * LLM provider id passed to each created agent. Leave unset to follow the host
   * default model (`agent-default-model`) — the same default the GUI uses — so a
   * bot continues the conversation on a working model instead of a hardcoded
   * plugin default. Setting it pins every bot (overridable per bot).
   */
  provider?: string
  /** Model id passed to each created agent; unset = follow the host default model. */
  model?: string
  /** Per-chunk message length limit (Telegram caps at 4096). */
  maxMessageLength?: number
  /** Long-polling timeout in seconds. */
  pollingTimeoutSec?: number
  /**
   * Send a visible "✅ 完成" line when a turn ends normally (in addition to the
   * streamed live answer). On by default so the bot always knows a session ended;
   * set `false` to stop the extra line on clean completions. Interruption causes
   * (cancel/error/blocked/max-tokens/interrupted) are ALWAYS surfaced regardless.
   */
  notifyEnd?: boolean
  /** Base working directory roots for /workspace browsing. Defaults to process.cwd(). */
  workspaceRoots?: string[]
  /** Directory for persistent state (chat↔session map, offsets). Default: <cwd>/data. */
  dataDir?: string
  /**
   * HTTP/HTTPS proxy for Telegram traffic (for example `http://127.0.0.1:7897`).
   * Falls back to `TELEGRAM_PROXY`/`HTTPS_PROXY` env vars when omitted. Only
   * Telegram requests use it; other host network calls are untouched.
   */
  proxy?: string
  /** Keep the host process alive for long-polling daemon operation. */
  keepAlive?: boolean
  /**
   * Session binding: map a Telegram chat to an existing DSH session so the
   * bot participates in that conversation bidirectionally. Keys are either
   * `botId:chatId` (exact) or a bare `chatId` (any bot); values are DSH
   * session ids (e.g. `session-<uuid>` for a web GUI conversation).
   *
   * Strict isolation: a bare `chatId` key is accepted **only** when exactly one
   * bot is configured; with two or more bots it is rejected at startup.
   */
  bindings?: Record<string, string>
  /** Plugin-wide default for per-bot `allowHostSessions`. */
  allowHostSessions?: boolean
  /** Plugin-wide default for per-bot `allowOpsRestart`. */
  allowOpsRestart?: boolean
  /** Plugin-wide default for per-bot `allowSharedSessions`. */
  allowSharedSessions?: boolean
}

export const Config: Schema<TelegramConfig> = Schema.object({
  bots: Schema.array(Schema.object({
    id: Schema.string().required(),
    token: Schema.string().required(),
    bindings: Schema.dict(Schema.string()),
    allowedUserIds: Schema.array(Schema.number()),
    allowAllUsers: Schema.boolean(),
    provider: Schema.string(),
    model: Schema.string(),
    workspaceRoots: Schema.array(Schema.string()),
    proxy: Schema.string(),
    dataDir: Schema.string(),
    allowHostSessions: Schema.boolean(),
    allowOpsRestart: Schema.boolean(),
    allowSharedSessions: Schema.boolean(),
  })).default([]),
  token: Schema.string(),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  provider: Schema.string(),
  model: Schema.string(),
  maxMessageLength: Schema.number().default(4096),
  pollingTimeoutSec: Schema.number().default(30),
  notifyEnd: Schema.boolean().default(true),
  workspaceRoots: Schema.array(Schema.string()),
  dataDir: Schema.string(),
  proxy: Schema.string(),
  keepAlive: Schema.boolean().default(true),
  bindings: Schema.dict(Schema.string()),
  allowHostSessions: Schema.boolean().default(false),
  allowOpsRestart: Schema.boolean(),
  allowSharedSessions: Schema.boolean().default(false),
})
