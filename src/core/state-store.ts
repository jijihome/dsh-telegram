/**
 * State store: persists the chat↔session mapping, per-chat cwd, and the
 * long-poll offset cursor for one bot as JSON.
 *
 * Multi-bot isolation: each bot owns a **separate file** under
 * `<dataDir>/bots/<botId>/state.json`. When a `botId` is supplied the store also
 * enforces a write/read guard — every key must be namespaced with that same
 * `botId` prefix, so a routing bug can never read or clobber another bot's chat
 * binding (it throws instead of silently crossing tenants).
 *
 * Writes are atomic-ish: JSON.stringify then rename (windows guard: write to a
 * temp file and replace). The in-memory map is the source of truth while running.
 *
 * @module core/state-store
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Persisted per-chat binding. */
export interface ChatState {
  /** DSH session id bound to this Telegram chat. */
  sessionId: string
  /** Working directory the agent uses for this chat. */
  cwd: string
  /** Bot id that owns this chat. */
  botId: string
  /** Per-chat model override; falls back to the owning bot's default. */
  provider?: string
  /** Per-chat model id override; falls back to the owning bot's default. */
  model?: string
  /**
   * Session the model override was chosen on. The override applies only while
   * this chat still drives that session, so switching to another conversation
   * surfaces that conversation's own (inherited) model again.
   */
  modelSessionId?: string
  /** Per-chat work-mode preset id (applied when a fresh session is created). */
  agentPreset?: string
}

interface PersistedState {
  chats: Record<string, ChatState>
  /** botId → last acknowledged update offset. */
  offsets: Record<string, number | undefined>
}

export interface StateStoreOptions {
  /** Root directory holding the per-bot state (default `<cwd>/data`). */
  dataDir: string
  /**
   * Owning bot id. When set, the store reads/writes only
   * `<dataDir>/bots/<botId>/state.json` and rejects any key that is not
   * namespaced with this bot's id.
   */
  botId?: string
}

/** Path of one bot's state file (single source of truth for the layout). */
export function stateFilePath(dataDir: string, botId: string): string {
  return join(dataDir, 'bots', botId, 'state.json')
}

/** Root of one bot's private data (state + forward log). */
export function botDataDir(dataDir: string, botId: string): string {
  return join(dataDir, 'bots', botId)
}

/** JSON-backed persistence for chat↔session bindings and poll offsets. */
export class StateStore {
  private readonly file: string
  private readonly botId: string | undefined
  private readonly chatStates: Record<string, ChatState> = {}
  private readonly offsets: Record<string, number | undefined> = {}
  private dirty = false

  constructor(options: StateStoreOptions) {
    this.botId = options.botId
    this.file = options.botId !== undefined
      ? stateFilePath(options.dataDir, options.botId)
      : join(options.dataDir, 'state.json')
    this.load()
  }

  /** Path of the backing file (diagnostics / migration). */
  get path(): string {
    return this.file
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      if (parsed.chats !== undefined) Object.assign(this.chatStates, parsed.chats)
      if (parsed.offsets !== undefined) Object.assign(this.offsets, parsed.offsets)
    } catch {
      // Fresh install or corrupt file: start empty.
    }
  }

  /**
   * Reject a key that is not namespaced with this store's bot.
   * @throws when a namespaced store is handed a foreign or unprefixed key.
   */
  private assertKey(key: string): void {
    if (this.botId === undefined) return
    if (!key.startsWith(`${this.botId}:`)) {
      throw new Error(
        `dsh-telegram: 状态键跨 Bot 越界 — store(${this.botId}) 收到键 "${key}";`
        + '严格隔离下每个 store 只能读写自己的 "<botId>:<chatId>" 键。',
      )
    }
  }

  /** Set (or replace) a chat's binding. */
  setChat(key: string, state: ChatState): void {
    this.assertKey(key)
    this.chatStates[key] = state
    this.dirty = true
  }

  /** Remove a chat's binding. */
  removeChat(key: string): void {
    this.assertKey(key)
    delete this.chatStates[key]
    this.dirty = true
  }

  /** Read a chat binding; undefined for new chats. */
  getChat(key: string): ChatState | undefined {
    this.assertKey(key)
    return this.chatStates[key]
  }

  /** All persisted bindings. */
  allChats(): Record<string, ChatState> {
    return { ...this.chatStates }
  }

  /**
   * Remember a bot's last acknowledged update offset.
   *
   * An `undefined` offset is IGNORED rather than stored: the periodic flush runs
   * from plugin start, while the bot's poll cursor is still unset until its first
   * `getUpdates` returns, and writing that `undefined` would erase the restored
   * cursor — Telegram would then re-deliver already-answered updates after the
   * next restart.
   */
  setOffset(botId: string, offset: number | undefined): void {
    if (this.botId !== undefined && botId !== this.botId) {
      throw new Error(`dsh-telegram: offset 越界 — store(${this.botId}) 收到 bot "${botId}" 的 offset`)
    }
    if (offset === undefined) return
    this.offsets[botId] = offset
    this.dirty = true
  }

  /** Last acknowledged offset for a bot; undefined = resume from newest. */
  getOffset(botId: string): number | undefined {
    if (this.botId !== undefined && botId !== this.botId) {
      throw new Error(`dsh-telegram: offset 越界 — store(${this.botId}) 读取 bot "${botId}" 的 offset`)
    }
    return this.offsets[botId]
  }

  /** Persist to disk if dirty (debounced by the caller for hot loops). */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const payload: PersistedState = { chats: this.chatStates, offsets: this.offsets }
    const dir = dirname(this.file)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best effort */
    }
    const tmp = this.file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      try {
        renameSync(tmp, this.file)
      } catch {
        // Windows: rename over existing file may fail; remove then rename.
        rmSync(this.file, { force: true })
        renameSync(tmp, this.file)
      }
    } catch (error) {
      // Never let persistence failures break the bot loop.
      console.error('[dsh-telegram] state flush failed:', error)
    }
  }
}

