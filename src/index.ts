/**
 * dsh-telegram entry point.
 *
 * A Telegram bridge for DeepSeek Harness (dsh): multi-bot long polling,
 * per-chat agent sessions, and full session-process streaming (text /
 * reasoning / tool deltas) forwarded into Telegram in real time.
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
import { SessionManager } from './core/session-manager.js'
import { StateStore, type ChatState } from './core/state-store.js'
import { BotManager, normalizeBots } from './telegram/bot-manager.js'
import { Delivery } from './telegram/delivery.js'
import { getHostInfo, scheduleRestart } from './core/host.js'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

export { Config }
export type { TelegramConfig }
export { BotManager, normalizeBots } from './telegram/bot-manager.js'
export { StreamListener } from './harness/stream-listener.js'
export { DshAgentFactory } from './harness/agent-factory.js'
export type { AgentFactoryLike } from './harness/agent-factory.js'
export { SessionManager } from './core/session-manager.js'
export { StateStore } from './core/state-store.js'
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
  if (bots.length === 0) {
    throw new Error('dsh-telegram: 未配置任何 Bot Token(需在配置中提供 bots[].token 或 token)')
  }

  // Direct-to-stderr logger so daemon diagnostics survive any Cordis log
  // routing/filtering in headless profiles.
  const line = (...parts: unknown[]) => process.stderr.write(`[dsh-telegram] ${parts.join(' ')}\n`)
  const logger = { warn: (...a: unknown[]) => line('WARN', ...a), error: (...a: unknown[]) => line('ERROR', ...a) }
  // Effective proxy for Telegram traffic: explicit config wins, else the
  // `TELEGRAM_PROXY` / `HTTPS_PROXY` env vars already present on this host. Only
  // Telegram requests use it; other host network calls are untouched.
  const proxy = config.proxy ?? process.env.TELEGRAM_PROXY ?? process.env.HTTPS_PROXY
  if (proxy) line('WARN', `Telegram 流量将经代理: ${proxy}`)
  const defaultCwd = process.cwd()
  // Persist under a stable, DSH-home-relative path so a workspace switch (and
  // the chat↔session binding) survives a DSH restart regardless of the host
  // process's cwd at load time.
  const dshHome = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? defaultCwd
  const defaultDataDir = join(dshHome, 'plugin-data', 'dsh-telegram')
  const dataDir = config.dataDir ?? defaultDataDir

  // Persistence + session manager + agent factory.
  const store = new StateStore({ dataDir })
  const factory = new DshAgentFactory(ctx)
  const sessions = new SessionManager({
    factory,
    store,
    provider: config.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    defaultCwd,
    logger,
  })

  // One delivery per bot.
  const deliveries = new Map<string, Delivery>()
  for (const bot of bots) {
    // The BotManager creates its own clients; here we only provide the
    // delivery instances the StreamListener needs. Reuse per-bot clients is
    // centralized in BotManager.launch — deliveries are built there too, so
    // this map is filled after bot start. See below for the wiring note.
  }

  // Register config session bindings: bot chat ↔ existing DSH session.
  // Intuitive form: `bindings` nested under each bot, keyed by bare chatId.
  for (const bot of bots) {
    const botBindings = bot.bindings ?? {}
    for (const [chatId, sessionId] of Object.entries(botBindings)) {
      sessions.bind(Number(chatId), bot.id, sessionId, defaultCwd)
    }
  }
  // Legacy top-level `bindings` (any bot / `botId:chatId` composite keys).
  const legacyBindings = config.bindings ?? {}
  for (const [key, sessionId] of Object.entries(legacyBindings)) {
    const sep = key.lastIndexOf(':')
    const hasBotPrefix = sep > 0 && /^\d+$/.test(key.slice(sep + 1))
    if (hasBotPrefix) {
      sessions.bind(Number(key.slice(sep + 1)), key.slice(0, sep), sessionId, defaultCwd)
    } else {
      sessions.bind(Number(key), '', sessionId, defaultCwd)
    }
  }

  // Stream listener: routes session events to the right bot's delivery.
  const listener = new StreamListener({ ctx, sessions, deliveries, logger })

  // Bot manager: owns clients, polls, deliveries.
  const provider = config.provider ?? 'deepseek-official'
  const model = config.model ?? 'deepseek-v4-flash'
  const readCurrentModel = () => {
    try {
      const adm = (ctx.get as (k: string) => unknown)?.('agentDefaultModel') as
        { currentSelection?(): { provider: string; model: string } } | undefined
      return adm?.currentSelection?.() ?? { provider, model }
    } catch {
      return { provider, model }
    }
  }
  const switchModel = async (p: string, m: string) => {
    const adm = (ctx.get as (k: string) => unknown)?.('agentDefaultModel') as
      { saveSelection?(next: { provider: string; model: string }): Promise<void> } | undefined
    if (adm?.saveSelection === undefined) throw new Error('agentDefaultModel.saveSelection unavailable')
    await adm.saveSelection({ provider: p, model: m })
  }
  const manager = new BotManager({
    bots,
    allowedUserIds: config.allowedUserIds ?? [],
    allowAllUsers: config.allowAllUsers ?? false,
    sessions,
    store,
    pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
    maxMessageLength: config.maxMessageLength ?? 4096,
    workspaceRoots: config.workspaceRoots ?? [defaultCwd],
    defaultCwd,
    forwardLogPath: join(dataDir, 'forward.log'),
    proxy,
    menuCtxFor: (chatId, botId) => ({
      chatId,
      botId,
      delivery: deliveries.get(botId) as never,
      sessions,
      store,
      workspaceRoots: config.workspaceRoots ?? [defaultCwd],
      defaultCwd,
      // This chat's effective working directory: the persisted choice takes
      // precedence over the process cwd, so a workspace switch survives the
      // /new and a DSH restart.
      currentCwd: () => {
        const saved = store.getChat(`${botId}:${chatId}`)?.cwd
        return saved ?? defaultCwd
      },
      setCurrentCwd: (cwd) => {
        const key = `${botId}:${chatId}`
        const current = store.getChat(key)
        // Merge, so the existing sessionId/botId binding is not clobbered.
        store.setChat(key, { ...(current ?? {}), cwd, botId } as ChatState)
        store.flush()
      },
      switchSession: async (sessionId, cwd) => {
        // Bind this chat to an existing DSH session and persist the binding, so
        // subsequent messages route into that session and it survives a restart.
        sessions.bind(chatId, botId, sessionId, cwd ?? defaultCwd)
        const key = `${botId}:${chatId}`
        const current = store.getChat(key)
        store.setChat(key, { ...(current ?? {}), sessionId, cwd: cwd ?? defaultCwd, botId } as ChatState)
        store.flush()
      },
      provider,
      model,
      // Filled per-callback by the bot manager (authorization).
      userId: 0,
      canOperate: false,
      getHostInfo,
      restartDsh: () => {
        try {
          scheduleRestart({ delayMs: 3000 })
          return '🔄 已请求重启 DSH,约 3 秒后自动重启(宿主进程将被重建)。'
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `❌ 重启请求失败: ${msg}`
        }
      },
      getCurrentModel: readCurrentModel,
      listModels: async () => {
        const llm = (ctx.get as (k: string) => unknown)?.('llm') as
          { listProviders?(): Promise<Array<{ id?: string; name?: string }>>; listModels?(provider: string): Promise<Array<{ provider?: string; id?: string; name?: string }>> } | undefined
        if (llm?.listModels === undefined) return []
        const out: Array<{ provider: string; model: string }> = []
        let providers: Array<{ id?: string; name?: string }> = []
        try { providers = (await llm.listProviders?.()) ?? [] } catch { providers = [] }
        const ids: string[] = providers.length > 0 ? providers.map(p => p.id ?? p.name).filter((x): x is string => Boolean(x)) : [provider]
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
      setModel: switchModel,
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
        const current = store.getChat(`${botId}:${chatId}`) as
          (ChatState & { agentPreset?: string }) | undefined
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
        const current = store.getChat(`${botId}:${chatId}`) as
          (ChatState & { agentPreset?: string }) | undefined
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
        const current = store.getChat(`${botId}:${chatId}`)
        store.setChat(`${botId}:${chatId}`, { ...(current ?? {}), agentPreset: id } as never)
      },
      listWorkspaces: async () => {
        const set = new Set<string>([defaultCwd, ...(config.workspaceRoots ?? [])])
        // 1) Typert gateway RPC: workspace.list -> { items: [{ path, title }] }.
        //    This is the channel dsh-im uses and returns ALL registered workspaces.
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
        // 2) Direct persistence fallback: read the workspace registry file so the
        //    list never empties even when the runtime channel is unavailable.
        //    Home resolution falls back to `~/.dsh` so the plugin still finds the
        //    registry when the host process has NOT exported $DSH_HOME (the dsh
        //    launcher inherits the shell env, which usually lacks it).
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
        // 3) Fall back to any cwd seen on sessions.
        try {
          const sessionsSvc = (ctx.get as (k: string) => unknown)?.('sessions') as
            { list?(): Promise<Array<{ cwd?: string }>> } | undefined
          const sessions = await sessionsSvc?.list?.()
          for (const s of (sessions ?? [])) {
            if (typeof s.cwd === 'string' && s.cwd) set.add(s.cwd)
          }
        } catch { /* best-effort; fall back to the configured roots */ }
        return [...set]
      },
      listSessions: async () => {
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
      },
    }),
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

  // Persist offsets periodically (debounced) and on unload.
  const flushTimer = setInterval(() => {
    for (const [id, runtime] of manager.all) {
      store.setOffset(id, runtime.poll.currentOffset)
    }
    store.flush()
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
        store.flush()
      })
      void sessions.disposeAll()
    }
  }, 'dsh-telegram.serve')
}