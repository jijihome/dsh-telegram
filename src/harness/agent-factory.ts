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

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface AgentCreateRequest {
  /** Stable session id for this chat. */
  sessionId: SessionId
  /** Working directory for the agent. */
  cwd: string
  /** LLM provider id (config default `deepseek-official`). */
  provider: string
  /** Model id. */
  model: string
}

export interface AgentFactoryLike {
  create(request: AgentCreateRequest): Promise<AgentHandle>
  /** Resume an agent on a persisted session (restart recovery). */
  resume(request: { sessionId: SessionId; cwd: string; provider: string; model: string }): Promise<AgentHandle>
}

/** Selection snapshot taken from `agentDefaultModel` when present. */
interface Selection {
  provider: string
  model: string
}

/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export class DshAgentFactory implements AgentFactoryLike {
  constructor(private readonly ctx: Context) {}

  create(request: AgentCreateRequest): Promise<AgentHandle> {
    const selection = this.readSelection(request)
    return this.ctx.agents.create({
      sessionId: request.sessionId,
      meta: { cwd: request.cwd },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
  }

  resume(request: { sessionId: SessionId; cwd: string; provider: string; model: string }): Promise<AgentHandle> {
    const selection = this.readSelection(request)
    return this.ctx.agents.resume({
      resumeSessionId: request.sessionId,
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
  }

  /** Prefer the live `agentDefaultModel` selection, fall back to request values. */
  private readSelection(request: { provider: string; model: string }): Selection {
    const defaultModel = (this.ctx.get as (key: string) => unknown)?.('agentDefaultModel') as
      | { currentSelection(): { provider: string; model: string } }
      | undefined
    const selection = defaultModel?.currentSelection()
    return selection ?? { provider: request.provider, model: request.model }
  }
}
