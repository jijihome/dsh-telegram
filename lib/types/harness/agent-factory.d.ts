/**
 * Agent factory: wraps `ctx.agents.create` / `ctx.agents.resume` behind a
 * small interface so the rest of the plugin never touches the registry
 * directly and tests can substitute a stub. Path A of TASK.md §4.3.
 *
 * Model isolation: each bot route owns its own mutable `ModelSelectionRef`.
 * The host-global `agentDefaultModel` service is deliberately **never** read or
 * written here — writing it would leak one bot's model choice into every other
 * bot and into the GUI's own agents. A route's selection is the bot default
 * (or the chat's persisted override) and can be switched live by mutating the
 * ref, which takes effect on the next step of the running agent.
 *
 * Both creation paths install the route's selection via
 * `installModelSelection` (mirroring the one-shot headless runner); without it
 * an agent assembled from a bare registry may never produce a turn.
 *
 * @module harness/agent-factory
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
export interface AgentCreateRequest {
    /** Stable session id for this chat. */
    sessionId: SessionId;
    /** Working directory for the agent. */
    cwd: string;
    /** LLM provider id (bot scope default or the chat's override). */
    provider: string;
    /** Model id (bot scope default or the chat's override). */
    model: string;
    /** Isolation key of the owning route (`<botId>:<chatId>`). */
    routeKey: string;
    /**
     * Agent preset id applied at creation (`meta.agentPreset`). The preset composes
     * the agent's scoped world — tools, prompt sections — so a session created
     * without one has NO tools (no shell/file access). Omit to let the host default.
     */
    agentPreset?: string;
}
export interface AgentResumeRequest {
    sessionId: SessionId;
    cwd: string;
    provider: string;
    model: string;
    routeKey: string;
    /**
     * Preset to join on resume. Omitted for foreign (GUI/adopted) sessions, whose
     * composition belongs to whoever created them. Our own sessions must re-join
     * their preset or a resumed chat loses its tool world.
     */
    agentPreset?: string;
}
export interface AgentFactoryLike {
    create(request: AgentCreateRequest): Promise<AgentHandle>;
    /** Resume an agent on a persisted session (restart recovery). */
    resume(request: AgentResumeRequest): Promise<AgentHandle>;
    /** Live agent for a session id in the current process, or undefined. */
    getLive(sessionId: string): Agent | undefined;
    /**
     * Switch the model of a live route's agent. Returns false when the route has
     * no agent yet (the caller's persisted choice applies at the next create).
     */
    setSelection(routeKey: string, selection: ModelSelection): boolean;
    /**
     * Model recorded on a live session's own `modelSelection` projection — the
     * model that conversation continues with. Optional: stubs may omit it.
     */
    sessionSelection?(sessionId: string): ModelSelection | undefined;
}
/** Session id of a live agent handle, or '' when it cannot be read. */
export declare function sessionIdOf(handle: AgentHandle): string;
/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export declare class DshAgentFactory implements AgentFactoryLike {
    private readonly ctx;
    /** One mutable selection per bot route, shared with that route's live agent. */
    private readonly selections;
    constructor(ctx: Context);
    create(request: AgentCreateRequest): Promise<AgentHandle>;
    /**
     * Join an agent scope to its agent-preset composition.
     *
     * Resolved through the service locator (not inject) so the plugin does not
     * hard-depend on the preset package being installed; when the host has no
     * `agentPresets` service (headless/minimal profiles) this is a no-op.
     *
     * @param agentCtx - the unpublished agent scope from `setup`.
     * @param presetId - preset to mount; `undefined` lets the host pick its default.
     */
    private mountPreset;
    resume(request: AgentResumeRequest): Promise<AgentHandle>;
    /** Live agent lookup: the registry keeps one agent per session id. */
    getLive(sessionId: string): Agent | undefined;
    /**
     * The model a live session is actually continuing with, read from its
     * `modelSelection` projection (`pending` wins over `lastUsed`). Used so a chat
     * that was switched onto an existing conversation reports — and continues on —
     * that conversation's model instead of the deployment default.
     */
    sessionSelection(sessionId: string): ModelSelection | undefined;
    /** Switch a route's model; applies to the next step when an agent is live. */
    setSelection(routeKey: string, selection: ModelSelection): boolean;
    /** Current selection of a route (diagnostics / menus). */
    getSelection(routeKey: string): ModelSelection | undefined;
    /** Drop a route's selection (plugin unload). */
    forget(routeKey: string): void;
    /**
     * Selection ref for one route: created on first use, then kept so a model
     * switch mutates the ref the live agent already installed.
     */
    private refFor;
}
