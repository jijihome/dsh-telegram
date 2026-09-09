/**
 * Session manager: owns one DSH agent session per Telegram chat.
 * - `getOrCreate` binds a chat to an agent (session id `telegram:<botId>:<chatId>`).
 * - `rotate` implements `/new` + `/clear`: disposes the old agent, starts a fresh one.
 * - `cancel` implements `/stop`: aborts the running turn via `agent.cancel`.
 * - On startup, bindings persisted by the StateStore are resumed via
 *   `ctx.agents.resume` so the conversation history survives a DSH restart.
 *
 * @module core/session-manager
 */
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { AgentFactoryLike } from '../harness/agent-factory.js';
import type { StateStore } from './state-store.js';
export interface SessionBinding {
    /** Telegram chat id (numeric). */
    chatId: number;
    /** Bot id owning this chat. */
    botId: string;
    /** Current agent handle. */
    handle: AgentHandle;
    /** Current session id; rotates on /new and /clear. */
    sessionId: string;
    /** Working directory for this chat's agent. */
    cwd: string;
    /** Monotonic rotation counter for session ids. */
    generation: number;
}
export interface SessionManagerOptions {
    factory: AgentFactoryLike;
    store: StateStore;
    provider: string;
    model: string;
    defaultCwd: string;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** Manages per-chat agent sessions. */
export declare class SessionManager {
    private readonly factory;
    private readonly store;
    private readonly provider;
    private readonly model;
    private readonly defaultCwd;
    private readonly logger;
    private readonly bindings;
    constructor(options: SessionManagerOptions);
    /** Live binding for a chat, or undefined. */
    get(chatId: number, botId: string): SessionBinding | undefined;
    /** Find the binding owning a given DSH session id (for event routing). */
    bySessionId(sessionId: string): SessionBinding | undefined;
    /**
     * Get the chat's agent, creating it if needed. On first creation it tries
     * to resume a persisted session; otherwise it starts a new one.
     */
    getOrCreate(chatId: number, botId: string, cwd?: string): Promise<SessionBinding>;
    /** Rotate to a fresh session (`/new`); disposes the previous agent. */
    rotate(chatId: number, botId: string): Promise<SessionBinding>;
    /** Cancel the chat's current turn (`/stop`); no-op when idle. */
    cancel(chatId: number, botId: string): boolean;
    /** Send a user text into the chat's agent (queued as a normal follow-up). */
    followup(chatId: number, botId: string, text: string, onError?: (error: unknown) => void): void;
    /** Dispose every live binding (plugin unload). */
    disposeAll(): Promise<void>;
    /** Create (or resume) the binding for a chat. */
    private create;
}
