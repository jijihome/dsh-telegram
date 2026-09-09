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
import { StateStore } from './core/state-store.js'
import { BotManager, normalizeBots } from './telegram/bot-manager.js'
import { Delivery } from './telegram/delivery.js'
import { join } from 'node:path'

export { Config }
export type { TelegramConfig }
export { BotManager, normalizeBots } from './telegram/bot-manager.js'
export { StreamListener } from './harness/stream-listener.js'
export { DshAgentFactory } from './harness/agent-factory.js'
export type { AgentFactoryLike } from './harness/agent-factory.js'
export { SessionManager } from './core/session-manager.js'
export { StateStore } from './core/state-store.js'
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
  const defaultCwd = process.cwd()
  const dataDir = config.dataDir ?? join(defaultCwd, 'data')

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
    menuCtxFor: (chatId, botId) => ({
      chatId,
      botId,
      delivery: deliveries.get(botId) as never,
      sessions,
      store,
      workspaceRoots: config.workspaceRoots ?? [defaultCwd],
      defaultCwd,
      provider,
      model,
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
          { list?(): Promise<Array<{ id: string; name?: string; description?: string }>> } | undefined
        if (ap?.list === undefined) return []
        try {
          const presets = await ap.list()
          return Array.isArray(presets) ? presets.map(p => ({ id: p.id, name: p.name ?? p.id })) : []
        } catch { return [] }
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
        try {
          const sessionsSvc = (ctx.get as (k: string) => unknown)?.('sessions') as
            { list?(): Promise<Array<{ id?: string; cwd?: string; title?: string }>> } | undefined
          const list = await sessionsSvc?.list?.()
          return (Array.isArray(list) ? list : []).map(s => ({ id: s.id ?? '', cwd: s.cwd, title: s.title }))
        } catch { return [] }
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