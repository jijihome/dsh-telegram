/**
 * Agent factory: wraps `ctx.agents.create` / `ctx.agents.resume` behind a
 * small interface so the rest of the plugin never touches the registry
 * directly and tests can substitute a stub. Path A of TASK.md §4.3.
 *
 * Both creation paths install the current model selection via
 * `installModelSelection` (mirroring the one-shot headless runner); without
 * it an agent assembled from a bare registry may never produce a turn.
 *
 * @module harness/agent-factory
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
export interface AgentCreateRequest {
    /** Stable session id for this chat. */
    sessionId: SessionId;
    /** Working directory for the agent. */
    cwd: string;
    /** LLM provider id (config default `deepseek-official`). */
    provider: string;
    /** Model id. */
    model: string;
}
export interface AgentFactoryLike {
    create(request: AgentCreateRequest): Promise<AgentHandle>;
    /** Resume an agent on a persisted session (restart recovery). */
    resume(request: {
        sessionId: SessionId;
        cwd: string;
        provider: string;
        model: string;
    }): Promise<AgentHandle>;
    /** Live agent for a session id in the current process, or undefined. */
    getLive(sessionId: string): Agent | undefined;
}
/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export declare class DshAgentFactory implements AgentFactoryLike {
    private readonly ctx;
    constructor(ctx: Context);
    create(request: AgentCreateRequest): Promise<AgentHandle>;
    resume(request: {
        sessionId: SessionId;
        cwd: string;
        provider: string;
        model: string;
    }): Promise<AgentHandle>;
    /** Live agent lookup: the registry keeps one agent per session id. */
    getLive(sessionId: string): Agent | undefined;
    /** Prefer the live `agentDefaultModel` selection, fall back to request values. */
    private readSelection;
}
