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
import { assertSessionOwnership, resolveBotScopes, joinDefaultDataDir, routeKey, type BotScope } from './core/bot-scope.js'
import { BotManager, normalizeBots } from './telegram/bot-manager.js'
import type { MenuCtx } from './telegram/menu.js'
import { Delivery } from './telegram/delivery.js'
import { getHostInfo, scheduleRestart, readRestartMarker, clearRestartMarker, readHostInstance, writeHostInstance, resolveRestartNotice } from './core/host.js'
import { readHostDefaultModel, resolveDshHome } from './core/host-default-model.js'
import { registerInteractions } from './interactions/interaction-listener.js'
import { isUserFacingSessionId, workspaceMemberIdsToAdd } from './core/session-visibility.js'
import { indexSessionLogs, readSessionSummary, encodeSessionId } from './core/session-log.js'
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
export { getHostInfo, scheduleRestart, readRestartMarker, clearRestartMarker } from './core/host.js'
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
  // Cross-bot shared data root: holds the one-shot restart marker. Must match
  // bot-scope's resolution (`config.dataDir` or `<DSH_HOME>/plugin-data/dsh-telegram`)
  // exactly, or the restart write and the boot-time "已上线" broadcast would look
  // in different directories and the marker could never be found.
  const dataDirRoot = () => config.dataDir ?? joinDefaultDataDir(defaultCwd)

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
  // GUI 工作区侧栏按工作区注册表的 sessionIds 名单分组；agents.create 只写会话头
  // cwd、不进名单。fresh 建会话后把 session 挂到 cwd 对应的工作区，否则 GUI 显示
  // 在「未分组」。（服务名 workspaceRegistry；结构化类型，宿主未启用时静默跳过。）
  type WorkspaceLike = { path: string; attachSession(sessionId: string): Promise<void> }
  type WorkspaceRegistryLike = {
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
    create(path: string, title?: string): Promise<WorkspaceLike>
  }
  const attachToWorkspace = async (sessionId: string, cwd: string): Promise<void> => {
    try {
      // Service LOCATOR (ctx.get), not property access: `ctx.workspaceRegistry`
      // throws "cannot get property without inject", and injecting it would make
      // the whole plugin depend on the workspace package being installed.
      const registry = (ctx.get as (k: string) => unknown)?.('workspaceRegistry') as
        WorkspaceRegistryLike | undefined
      if (registry === undefined) {
        line('WARN', `[tg] 宿主未启用 workspaceRegistry,会话 ${sessionId} 将显示在未分组`)
        return
      }
      // 目录已是注册工作区则直接用；未注册则注册之(GUI 的「添加工作区」等效)。
      const existing = await registry.resolveByPath(cwd).catch(() => undefined)
      const workspace = existing ?? await registry.create(cwd)
      await workspace.attachSession(sessionId)
      line('WARN', `[tg] 已把会话 ${sessionId} 挂到工作区 ${workspace.path}`)
    } catch (error) {
      line('WARN', `[tg] 工作区挂载失败(非致命) ${sessionId}: ${String(error)}`)
    }
  }
  const sessions = new SessionManager({
    factory,
    stores,
    scopes: scopeById,
    defaultCwd,
    defaultSelection: readDefaultSelection,
    sessionModelLookup: readSessionModelFromCache,
    attachWorkspace: attachToWorkspace,
    // Host default agent preset (settings `agentPresets.default`). Sessions built
    // without a preset have an empty tool world, so fresh creates always carry one.
    defaultPresetId: () => {
      try {
        const ap = (ctx.get as (k: string) => unknown)?.('agentPresets') as { defaultId?: string } | undefined
        return ap?.defaultId
      } catch { return undefined }
    },
    logger,
  })

  // 启动补挂：把各 bot 状态里已记录的 (sessionId, cwd) 也挂进工作区（幂等），
  // 让历史 telegram 会话从「未分组」归位。延迟执行等 workspaceRegistry 就绪。
  const sweepTimer = setTimeout(() => {
    for (const scope of scopes) {
      const store = stores.get(scope.botId)
      if (store === undefined) continue
      for (const chat of Object.values(store.allChats())) {
        if (chat.sessionId === undefined || chat.sessionId === '' || chat.cwd === undefined || chat.cwd === '') continue
        void attachToWorkspace(chat.sessionId, chat.cwd)
      }
    }
  }, 2000)
  sweepTimer.unref?.()

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
  const listener = new StreamListener({
    ctx,
    sessions,
    deliveries,
    logger,
    notifyEnd: config.notifyEnd ?? true,
    stallNoticeMs: config.stallNoticeMs ?? 120000,
  })

  /**
   * Read the host session roster (titles/cwd).
   *
   * BOTH sources are always merged, keyed by session id:
   * - the persisted projection cache is the authority for `cwd` (the menu scopes
   *   the list by working directory), and
   * - the typert gateway is the authority for live titles / recency.
   *
   * They used to be mutually exclusive, and the gateway wins on web: whenever its
   * items carried no `cwd`, the directory scope matched nothing, the menu silently
   * fell back to "all sessions", and switching the working directory looked like a
   * no-op (the reported bot-a/bot-b asymmetry: the bot whose active session came
   * from the list looked fine).
   */
  const hostSessionRoster = async (): Promise<Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }>> => {
    interface RosterEntry { id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }
    const byId = new Map<string, RosterEntry>()
    // Skip sub-agent sessions: they are child turns, not user-facing
    // conversations, so they should not appear in the sessions picker. The raw
    // projection cache exposes no `origin`, hence the id-shape filter below.
    const isSubagent = (s: { origin?: unknown }) => s?.origin === 'subagent'
    // Archived sessions are hidden by the GUI too; mirror that here.
    const archived = (() => {
      try {
        const reg = (ctx.get as (k: string) => unknown)?.('workspaceRegistry') as
          { archivedSessionIds?: readonly string[] } | undefined
        return new Set<string>(reg?.archivedSessionIds ?? [])
      } catch { return new Set<string>() }
    })()
    /** Merge one entry, letting a later source only FILL gaps (never erase cwd). */
    const merge = (s: { id?: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number; origin?: unknown } | undefined) => {
      if (s === undefined || !s.id || isSubagent(s) || archived.has(s.id)) return
      const existing = byId.get(s.id)
      byId.set(s.id, {
        id: s.id,
        cwd: existing?.cwd ?? s.cwd,
        title: s.title ?? existing?.title,
        displayTitle: s.displayTitle ?? existing?.displayTitle ?? s.title ?? existing?.title ?? s.id,
        updatedAt: Math.max(existing?.updatedAt ?? 0, s.updatedAt ?? 0),
      })
    }
    // 0) 活会话注册表 + 投影：GUI 读的就是这一层，也是插件自建（telegram:…）会话
    //    唯一有标题/时间的地方；origin 继续用于过滤子代理。
    try {
      const svc = (ctx.get as (k: string) => unknown)?.('sessions') as
        { list?(): Array<{ id?: unknown; header?: { cwd?: string; origin?: unknown } }> } | undefined
      const projections = (ctx.get as (k: string) => unknown)?.('sessionProjections') as
        { stateOf?(session: unknown, key: string): unknown } | undefined
      const projString = (session: unknown, key: string): string | undefined => {
        const state = projections?.stateOf?.(session, key)
        if (typeof state === 'string') return state === '' ? undefined : state
        const val = (state as { val?: unknown } | undefined)?.val
        return typeof val === 'string' && val !== '' ? val : undefined
      }
      const projNumber = (session: unknown, key: string, field: string): number | undefined => {
        const state = projections?.stateOf?.(session, key) as { val?: Record<string, unknown> } | undefined
        const value = state?.val?.[field]
        return typeof value === 'number' ? value : undefined
      }
      for (const s of svc?.list?.() ?? []) {
        const id = typeof s?.id === 'string' ? s.id : undefined
        if (id === undefined) continue
        merge({
          id,
          cwd: s?.header?.cwd,
          title: projString(s, 'title'),
          updatedAt: projNumber(s, 'sessionListMetadata', 'lastPromptAt'),
          origin: s?.header?.origin,
        })
      }
    } catch { /* best-effort: the projection cache below still fills the roster */ }
    // 1) Persisted projection cache: authoritative for cwd (identity.cwd).
    try {
      const sdir = join(dshHome, 'storages', 'session_projcache', 'sessions')
      for (const name of readdirSync(sdir)) {
        if (!name.endsWith('.json')) continue
        let parsed: {
          record?: {
            identity?: { cwd?: string; createdAt?: number; origin?: unknown }
            rows?: {
              title?: { val?: unknown }
              sessionListMetadata?: { val?: { lastPromptAt?: number } }
              modelSelection?: { val?: { next?: unknown; lastUsed?: unknown } }
            }
          }
        } | null
        try { parsed = JSON.parse(readFileSync(join(sdir, name), 'utf8')) } catch { continue }
        const rec = parsed?.record
        const id = name.slice(0, -5)
        // The cache also holds transient CHILD runs (memory-keeper / companion
        // subagents) keyed by a BARE uuid, with no `origin` to test. The GUI hides
        // them; a roster built from these files must too, or the picker lists every
        // child turn as if the user had created it.
        if (!isUserFacingSessionId(id)) continue
        const title = typeof rec?.rows?.title?.val === 'string' ? rec.rows.title.val : undefined
        const updatedAt = rec?.rows?.sessionListMetadata?.val?.lastPromptAt ?? rec?.identity?.createdAt
        merge({ id, cwd: rec?.identity?.cwd, title, displayTitle: title ?? id, updatedAt, origin: rec?.identity?.origin })
      }
    } catch { /* best-effort: the gateway below may still fill the roster */ }
    // 2) Typert gateway RPC: session.list -> { items: [ { sessionId, cwd?,
    //    updatedAt, projections: { values: { title } } } ] } (dsh-im's channel).
    try {
      const gw = (ctx.get as (k: string) => unknown)?.('typertGateway') as
        { invoke?(opts: { namespace: string; method: string; args?: unknown }): Promise<{ items?: Array<{ sessionId?: string; cwd?: string; updatedAt?: number; origin?: unknown; projections?: { values?: { title?: string } } }> }> } | undefined
      if (gw?.invoke !== undefined) {
        for (const ns of ['session', 'sessions'] as const) {
          const value = await gw.invoke({ namespace: ns, method: 'list', args: {} })
          const items = value?.items ?? []
          for (const it of items) {
            merge({ id: it?.sessionId, cwd: it?.cwd, title: it?.projections?.values?.title, updatedAt: it?.updatedAt, origin: it?.origin })
          }
          if (items.length > 0) break
        }
      }
    } catch { /* continue */ }
    return [...byId.values()]
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
          // markerDir must match the "已上线" broadcast hook so the booted host
          // can announce the restart. Cross-bot shared root, not a per-bot dir.
          scheduleRestart({ delayMs: 3000, markerDir: dataDirRoot() })
          return '⏳ 正在重启 DSH…约 10 秒后恢复。重启完成后我会再发一条「已上线」确认。(若超时仍未收到,可能重启失败,请查宿主日志)'
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
        // The GUI groups by the WORKSPACE's sessionIds membership, and
        // plugin-created sessions (`telegram:…`) have no projection-cache entry at
        // all — so a cwd-matched roster alone silently omits them. Add the current
        // directory's workspace members, and drop the archived ones (the GUI hides
        // those too).
        try {
          const chatCwd = store.getChat(routeKey(botId, chatId))?.cwd ?? defaultCwd
          const reg = (ctx.get as (k: string) => unknown)?.('workspaceRegistry') as
            | {
                resolveByPath(path: string): Promise<{ path: string; sessionIds: readonly string[] } | undefined>
                archivedSessionIds?: readonly string[]
              }
            | undefined
          if (reg !== undefined) {
            const archived = new Set<string>(reg.archivedSessionIds ?? [])
            const ws = await reg.resolveByPath(chatCwd).catch(() => undefined)
            const add = workspaceMemberIdsToAdd(new Set(roster.map(s => s.id)), ws?.sessionIds ?? [], archived)
            // 这些会话（多为插件自建）在投影缓存里没有条目：标题/时间改从会话日志取
            // （文件名 mtime = 最后活动，首条 user/message = 标题），与 GUI 显示一致。
            const logs = add.length > 0 ? indexSessionLogs(join(dshHome, 'sessions')) : undefined
            for (const id of add) {
              const log = logs?.get(id) ?? logs?.get(encodeSessionId(id))
              const summary = log !== undefined ? readSessionSummary(log.path) : {}
              roster.push({
                id,
                cwd: ws?.path ?? chatCwd,
                displayTitle: summary.title ?? id,
                updatedAt: summary.updatedAt ?? log?.mtimeMs ?? 0,
              })
            }
          }
        } catch { /* workspace membership is a best-effort enrich */ }
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

  // Interactive seams (user-questions/request, approval/request) forwarded to
  // Telegram and answered from Telegram. Owned agents get the prompt; anything
  // else delegates to the host GUI via next().
  const { onCallback, onText } = registerInteractions({
    ctx,
    sessions,
    deliveries,
    config,
    logger,
  })

  // Bot manager: owns clients, polls, deliveries — one runtime per scope.
  const manager = new BotManager({
    scopes,
    sessions,
    pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
    maxMessageLength: config.maxMessageLength ?? 4096,
    defaultCwd,
    menuCtxFor,
    respond: { onCallback, onText },
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

  // Announce a host restart once the host is back online. Detection covers ANY
  // reboot: a fresh restart marker (written before the previous host went down)
  // means the restart was requested from the plugin menu; otherwise a previous
  // durable host-instance record with a different pid means the host was
  // restarted externally (manual process kill, machine reboot, ...). Broadcast a
  // short line to every chat that kept a session, then the marker is cleared
  // only after a delivery succeeds — so a transient network failure retries
  // instead of dropping the announcement forever.
  // Idempotency: the current record is written AFTER the previous one was read,
  // so this process never announces twice.
  let announceTimer: NodeJS.Timeout | undefined
  const root = dataDirRoot()
  const prevInstance = readHostInstance(root)
  const marker = readRestartMarker(root)
  const noticeKind = resolveRestartNotice({
    prev: prevInstance,
    marker,
    mode: config.restartNotice ?? 'always',
    maxGapMs: config.restartNoticeMaxGapMs ?? 0,
  })
  // Overwrite with this process's record BEFORE any broadcast: even if delivery
  // retries run for a while, a second activation sees the new pid and stays silent.
  writeHostInstance(root)
  const announceRestart = async (attempt = 0): Promise<void> => {
    if (noticeKind === 'none') {
      logger.warn('未检测到需要广播的重启(首次启动/同 PID/已关闭),跳过「已上线」广播')
      return
    }
    if (attempt === 0) {
      if (marker !== undefined) {
        logger.warn(`检测到插件触发的重启(源于 PID ${marker.hostPid},${new Date(marker.at).toISOString()}),广播「已上线」`)
      } else {
        logger.warn(`检测到外部/手动宿主重启(上一实例 PID ${prevInstance?.pid}),广播「已上线」`)
      }
    }
    const message = noticeKind === 'requested'
      ? '✅ DSH 已重新上线,会话已恢复。'
      : '✅ DSH 已重新上线(检测到宿主重启)'
    let anySent = false
    for (const scope of scopes) {
      const delivery = deliveries.get(scope.botId)
      const store = stores.get(scope.botId)
      if (delivery === undefined || store === undefined) continue
      // Only chats this bot owns with a persisted session get the notice.
      for (const [key, chat] of Object.entries(store.allChats())) {
        if (chat.sessionId === '' || chat.sessionId === undefined) continue
        const colon = key.lastIndexOf(':')
        const chatId = Number(colon >= 0 ? key.slice(colon + 1) : key)
        if (!Number.isFinite(chatId)) continue
        try {
          await delivery.sendFinal(chatId, message)
          anySent = true
        } catch (error) {
          logger.warn(`[tg] 「已上线」广播失败 chat=${chatId}(第 ${attempt + 1} 次): ${String(error)}`)
        }
      }
    }
    if (anySent) {
      clearRestartMarker(dataDirRoot())
      return
    }
    // Nothing delivered yet: retry a few times so a Telegram/proxy hiccup right
    // after a restart does not lose the notice. Give up and clear after the cap.
    const maxAttempts = 5
    if (attempt + 1 >= maxAttempts) {
      clearRestartMarker(dataDirRoot())
      logger.warn(`「已上线」广播重试 ${maxAttempts} 次仍无一次投递成功,已放弃并清除标记`)
      return
    }
    const delayMs = 1500 * (attempt + 1)
    announceTimer = setTimeout(() => { void announceRestart(attempt + 1) }, delayMs)
  }
  void announceRestart()

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
      if (announceTimer !== undefined) clearTimeout(announceTimer)
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
