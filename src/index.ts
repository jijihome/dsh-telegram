/**
 * dsh-telegram entry point.
 *
 * A Telegram bridge for DeepSeek Harness (dsh): multi-bot long polling,
 * per-chat agent sessions, and full session-process streaming (text /
 * reasoning / tool deltas) forwarded into Telegram in real time.
 *
 * Multi-bot strict tenancy: every bot is resolved into its own `BotScope`
 * (authorization, model default, workspace roots, proxy, data dir, host-session
 * visibility, ops rights) and its own `StateStore`; nothing downstream reads
 * shared plugin config. Cross-bot session sharing and bare-chat bindings are
 * rejected at activation unless explicitly opted in.
 *
 * Verified probe facts this plugin builds on (dsh 0.1.2-rc.1, headless):
 * - `ctx.agents` is available; `ctx.agents.create` / `ctx.agents.resume`
 *   provide the agent handles.
 * - `session/event` (global listener) carries the whole lifecycle, including
 *   `assistant/chunk` events whose `data.chunk` is a StreamChunk
 *   (text-delta / reasoning-delta / tool-call-delta) — our streaming source.
 * - `typertGateway` RPC methods do NOT exist on headless profiles, so the
 *   plugin never depends on them.
 *
 * @module telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, type TelegramConfig } from './config.js'
import { DshAgentFactory } from './harness/agent-factory.js'
import { StreamListener } from './harness/stream-listener.js'
import { SessionManager, preferSession } from './core/session-manager.js'
import { StateStore, migrateLegacyState, botDataDir, type ChatState } from './core/state-store.js'
import { assertSessionOwnership, resolveBotScopes, routeKey, type BotScope } from './core/bot-scope.js'
import { BotManager, normalizeBots } from './telegram/bot-manager.js'
import type { MenuCtx } from './telegram/menu.js'
import { Delivery } from './telegram/delivery.js'
import { getHostInfo, scheduleRestart } from './core/host.js'
import { readHostDefaultModel, resolveDshHome } from './core/host-default-model.js'
import { join } from 'node:path'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

export { Config }
export type { TelegramConfig }
export { BotManager, normalizeBots } from './telegram/bot-manager.js'
export { StreamListener } from './harness/stream-listener.js'
export { DshAgentFactory } from './harness/agent-factory.js'
export type { AgentFactoryLike } from './harness/agent-factory.js'
export { SessionManager } from './core/session-manager.js'
export { StateStore, migrateLegacyState, stateFilePath, botDataDir } from './core/state-store.js'
export { resolveBotScopes, assertSessionOwnership, routeKey } from './core/bot-scope.js'
export type { BotScope } from './core/bot-scope.js'
export { readHostDefaultModel, parseAgentDefaultModel, resolveDshHome } from './core/host-default-model.js'
export { getHostInfo, scheduleRestart } from './core/host.js'
export { normalizeChunk, normalizeSessionEvent } from './core/event-normalizer.js'
export type { NormalizedMessage, TerminalStatus } from './core/event-normalizer.js'
export { markdownToHtml, splitMessage, escapeHtml } from './core/format.js'
export { renderMessage, renderStatus } from './core/renderer.js'
export type { RenderState } from './core/renderer.js'

/** Services the plugin depends on at runtime. */
export const inject = ['agents']