/** Outcome of an one-time legacy-state migration. */
export interface MigrationReport {
  /** Legacy `<dataDir>/state.json` path when it existed. */
  legacyFile?: string
  /** Bot ids whose per-bot file was written. */
  migrated: string[]
  /** Chat keys dropped because their `botId:` prefix matches no configured bot. */
  orphans: string[]
  /** Where the legacy file was preserved (never deleted). */
  backup?: string
}

/** Composite key `botId:chatId` (botId never contains `:`). */
const COMPOSITE_KEY = /^([^:]+):(\d+)$/
/** Bare `chatId` key (legacy single-bot form). */
const BARE_KEY = /^\d+$/

/**
 * One-time migration from the shared legacy `state.json` into per-bot files.
 *
 * Rules (fail loud, never destructive):
 * - `botId:chatId` keys are routed to their bot's file; prefixes matching no
 *   configured bot are reported as orphans and skipped.
 * - bare `chatId` keys are unambiguous only with a single bot; with two or more
 *   bots the migration **aborts** so the operator assigns an owner explicitly.
 * - the legacy file is renamed to `state.json.migrated-<timestamp>` (a backup
 *   copy is written first); nothing is deleted.
 *
 * @throws when bare chat keys exist while multiple bots are configured.
 */
export function migrateLegacyState(
  dataDir: string,
  botIds: readonly string[],
  logger?: { warn(...args: unknown[]): void },
): MigrationReport {
  const legacyFile = join(dataDir, 'state.json')
  const report: MigrationReport = { migrated: [], orphans: [] }
  if (!existsSync(legacyFile)) return report
  report.legacyFile = legacyFile

  let parsed: Partial<PersistedState>
  try {
    parsed = JSON.parse(readFileSync(legacyFile, 'utf8')) as Partial<PersistedState>
  } catch {
    // Corrupt legacy file: leave it in place and start clean per bot.
    logger?.warn(`[tg] 旧状态文件无法解析,已忽略: ${legacyFile}`)
    return report
  }

  const chatEntries = Object.entries(parsed.chats ?? {})
  const offsets = parsed.offsets ?? {}
  const perBotChats = new Map<string, Record<string, ChatState>>()
  const perBotOffsets = new Map<string, number | undefined>()
  for (const id of botIds) {
    perBotChats.set(id, {})
  }

  const ambiguous: string[] = []
  for (const [key, state] of chatEntries) {
    const composite = COMPOSITE_KEY.exec(key)
    let owner: string | undefined
    if (composite !== null) {
      owner = botIds.includes(composite[1]!) ? composite[1] : undefined
      if (owner === undefined) report.orphans.push(key)
    } else if (BARE_KEY.test(key)) {
      if (botIds.length === 1) owner = botIds[0]
      else ambiguous.push(key)
    } else {
      report.orphans.push(key)
    }
    if (owner === undefined) continue
    // Per-bot files always use canonical `<botId>:<chatId>` keys, so a legacy
    // bare chatId is renamed on the way in.
    const targetKey = composite !== null ? key : `${owner}:${key}`
    perBotChats.get(owner)![targetKey] = { ...state, botId: owner }
  }

  if (ambiguous.length > 0) {
    throw new Error(
      `dsh-telegram: 旧状态文件含裸 chatId 键,但配置了 ${botIds.length} 个 Bot,无法判断归属:\n- `
      + ambiguous.join('\n- ')
      + `\n文件: ${legacyFile}\n修法:手工把键改写为 "<botId>:<chatId>"(可用 Bot id: ${botIds.join(', ')}),或删除该文件重新开始。`,
    )
  }

  for (const [botId, offset] of Object.entries(offsets)) {
    if (botIds.includes(botId)) perBotOffsets.set(botId, offset)
  }
  for (const key of report.orphans) {
    if (COMPOSITE_KEY.test(key)) logger?.warn(`[tg] 迁移跳过未知 Bot 的旧状态键: ${key}`)
  }

  // Write per-bot files first; only then retire the legacy file.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const id of botIds) {
    const chats = perBotChats.get(id)!
    const offset = perBotOffsets.get(id)
    const hasOffset = perBotOffsets.has(id)
    if (Object.keys(chats).length === 0 && !hasOffset) continue
    const store = new StateStore({ dataDir, botId: id })
    for (const [key, state] of Object.entries(chats)) store.setChat(key, state)
    if (hasOffset) store.setOffset(id, offset)
    store.flush()
    report.migrated.push(id)
  }

  try {
    report.backup = `${legacyFile}.backup-${stamp}`
    copyFileSync(legacyFile, report.backup!)
    renameSync(legacyFile, `${legacyFile}.migrated-${stamp}`)
  } catch (error) {
    logger?.warn(`[tg] 旧状态文件归档失败(已迁移,原文件保留): ${String(error)}`)
  }
  if (report.migrated.length > 0) {
    logger?.warn(`[tg] 已迁移旧共享状态到 per-bot 文件: ${report.migrated.join(', ')}`)
  }
  return report
}
