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
import { installModelSelection } from '@deepseek-ai/dsh-agent';
/** Session id of a live agent handle, or '' when it cannot be read. */
export function sessionIdOf(handle) {
    const session = handle.agent?.session;
    const id = session?.id;
    return id === undefined || id === null ? '' : String(id);
}
/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export class DshAgentFactory {
    ctx;
    /** One mutable selection per bot route, shared with that route's live agent. */
    selections = new Map();
    constructor(ctx) {
        this.ctx = ctx;
    }
    create(request) {
        const ref = this.refFor(request.routeKey, request);
        return this.ctx.agents.create({
            sessionId: request.sessionId,
            meta: { cwd: request.cwd },
            agentOptions: {
                provider: ref.current.provider,
                model: ref.current.model,
            },
            setup: (agentCtx) => {
                installModelSelection(agentCtx, ref);
            },
        });
    }
    resume(request) {
        const ref = this.refFor(request.routeKey, request);
        return this.ctx.agents.resume({
            resumeSessionId: request.sessionId,
            agentOptions: {
                provider: ref.current.provider,
                model: ref.current.model,
            },
            setup: (agentCtx) => {
                installModelSelection(agentCtx, ref);
            },
        });
    }
    /** Live agent lookup: the registry keeps one agent per session id. */
    getLive(sessionId) {
        const registry = this.ctx.agents;
        return registry.get(sessionId);
    }
    /** Switch a route's model; applies to the next step when an agent is live. */
    setSelection(routeKey, selection) {
        const ref = this.selections.get(routeKey);
        if (ref === undefined)
            return false;
        ref.current = { ...selection };
        return true;
    }
    /** Current selection of a route (diagnostics / menus). */
    getSelection(routeKey) {
        const current = this.selections.get(routeKey)?.current;
        return current === undefined ? undefined : { ...current };
    }
    /** Drop a route's selection (plugin unload). */
    forget(routeKey) {
        this.selections.delete(routeKey);
    }
    /**
     * Selection ref for one route: created on first use, then kept so a model
     * switch mutates the ref the live agent already installed.
     */
    refFor(routeKey, request) {
        const existing = this.selections.get(routeKey);
        if (existing !== undefined) {
            existing.current = { provider: request.provider, model: request.model };
            return existing;
        }
        const ref = {
            current: { provider: request.provider, model: request.model },
            assembled: undefined,
        };
        this.selections.set(routeKey, ref);
        return ref;
    }
}
