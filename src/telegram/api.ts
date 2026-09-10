/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes, `editMessageText`,
 * `sendChatAction`, and `getMe`.
 *
 * Based on @loserfox/telegram's client.ts (BSD-3-Clause), extended with
 * `editMessageText` for incremental streaming updates.
 * The token is embedded in the request URL, so every error path redacts it.
 *
 * @module telegram/api
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

/** Telegram user object (sender of a message). */
export interface TelegramUser {
  readonly id: number
  readonly first_name?: string
  readonly username?: string
  readonly is_bot?: boolean
}

/** Telegram chat object (private chat, group, or channel). */
export interface TelegramChat {
  readonly id: number
  readonly type: string
  readonly title?: string
  readonly username?: string
  readonly first_name?: string
}

/** Telegram message object; only the text-relevant fields are modeled. */
export interface TelegramMessage {
  readonly message_id: number
  readonly chat: TelegramChat
  readonly from?: TelegramUser
  readonly text?: string
  readonly date: number
}

/** Telegram update envelope; only message updates are modeled. */
export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly callback_query?: TelegramCallbackQuery
}

/** Inline keyboard button (menu). */
export interface TelegramInlineButton {
  readonly text: string
  readonly callback_data?: string
}

/** Inline keyboard (rows of buttons) attached to a message. */
export interface TelegramInlineKeyboard {
  readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[]
}

/** A callback_query update (a menu button was pressed). */
export interface TelegramCallbackQuery {
  readonly id: string
  readonly from?: TelegramUser
  readonly message?: TelegramMessage
  readonly data?: string
}

/** Runtime seam surface tests substitute with a fake. */
export interface TelegramClientLike {
  /** Fetch the bot identity; validates the token. */
  getMe(): Promise<TelegramUser>
  /** Long-poll for updates at or after `offset`. */
  getUpdates(offset?: number): Promise<TelegramUpdate[]>
  /** Send a message, optionally with HTML parse mode and an inline keyboard. */
  sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: TelegramInlineKeyboard): Promise<TelegramMessage>
  /** Replace the text of a previously sent message (incremental streaming). */
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: 'HTML'): Promise<TelegramMessage>
  /** Acknowledge a callback_query; optionally show a toast. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>
  /** Send a chat action such as `typing`. */
  sendChatAction(chatId: number, action: string): Promise<boolean>
}

/** Options for {@link TelegramClient}. */
export interface TelegramClientOptions {
  /** HTTP client seam; production uses the global `fetch`. */
  fetch?: typeof fetch
  /** API base URL; production uses the public Bot API. */
  baseUrl?: string
  /** Long-polling timeout in seconds; production default is 30. */
  pollingTimeoutSec?: number
  /**
   * HTTP/HTTPS proxy URL (for example `http://127.0.0.1:7897`). When set, all
   * Telegram traffic is routed through the proxy via an undici `ProxyAgent`.
   * Only this client's requests go through the proxy — the host process's other
   * network calls are untouched. Prefer `TELEGRAM_PROXY`/`HTTPS_PROXY` env vars.
   */
  proxy?: string
}

interface TelegramApiResponse<T> {
  ok?: boolean
  result?: T
  description?: string
}

/** Replace the token with a placeholder in an error text. */
function redactToken(text: string, token: string): string {
  return text.split(token).join('***')
}

/**
 * Flatten an error and its `cause` chain into one string (max 6 hops).
 * Node's fetch (undici) only ever throws a generic `TypeError: fetch
 * failed` and keeps the real reason (DNS / TCP / TLS / proxy / timeout)
 * in `cause`; without unwrapping it the log says nothing diagnosable.
 * Every level is redacted so the token never leaks.
 */
function redactedMessage(error: unknown, token: string): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current != null && depth < 6; depth++) {
    const text = current instanceof Error ? current.message : String(current)
    parts.push(redactToken(text, token))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join('; cause: ')
}

/**
 * Thrown when the Bot API request fails before a response is received
 * (DNS, TCP, TLS, proxy, timeout). Distinct from an HTTP/API error such
 * as `401 Unauthorized`, so callers can tell "network problem" from
 * "bad token".
 */
export class TelegramTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TelegramTransportError'
  }
}

