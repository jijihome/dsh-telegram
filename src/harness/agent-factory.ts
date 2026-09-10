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

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface AgentCreateRequest {
  /** Stable session id for this chat. */
  sessionId: SessionId
  /** Working directory for the agent. */
  cwd: string
  /** LLM provider id (bot scope default or the chat's override). */
  provider: string
  /** Model id (bot scope default or the chat's override). */
  model: string
  /** Isolation key of the owning route (`<botId>:<chatId>`). */
  routeKey: string
}

export interface AgentResumeRequest {
  sessionId: SessionId
  cwd: string
  provider: string
  model: string
  routeKey: string
}

export interface AgentFactoryLike {
  create(request: AgentCreateRequest): Promise<AgentHandle>
  /** Resume an agent on a persisted session (restart recovery). */
  resume(request: AgentResumeRequest): Promise<AgentHandle>
  /** Live agent for a session id in the current process, or undefined. */
  getLive(sessionId: string): Agent | undefined
  /**
   * Switch the model of a live route's agent. Returns false when the route has
   * no agent yet (the caller's persisted choice applies at the next create).
   */
  setSelection(routeKey: string, selection: ModelSelection): boolean
  /**
   * Model recorded on a live session's own `modelSelection` projection — the
   * model that conversation continues with. Optional: stubs may omit it.
   */
  sessionSelection?(sessionId: string): ModelSelection | undefined
}

/** Normalize an unknown projection value into a usable selection. */
function normalizeSelection(value: unknown): ModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { provider?: unknown; model?: unknown }
  if (typeof record.provider !== 'string' || record.provider === '') return undefined
  if (typeof record.model !== 'string' || record.model === '') return undefined
  return { provider: record.provider, model: record.model }
}

/** Session id of a live agent handle, or '' when it cannot be read. */
export function sessionIdOf(handle: AgentHandle): string {
  const session = (handle.agent as { session?: { id?: unknown } } | undefined)?.session
  const id = session?.id
  return id === undefined || id === null ? '' : String(id)
}

/**
 * Real implementation backed by the injected `agents` registry.
 * @param ctx - context with `agents` injected.
 */
export class DshAgentFactory implements AgentFactoryLike {
  /** One mutable selection per bot route, shared with that route's live agent. */
  private readonly selections = new Map<string, ModelSelectionRef>()

  constructor(private readonly ctx: Context) {}

  create(request: AgentCreateRequest): Promise<AgentHandle> {
    const ref = this.refFor(request.routeKey, request)
    return this.ctx.agents.create({
      sessionId: request.sessionId,
      meta: { cwd: request.cwd },
      agentOptions: {
        provider: ref.current!.provider,
        model: ref.current!.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, ref)
      },
    })
  }

  resume(request: AgentResumeRequest): Promise<AgentHandle> {
    const ref = this.refFor(request.routeKey, request)
    return this.ctx.agents.resume({
      resumeSessionId: request.sessionId,
      agentOptions: {
        provider: ref.current!.provider,
        model: ref.current!.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, ref)
      },
    })
  }

  /** Live agent lookup: the registry keeps one agent per session id. */
  getLive(sessionId: string): Agent | undefined {
    const registry = this.ctx.agents as unknown as { get(id: string): Agent | undefined }
    return registry.get(sessionId)
  }

  /**
   * The model a live session is actually continuing with, read from its
   * `modelSelection` projection (`pending` wins over `lastUsed`). Used so a chat
   * that was switched onto an existing conversation reports — and continues on —
   * that conversation's model instead of the deployment default.
   */
  sessionSelection(sessionId: string): ModelSelection | undefined {
    const agent = this.getLive(sessionId)
    if (agent === undefined) return undefined
    try {
      const projections = (this.ctx.get as (key: string) => unknown)?.('sessionProjections') as
        { stateOf?(session: unknown, key: string): { lastUsed?: unknown; pending?: unknown } | undefined } | undefined
      const state = projections?.stateOf?.(agent.session, 'modelSelection')
      return normalizeSelection(state?.pending) ?? normalizeSelection(state?.lastUsed)
    } catch {
      return undefined
    }
  }

  /** Switch a route's model; applies to the next step when an agent is live. */
  setSelection(routeKey: string, selection: ModelSelection): boolean {
    const ref = this.selections.get(routeKey)
    if (ref === undefined) return false
    ref.current = { ...selection }
    return true
  }

  /** Current selection of a route (diagnostics / menus). */
  getSelection(routeKey: string): ModelSelection | undefined {
    const current = this.selections.get(routeKey)?.current
    return current === undefined ? undefined : { ...current }
  }

  /** Drop a route's selection (plugin unload). */
  forget(routeKey: string): void {
    this.selections.delete(routeKey)
  }

  /**
   * Selection ref for one route: created on first use, then kept so a model
   * switch mutates the ref the live agent already installed.
   */
  private refFor(routeKey: string, request: { provider: string; model: string }): ModelSelectionRef {
    const existing = this.selections.get(routeKey)
    if (existing !== undefined) {
      existing.current = { provider: request.provider, model: request.model }
      return existing
    }
    const ref: ModelSelectionRef = {
      current: { provider: request.provider, model: request.model },
      assembled: undefined,
    }
    this.selections.set(routeKey, ref)
    return ref
  }
}
