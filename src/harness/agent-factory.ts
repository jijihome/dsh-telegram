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
  /**
   * Agent preset id applied at creation (`meta.agentPreset`). The preset composes
   * the agent's scoped world — tools, prompt sections — so a session created
   * without one has NO tools (no shell/file access). Omit to let the host default.
   */
  agentPreset?: string
}

export interface AgentResumeRequest {
  sessionId: SessionId
  cwd: string
  provider: string
  model: string
  routeKey: string
  /**
   * Preset to join on resume. Omitted for foreign (GUI/adopted) sessions, whose
   * composition belongs to whoever created them. Our own sessions must re-join
   * their preset or a resumed chat loses its tool world.
   */
  agentPreset?: string
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
      meta: {
        cwd: request.cwd,
        ...(request.agentPreset !== undefined && request.agentPreset !== ''
          ? { agentPreset: request.agentPreset }
          : {}),
      },
      agentOptions: {
        provider: ref.current!.provider,
        model: ref.current!.model,
      },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, ref)
        // The preset COMPOSES the agent's model-facing world (tool schemas, prompt
        // sections). `meta.agentPreset` only records the creation fact; without this
        // mount the session runs with an empty tool world — no shell, no file tools.
        // `mount` is the agent-presets service method that mounts (or reuses) the
        // standing composition and joins this agent's scope key to it.
        return this.mountPreset(agentCtx, request.agentPreset)
      },
    })
  }

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
  private mountPreset(agentCtx: Context, presetId: string | undefined): Promise<void> {
    const presets = (this.ctx.get as (k: string) => unknown)?.('agentPresets') as
      { mount?(ctx: Context, id?: string): Promise<unknown> } | undefined
    if (presets?.mount === undefined) return Promise.resolve()
    return presets.mount(agentCtx, presetId).then(() => undefined)
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
        // Only when the caller names a preset (our own sessions). A foreign session
        // keeps the composition its creator mounted.
        return request.agentPreset !== undefined && request.agentPreset !== ''
          ? this.mountPreset(agentCtx, request.agentPreset)
          : undefined
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
