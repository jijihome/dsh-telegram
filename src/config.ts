/**
 * dsh-telegram deployment config. 极简:只配置一个或多个 Bot Token 即可运行。
 * @module telegram/config
 */

import Schema from '@deepseek-ai/schemastery'

/** One bot instance: independent token, long-poll connection, failure isolation. */
export interface BotConfig {
  /** Stable short id used in logs/session ids; defaults to 'bot'. */
  id: string
  /** Bot token from @BotFather. */
  token: string
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
  /** LLM provider id passed to each created agent. */
  provider?: string
  /** Model id passed to each created agent. */
  model?: string
  /** Per-chunk message length limit (Telegram caps at 4096). */
  maxMessageLength?: number
  /** Long-polling timeout in seconds. */
  pollingTimeoutSec?: number
  /** Base working directory roots for /workspace browsing. Defaults to process.cwd(). */
  workspaceRoots?: string[]
  /** Directory for persistent state (chat↔session map, offsets). Default: <cwd>/data. */
  dataDir?: string
  /** Keep the host process alive for long-polling daemon operation. */
  keepAlive?: boolean
}

export const Config: Schema<TelegramConfig> = Schema.object({
  bots: Schema.array(Schema.object({
    id: Schema.string().required(),
    token: Schema.string().required(),
  })).default([]),
  token: Schema.string(),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  maxMessageLength: Schema.number().default(4096),
  pollingTimeoutSec: Schema.number().default(30),
  workspaceRoots: Schema.array(Schema.string()),
  dataDir: Schema.string(),
  keepAlive: Schema.boolean().default(true),
})