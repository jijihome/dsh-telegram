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
import { installModelSelection } from '@deepseek-ai/dsh-agent';
/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export class DshAgentFactory {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    create(request) {
        const selection = this.readSelection(request);
        return this.ctx.agents.create({
            sessionId: request.sessionId,
            meta: { cwd: request.cwd },
            agentOptions: {
                provider: selection.provider,
                model: selection.model,
            },
            setup: (agentCtx) => {
                installModelSelection(agentCtx, { current: selection, assembled: undefined });
            },
        });
    }
    resume(request) {
        const selection = this.readSelection(request);
        return this.ctx.agents.resume({
            resumeSessionId: request.sessionId,
            agentOptions: {
                provider: selection.provider,
                model: selection.model,
            },
            setup: (agentCtx) => {
                installModelSelection(agentCtx, { current: selection, assembled: undefined });
            },
        });
    }
    /** Prefer the live `agentDefaultModel` selection, fall back to request values. */
    readSelection(request) {
        const defaultModel = this.ctx.get?.('agentDefaultModel');
        const selection = defaultModel?.currentSelection();
        return selection ?? { provider: request.provider, model: request.model };
    }
}