/** Plugin activation. */
export function apply(ctx: Context, config: TelegramConfig) {
  // Resolve the bot list: `bots[]` or the single bare `token`.
  const bots = normalizeBots(config.bots, config.token)
  const defaultCwd = process.cwd()
  // DSH home: holds settings.yaml (host default model) and the profile stores.
  const dshHome = resolveDshHome(join(homedir(), '.dsh'))

  // Direct-to-stderr logger so daemon diagnostics survive any Cordis log
  // routing/filtering in headless profiles.
  const line = (...parts: unknown[]) => process.stderr.write(`[dsh-telegram] ${parts.join(' ')}\n`)
  const logger = { warn: (...a: unknown[]) => line('WARN', ...a), error: (...a: unknown[]) => line('ERROR', ...a) }

  // Isolation domains: unique ids + unique tokens, per-bot policy; fails loud.
  // The machine-wide proxy (`TELEGRAM_PROXY` / `HTTPS_PROXY`) is the last-resort
  // source, so a deployment that never pinned `proxy:` in config still reaches
  // Telegram instead of timing out on a direct connection.
  const envProxy = process.env.TELEGRAM_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  const scopes = resolveBotScopes(bots, config, defaultCwd, envProxy)
  const scopeById = new Map(scopes.map(scope => [scope.botId, scope]))
  // A DSH session may be driven by exactly one bot unless both opted in.
  assertSessionOwnership(scopes)
  for (const scope of scopes) {
    if (scope.proxy !== undefined) {
      const source = scope.botId !== '' && config.bots.find(b => b.id === scope.botId)?.proxy !== undefined
        ? 'bot 配置'
        : config.proxy !== undefined ? '插件配置' : '环境变量'
      line('WARN', `bot "${scope.botId}" Telegram 流量将经代理: ${scope.proxy} (来源 ${source})`)
    } else {
      line('WARN', `bot "${scope.botId}" 未配置 Telegram 代理(直连 api.telegram.org)`)
    }
  }
  logger.warn(`多 Bot 严格隔离已启用:${scopes.map(s => s.botId).join(', ')}`)

  // One-time migration of the pre-isolation shared state file into per-bot
  // files (per dataDir; ambiguous bare keys abort activation).
  const dataDirBots = new Map<string, string[]>()
  for (const scope of scopes) {
    const list = dataDirBots.get(scope.dataDir) ?? []
    list.push(scope.botId)
    dataDirBots.set(scope.dataDir, list)
  }
  for (const [dir, ids] of dataDirBots) {
    const report = migrateLegacyState(dir, ids, logger)
    if (report.backup !== undefined) logger.warn(`旧共享状态已备份: ${report.backup}`)
  }

  // One isolated state store per bot (its own file, plus a cross-bot key guard).
  const stores = new Map<string, StateStore>()
  for (const scope of scopes) {
    // Ensure the bot's private data dir exists so its state file and forward log
    // are actually writable (a missing dir would silently drop the log).
    try {
      mkdirSync(botDataDir(scope.dataDir, scope.botId), { recursive: true })
    } catch (error) {
      logger.error(`无法创建 bot "${scope.botId}" 的数据目录: ${String(error)}`)
    }
    stores.set(scope.botId, new StateStore({ dataDir: scope.dataDir, botId: scope.botId }))
  }

  /**
   * Read-only view of the host default model (`agent-default-model`) — the same
   * default the GUI itself uses. A bot without an explicit provider/model follows
   * it, so a bot continues the conversation on a working model instead of a
   * hardcoded plugin default. The plugin never WRITES this selection, so a bot's
   * model choice can never leak into another bot or the GUI.
   *
   * Source order: the persisted `settings.yaml` first (authoritative — the GUI
   * model picker writes it), then the runtime service as a fallback. The service
   * alone is not trustworthy here: during activation it reported its built-in
   * default (deepseek-official) while the configured model was command-code,
   * which pointed every bot at a provider with no balance.
   */
  const readDefaultSelection = (): { provider: string; model: string } | undefined => {
    const fromSettings = readHostDefaultModel(dshHome)
    if (fromSettings !== undefined) return fromSettings
    try {
      const adm = (ctx.get as (k: string) => unknown)?.('agentDefaultModel') as
        { currentSelection?(): { provider?: string; model?: string } } | undefined
      const selection = adm?.currentSelection?.()
      if (selection?.provider === undefined || selection?.model === undefined) return undefined
      return { provider: selection.provider, model: selection.model }
    } catch {
      return undefined
    }
  }

  /**
   * Model recorded on a session that has no live agent yet, read from the host's
   * session projection cache (`session_projcache`). It makes the status panel show
   * the inherited conversation model right after a restart instead of the
   * deployment default — without waiting for the first message to spin the agent up.
   */
  const readSessionModelFromCache = (sessionId: string): { provider: string; model: string } | undefined => {
    const pick = (value: unknown): { provider: string; model: string } | undefined => {
      if (value === null || typeof value !== 'object') return undefined
      const record = value as { provider?: unknown; model?: unknown }
      if (typeof record.provider !== 'string' || record.provider === '') return undefined
      if (typeof record.model !== 'string' || record.model === '') return undefined
      return { provider: record.provider, model: record.model }
    }
    try {
      const file = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as
        { record?: { rows?: { modelSelection?: { val?: { next?: unknown; lastUsed?: unknown } } } } } | null
      const view = parsed?.record?.rows?.modelSelection?.val
      return pick(view?.next) ?? pick(view?.lastUsed)
    } catch {
      return undefined
    }
  }

  const factory = new DshAgentFactory(ctx)
  const sessions = new SessionManager({
    factory,
    stores,
    scopes: scopeById,
    defaultCwd,
    defaultSelection: readDefaultSelection,
    sessionModelLookup: readSessionModelFromCache,
    logger,
  })

  // Announce which model each bot will use, so a mis-configured provider shows up
  // in the daemon log instead of only as a failed turn in Telegram.
  const hostDefault = readDefaultSelection()
  const modelSource = readHostDefaultModel(dshHome) !== undefined ? 'settings.yaml' : 'agentDefaultModel 服务'
  for (const scope of scopes) {
    const effective = scope.modelPinned
      ? `${scope.provider}/${scope.model} (本 Bot 固定)`
      : hostDefault !== undefined
        ? `${hostDefault.provider}/${hostDefault.model} (跟随宿主默认,来源 ${modelSource})`
        : `${scope.provider}/${scope.model} (宿主默认不可用,已回退)`
    logger.warn(`bot "${scope.botId}" 模型: ${effective}`)
  }
  // Announce the EFFECTIVE authorization/ops policy per bot: it makes a config
  // that never reached the plugin distinguishable from a genuine id mismatch.
  for (const scope of scopes) {
    logger.warn(
      `bot "${scope.botId}" 授权: allowAllUsers=${scope.allowAllUsers}`
      + ` allowedUserIds=[${scope.allowedUserIds.join(',')}]`
      + ` allowOpsRestart=${scope.allowOpsRestart} allowHostSessions=${scope.allowHostSessions}`,
    )
  }

  // Per-bot config session bindings (chat ↔ existing DSH session). Conflicts
  // between bots are refused here, which aborts activation on purpose. The config
  // value SEEDS the chat: a session the operator picked later (persisted in the
  // chat state) wins, so a restart no longer throws that choice away.
  const seedBinding = (chatId: number, botId: string, sessionId: string): void => {
    const owner = botId === '' ? scopes[0]!.botId : botId
    const persisted = stores.get(owner)?.getChat(routeKey(owner, chatId))?.sessionId
    const target = preferSession(sessionId, persisted)
    if (target !== sessionId) {
      logger.warn(`bot "${owner}" chat ${chatId} 沿用上次选择的会话 ${target}(未使用配置绑定 ${sessionId})`)
    }
    sessions.bind(chatId, botId, target, defaultCwd)
  }
  for (const scope of scopes) {
    for (const [chatId, sessionId] of Object.entries(scope.bindings)) {
      const id = Number(chatId)
      if (!Number.isFinite(id)) {
        throw new Error(`dsh-telegram: bot "${scope.botId}" 的 bindings 键 "${chatId}" 不是合法 chatId`)
      }
      seedBinding(id, scope.botId, sessionId)
    }
  }
  // Legacy top-level `bindings`: `botId:chatId` composite (exact) or bare
  // chatId (single-bot only; `bind` throws with multiple bots).
  for (const [key, sessionId] of Object.entries(config.bindings ?? {})) {
    const sep = key.lastIndexOf(':')
    const isComposite = sep > 0 && /^\d+$/.test(key.slice(sep + 1))
    if (isComposite) {
      const id = Number(key.slice(sep + 1))
      const botId = key.slice(0, sep)
      if (!scopeById.has(botId)) {
        throw new Error(`dsh-telegram: 旧 bindings 键 "${key}" 引用了未配置的 bot "${botId}"`)
      }
      seedBinding(id, botId, sessionId)
    } else {
      const id = Number(key)
      if (!Number.isFinite(id)) {
        throw new Error(`dsh-telegram: 旧 bindings 键 "${key}" 不是合法 chatId`)
      }
      seedBinding(id, '', sessionId)
    }
  }

  // Stream listener: routes session events to the right bot's delivery.
  const deliveries = new Map<string, Delivery>()
  const listener = new StreamListener({ ctx, sessions, deliveries, logger })

  /** Read the host session roster (titles/cwd) without exposing it by itself. */
  const hostSessionRoster = async (): Promise<Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }>> => {
    const out: Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }> = []
    const seen = new Set<string>()
    // Skip sub-agent sessions: they are child turns, not user-facing
    // conversations, so they should not appear in the sessions picker.
    const isSubagent = (s: { origin?: unknown }) => s?.origin === 'subagent'
    const push = (s: { id?: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number; origin?: unknown } | undefined) => {
      if (s === undefined || !s.id || seen.has(s.id) || isSubagent(s)) return
      seen.add(s.id)
      out.push({
        id: s.id,
        cwd: s.cwd,
        title: s.title,
        displayTitle: s.displayTitle ?? s.title ?? s.id,
        updatedAt: s.updatedAt ?? 0,
      })
    }
    // 1) Typert gateway RPC: session.list -> { items: [ { sessionId, cwd?,
    //    updatedAt, projections: { values: { title } } } ] } (dsh-im's channel).
    try {
      const gw = (ctx.get as (k: string) => unknown)?.('typertGateway') as
        { invoke?(opts: { namespace: string; method: string; args?: unknown }): Promise<{ items?: Array<{ sessionId?: string; cwd?: string; updatedAt?: number; origin?: unknown; projections?: { values?: { title?: string } } }> }> } | undefined
      if (gw?.invoke !== undefined) {
        for (const ns of ['session', 'sessions'] as const) {
          const value = await gw.invoke({ namespace: ns, method: 'list', args: {} })
          const items = value?.items ?? []
          for (const it of items) {
            push({ id: it?.sessionId, cwd: it?.cwd, title: it?.projections?.values?.title, updatedAt: it?.updatedAt, origin: it?.origin })
          }
          if (items.length > 0) break
        }
      }
    } catch { /* continue */ }
    // 2) Direct persistence fallback: read the session cache files so the
    //    list never empties even when the runtime channel is unavailable.
    //    Home resolution falls back to `~/.dsh` (same $DSH_HOME caveat as
    //    listWorkspaces above) so the session roster is still found.
    if (out.length === 0) {
      try {
        const home = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? join(homedir(), '.dsh')
        if (home !== '') {
          const sdir = join(home, 'storages', 'session_projcache', 'sessions')
          for (const name of readdirSync(sdir)) {
            if (!name.endsWith('.json')) continue
            let parsed: { record?: { identity?: { cwd?: string; createdAt?: number }; rows?: { title?: { val?: unknown }; sessionListMetadata?: { val?: { lastPromptAt?: number } } } } } | null
            try { parsed = JSON.parse(readFileSync(join(sdir, name), 'utf8')) } catch { continue }
            const rec = parsed?.record
            const id = name.slice(0, -5)
            const title = typeof rec?.rows?.title?.val === 'string' ? rec.rows.title.val : undefined
            const updatedAt = rec?.rows?.sessionListMetadata?.val?.lastPromptAt ?? rec?.identity?.createdAt
            push({ id, cwd: rec?.identity?.cwd, title, displayTitle: title ?? id, updatedAt })
          }
        }
      } catch { /* best-effort */ }
    }
    return out
  }

  /**
   * Build the menu context for one (chat, bot) pair. Every capability is bound
   * to that bot's scope and store, so a menu action can only ever touch its own
   * tenant — host-wide visibility requires `allowHostSessions`.
   */
  const menuCtxFor = (chatId: number, botId: string): MenuCtx => {
    const scope = scopeById.get(botId)
    const store = stores.get(botId)
    if (scope === undefined || store === undefined) {
      throw new Error(`dsh-telegram: 菜单上下文缺少 bot "${botId}" 的隔离域`)
    }
    return {
      chatId,
      botId,
      delivery: deliveries.get(botId) as never,
      sessions,
      store,
      workspaceRoots: scope.workspaceRoots,
      defaultCwd,
      provider: scope.provider,
      model: scope.model,
      // Filled per-callback by the bot manager (authorization).
      userId: 0,
      canOperate: false,
      getHostInfo,
      restartDsh: () => {
        if (!scope.allowOpsRestart) {
          return '⛔ 本 Bot 无权重启宿主 DSH(重启会同时停掉所有 Bot);如需开启,给该 Bot 设置 allowOpsRestart: true。'
        }
        try {
          scheduleRestart({ delayMs: 3000 })
          return '🔄 已请求重启 DSH,约 3 秒后自动重启(宿主进程将被重建)。'
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `❌ 重启请求失败: ${msg}`
        }
      },
      getCurrentModel: () => sessions.modelFor(chatId, botId),
      // Source-aware view for the status panel: after switching sessions the model
      // shown is the one that conversation continues with, not a stale pick.
      getModelInfo: () => sessions.modelInfo(chatId, botId),
      listModels: async () => {
        const llm = (ctx.get as (k: string) => unknown)?.('llm') as
          { listProviders?(): Promise<Array<{ id?: string; name?: string }>>; listModels?(provider: string): Promise<Array<{ provider?: string; id?: string; name?: string }>> } | undefined
        if (llm?.listModels === undefined) return []
        const out: Array<{ provider: string; model: string }> = []
        let providers: Array<{ id?: string; name?: string }> = []
        try { providers = (await llm.listProviders?.()) ?? [] } catch { providers = [] }
        const ids: string[] = providers.length > 0 ? providers.map(p => p.id ?? p.name).filter((x): x is string => Boolean(x)) : [scope.provider]
        for (const id of ids) {
          try {
            const ms = await llm.listModels(id)
            for (const m of (Array.isArray(ms) ? ms : [])) {
              out.push({ provider: m.provider ?? id, model: m.id ?? m.name ?? id })
            }
          } catch { /* a provider that cannot enumerate models is skipped */ }
        }
        return out
      },
      setModel: async (provider, model) => {
        // Per-route only: never touches the host-global default model.
        sessions.setModel(chatId, botId, provider, model)
      },
      listPresets: async () => {
        const ap = (ctx.get as (k: string) => unknown)?.('agentPresets') as
          { list?(): Promise<Array<{ id: string; name?: string }>> } | undefined
        if (ap?.list === undefined) return []
        try {
          const presets = await ap.list()
          return Array.isArray(presets)
            ? presets.map(p => ({ id: p.id, name: p.name ?? p.id }))
            : []
        } catch { return [] }
      },
      /**
       * Display name of the currently-effective work mode: the chat's chosen
       * preset name when it was switched, else the deployment-default preset's
       * name. Mirrors dsh-im's host pattern: `agentPresets.list()` returns the
       * raw roster (each row carries `id`/`name`), and `agentPresets.defaultId`
       * (a getter = settings.default ?? config.default) names the default row.
       * `list()` does NOT carry `isDefault` — that only exists on the host
       * projection (`remoteExportList`) — so the default is matched by id.
       */
      getCurrentPresetName: async () => {
        const current = store.getChat(routeKey(botId, chatId))
        const selected = current?.agentPreset
        let norm: Array<{ id: string; name: string }> = []
        try {
          const ap = (ctx.get as (k: string) => unknown)?.('agentPresets') as
            { list?(): Promise<Array<{ id: string; name?: string }>> } | undefined
          const presets = (await ap?.list?.()) ?? []
          norm = Array.isArray(presets) ? presets.map(p => ({ id: p.id, name: p.name ?? p.id })) : []
        } catch { norm = [] }
        const chosen = selected !== undefined ? norm.find(p => p.id === selected) : undefined
        if (chosen !== undefined) return chosen.name
        // No per-chat selection: fall to the deployment-default preset's name.
        let defaultId: string | undefined
        try {
          const ap = (ctx.get as (k: string) => unknown)?.('agentPresets') as
            { defaultId?: string } | undefined
          defaultId = ap?.defaultId
        } catch { defaultId = undefined }
        const def = defaultId !== undefined ? norm.find(p => p.id === defaultId) : undefined
        return def?.name ?? defaultId ?? '默认'
      },
      /**
       * Current work-mode preset id: the chat's selected preset when it was
       * switched, else the deployment-default preset id. Used by the preset
       * submenu to mark the active row. Returns '' when no default is known.
       */
      getCurrentPresetId: async () => {
        const current = store.getChat(routeKey(botId, chatId))
        if (current?.agentPreset !== undefined && current.agentPreset !== '') return current.agentPreset
        try {
          const ap = (ctx.get as (k: string) => unknown)?.('agentPresets') as
            { defaultId?: string } | undefined
          return ap?.defaultId ?? ''
        } catch { return '' }
      },
      setPreset: async (id) => {
        // Presets shape the agent at creation time; switching records the choice
        // so the next fresh session composes with it. A live runtime swap on a
        // running agent is a later refinement.
        sessions.setPreset(chatId, botId, id)
      },
      listWorkspaces: async () => {
        const set = new Set<string>([defaultCwd, ...scope.workspaceRoots])
        // Host-wide workspaces (GUI registry, other bots' sessions) are only
        // revealed when this bot explicitly opted in.
        if (!scope.allowHostSessions) return [...set]
        try {
          const gw = (ctx.get as (k: string) => unknown)?.('typertGateway') as
            { invoke?(opts: { namespace: string; method: string; args?: unknown }): Promise<{ items?: Array<{ path?: string }> }> } | undefined
          if (gw?.invoke !== undefined) {
            for (const ns of ['workspace', 'workspaces'] as const) {
              const value = await gw.invoke({ namespace: ns, method: 'list', args: {} })
              const items = value?.items ?? []
              for (const it of items) if (typeof it?.path === 'string' && it.path) set.add(it.path)
              if (items.length > 0) break
            }
          }
        } catch { /* continue */ }
        try {
          const home = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? join(homedir(), '.dsh')
          if (home !== '') {
            const wsFile = join(home, 'storages', 'workspace.json')
            const parsed = JSON.parse(readFileSync(wsFile, 'utf8')) as
              { tables?: { workspaces?: Record<string, { path?: string }> } } | null
            for (const ws of Object.values(parsed?.tables?.workspaces ?? {})) {
              if (typeof ws?.path === 'string' && ws.path) set.add(ws.path)
            }
          }
        } catch { /* best-effort */ }
        try {
          const sessionsSvc = (ctx.get as (k: string) => unknown)?.('sessions') as
            { list?(): Promise<Array<{ cwd?: string }>> } | undefined
          const list = await sessionsSvc?.list?.()
          for (const s of (list ?? [])) {
            if (typeof s.cwd === 'string' && s.cwd) set.add(s.cwd)
          }
        } catch { /* best-effort; fall back to the configured roots */ }
        return [...set]
      },
      listSessions: async () => {
        const owned = sessions.sessionIdsFor(botId)
        const roster = await hostSessionRoster()
        if (scope.allowHostSessions) return roster
        // Strict default: only sessions this bot owns (its own agents, its
        // config bindings, and chats it persisted). Foreign sessions are hidden.
        const out = roster.filter(s => owned.has(s.id))
        const seen = new Set(out.map(s => s.id))
        for (const id of owned) {
          if (seen.has(id)) continue
          const state = Object.values(store.allChats()).find(c => c.sessionId === id)
          out.push({ id, cwd: state?.cwd, displayTitle: id, updatedAt: 0 })
        }
        return out
      },
      /**
       * Switch this chat to an existing DSH session. Strict isolation: the
       * session must already belong to this bot unless `allowHostSessions` is on.
       */
      switchSession: async (sessionId, cwd) => {
        if (!scope.allowHostSessions && !sessions.ownsSession(botId, sessionId)) {
          throw new Error(
            `会话 ${sessionId} 不属于 bot "${botId}";严格隔离下不能附加到其他 Bot/GUI 的会话。`
            + '如确需,给该 Bot 设置 allowHostSessions: true。',
          )
        }
        sessions.bind(chatId, botId, sessionId, cwd ?? defaultCwd)
        sessions.setCwd(chatId, botId, cwd ?? defaultCwd)
      },
      // This chat's effective working directory: the persisted choice takes
      // precedence over the process cwd, so a workspace switch survives the
      // /new and a DSH restart. Read from this bot's own store only.
      currentCwd: () => store.getChat(routeKey(botId, chatId))?.cwd ?? defaultCwd,
      setCurrentCwd: (cwd) => {
        sessions.setCwd(chatId, botId, cwd)
      },
    }
  }

  // Bot manager: owns clients, polls, deliveries — one runtime per scope.
  const manager = new BotManager({
    scopes,
    sessions,
    pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
    maxMessageLength: config.maxMessageLength ?? 4096,
    defaultCwd,
    menuCtxFor,
    logger,
  })

  // Wire the StreamListener's delivery map to the runtimes once started.
  const attachDeliveries = () => {
    for (const [id, runtime] of manager.all) {
      deliveries.set(id, runtime.delivery)
    }
  }

  listener.start()
  manager.start()
  attachDeliveries()

  // Persist offsets periodically (debounced) and on unload — each bot into its
  // own file through its own store.
  const flushTimer = setInterval(() => {
    for (const [id, runtime] of manager.all) {
      try {
        // Only persist a cursor that exists: before the bot's first successful
        // getUpdates the cursor is undefined, and writing it would erase the
        // restored offset (Telegram would re-deliver old updates next restart).
        const offset = runtime.poll.currentOffset
        if (offset !== undefined) stores.get(id)?.setOffset(id, offset)
        stores.get(id)?.flush()
      } catch (error) {
        logger.warn(`offset flush failed for ${id}: ${String(error)}`)
      }
    }
  }, 5000)
  // Headless exits as soon as its task settles. Keep one ref'ed timer while
  // enabled so Telegram long polling remains a daemon after the initial task.
  const keepAliveTimer = config.keepAlive === false ? undefined : setInterval(() => {}, 60_000)

  ctx.effect(() => {
    return () => {
      clearInterval(flushTimer)
      if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer)
      listener.stop()
      void manager.stop().finally(() => {
        for (const scope of scopes) stores.get(scope.botId)?.flush()
      })
      void sessions.disposeAll()
    }
  }, 'dsh-telegram.serve')
}

/** Re-exported for consumers that only need the per-chat state shape. */
export type { ChatState }
