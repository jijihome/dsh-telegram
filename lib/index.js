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
import { Config } from './config.js';
import { DshAgentFactory } from './harness/agent-factory.js';
import { StreamListener } from './harness/stream-listener.js';
import { SessionManager } from './core/session-manager.js';
import { StateStore } from './core/state-store.js';
import { BotManager, normalizeBots } from './telegram/bot-manager.js';
import { join } from 'node:path';
export { Config };
export { BotManager, normalizeBots } from './telegram/bot-manager.js';
export { StreamListener } from './harness/stream-listener.js';
export { DshAgentFactory } from './harness/agent-factory.js';
export { SessionManager } from './core/session-manager.js';
export { StateStore } from './core/state-store.js';
export { normalizeChunk, normalizeSessionEvent } from './core/event-normalizer.js';
export { markdownToHtml, splitMessage, escapeHtml } from './core/format.js';
/** Services the plugin depends on at runtime. */
export const inject = ['agents'];
/** Plugin activation. */
export function apply(ctx, config) {
    // Resolve the bot list: `bots[]` or the single bare `token`.
    const bots = normalizeBots(config.bots, config.token);
    if (bots.length === 0) {
        throw new Error('dsh-telegram: 未配置任何 Bot Token(需在配置中提供 bots[].token 或 token)');
    }
    // Direct-to-stderr logger so daemon diagnostics survive any Cordis log
    // routing/filtering in headless profiles.
    const line = (...parts) => process.stderr.write(`[dsh-telegram] ${parts.join(' ')}\n`);
    const logger = { warn: (...a) => line('WARN', ...a), error: (...a) => line('ERROR', ...a) };
    const defaultCwd = process.cwd();
    const dataDir = config.dataDir ?? join(defaultCwd, 'data');
    // Persistence + session manager + agent factory.
    const store = new StateStore({ dataDir });
    const factory = new DshAgentFactory(ctx);
    const sessions = new SessionManager({
        factory,
        store,
        provider: config.provider ?? 'deepseek-official',
        model: config.model ?? 'deepseek-v4-flash',
        defaultCwd,
        logger,
    });
    // One delivery per bot.
    const deliveries = new Map();
    for (const bot of bots) {
        // The BotManager creates its own clients; here we only provide the
        // delivery instances the StreamListener needs. Reuse per-bot clients is
        // centralized in BotManager.launch — deliveries are built there too, so
        // this map is filled after bot start. See below for the wiring note.
    }
    // Stream listener: routes session events to the right bot's delivery.
    const listener = new StreamListener({ ctx, sessions, deliveries, logger });
    // Bot manager: owns clients, polls, deliveries.
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
        logger,
    });
    // Wire the StreamListener's delivery map to the runtimes once started.
    const attachDeliveries = () => {
        for (const [id, runtime] of manager.all) {
            deliveries.set(id, runtime.delivery);
        }
    };
    listener.start();
    manager.start();
    attachDeliveries();
    // Persist offsets periodically (debounced) and on unload.
    const flushTimer = setInterval(() => {
        for (const [id, runtime] of manager.all) {
            store.setOffset(id, runtime.poll.currentOffset);
        }
        store.flush();
    }, 5000);
    // Headless exits as soon as its task settles. Keep one ref'ed timer while
    // enabled so Telegram long polling remains a daemon after the initial task.
    const keepAliveTimer = config.keepAlive === false ? undefined : setInterval(() => { }, 60_000);
    ctx.effect(() => {
        return () => {
            clearInterval(flushTimer);
            if (keepAliveTimer !== undefined)
                clearInterval(keepAliveTimer);
            listener.stop();
            void manager.stop().finally(() => {
                store.flush();
            });
            void sessions.disposeAll();
        };
    }, 'dsh-telegram.serve');
}