/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export class TelegramClient implements TelegramClientLike {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly proxyAgent?: ProxyAgent
  /** Long-polling timeout in seconds; controls each getUpdates call. */
  readonly pollingTimeoutSec: number

  /**
   * @param token - bot token from @BotFather.
   * @param options - client options.
   */
  constructor(token: string, options: TelegramClientOptions = {}) {
    if (token === '') throw new Error('telegram client: token must not be empty')
    this.token = token
    this.proxyAgent = options.proxy ? new ProxyAgent(options.proxy) : undefined
    // When a proxy is set, use undici's own `fetch` with the same-version
    // `ProxyAgent` as the dispatcher. The Node global fetch rejects a ProxyAgent
    // from a mismatched undici/undici-types version (`invalid onRequestStart
    // method`), so we must not pass the dispatcher to `globalThis.fetch`.
    if (this.proxyAgent !== undefined) {
      const proxyFetch: typeof fetch = (input, init) =>
        undiciFetch(input as never, { ...(init ?? {}), dispatcher: this.proxyAgent } as never) as unknown as Promise<Response>
      this.fetchImpl = proxyFetch
    } else {
      this.fetchImpl = options.fetch ?? globalThis.fetch
    }
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org'
    this.pollingTimeoutSec = options.pollingTimeoutSec ?? 30
  }

  /** Dispose the proxy connection pool, if one was created. */
  close(): void {
    void this.proxyAgent?.close()
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`
  }

  /** POST `method` with `body`; throws on transport failure or a non-ok response. */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new TelegramTransportError(
        `telegram ${method} transport error: ${redactedMessage(error, this.token)}`,
        { cause: error },
      )
    }
    const payload = await response.json().catch(() => null) as TelegramApiResponse<T> | null
    if (!response.ok || payload?.ok !== true) {
      const description = payload?.description ?? `HTTP ${response.status}`
      throw new Error(`telegram ${method} failed: ${redactToken(description, this.token)}`)
    }
    return payload.result as T
  }

  /**
   * Fetch the bot identity; fails when the token is invalid.
   * @returns the bot user object.
   */
  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {})
  }

  /**
   * Long-poll for message updates. Pass the previous update id plus one to
   * acknowledge already-seen updates; `undefined` starts from the newest.
   * @param offset - the update id to start from.
   * @returns the batch of updates received within the polling timeout.
   */
  getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: this.pollingTimeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }
    if (offset !== undefined) body.offset = offset
    return this.call<TelegramUpdate[]>('getUpdates', body)
  }

  /**
   * Send a text message, optionally with HTML parse mode and an inline keyboard.
   * @param chatId - target chat id.
   * @param text - the message text.
   * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
   * @param replyMarkup - inline keyboard to attach (for menu navigation).
   * @returns the delivered message object.
   */
  sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: TelegramInlineKeyboard): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text }
    if (parseMode !== undefined) body.parse_mode = parseMode
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup
    return this.call<TelegramMessage>('sendMessage', body)
  }

  /**
   * Replace the text of a previously sent message. Used to stream incremental
   * model output into one growing message instead of spamming new ones.
   * @param chatId - target chat id.
   * @param messageId - the message to edit (from a prior sendMessage).
   * @param text - the new full text (Telegram HTML or plain).
   * @param parseMode - `HTML` when `text` is Telegram-HTML, else plain text.
   * @returns the edited message object.
   */
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: 'HTML'): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text }
    if (parseMode !== undefined) body.parse_mode = parseMode
    return this.call<TelegramMessage>('editMessageText', body)
  }

  /**
   * Acknowledge a callback_query (menu button press) so Telegram stops the
   * loading spinner; optionally show a short toast.
   * @param callbackQueryId - the callback query id.
   * @param text - optional toast text (shown briefly near the button).
   */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
    if (text !== undefined) body.text = text
    return this.call<boolean>('answerCallbackQuery', body)
  }

  /**
   * Send a chat action such as `typing`; Telegram shows it briefly while a
   * real message is on the way.
   * @param chatId - target chat id.
   * @param action - the action name (for example `typing`).
   * @returns whether the action was accepted.
   */
  sendChatAction(chatId: number, action: string): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action })
  }
}