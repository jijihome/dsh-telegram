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
import type { Context } from '@deepseek-ai/cordis';
import { Config, type TelegramConfig } from './config.js';
export { Config };
export type { TelegramConfig };
export { BotManager, normalizeBots } from './telegram/bot-manager.js';
export { StreamListener } from './harness/stream-listener.js';
export { DshAgentFactory } from './harness/agent-factory.js';
export type { AgentFactoryLike } from './harness/agent-factory.js';
export { SessionManager } from './core/session-manager.js';
export { StateStore } from './core/state-store.js';
export { getHostInfo, scheduleRestart } from './core/host.js';
export { normalizeChunk, normalizeSessionEvent } from './core/event-normalizer.js';
export type { NormalizedMessage, TerminalStatus } from './core/event-normalizer.js';
export { markdownToHtml, splitMessage, escapeHtml } from './core/format.js';
export { renderMessage, renderStatus } from './core/renderer.js';
export type { RenderState } from './core/renderer.js';
/** Services the plugin depends on at runtime. */
export declare const inject: string[];
/** Plugin activation. */
export declare function apply(ctx: Context, config: TelegramConfig): void;
