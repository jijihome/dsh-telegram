/**
 * /stop regression: a session selected from the 会话 menu lives in
 * SessionManager.bound (driven by boundFollowup), not in the manager's
 * bindings map, so /stop must resolve its live agent through factory.getLive
 * instead of reporting「当前没有运行中的回合」while that agent is generating.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBotScopes } from '../lib/core/bot-scope.js'
import { StateStore } from '../lib/core/state-store.js'
import { SessionManager } from '../lib/core/session-manager.js'

const silent = { warn() {}, error() {} }

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-stop-'))
  const scopes = resolveBotScopes([{ id: 'bot-a', token: 'token-a' }], { dataDir: dir }, 'E:/ws')
  return {
    stores: new Map(scopes.map(s => [s.botId, new StateStore({ dataDir: s.dataDir, botId: s.botId })])),
    scopes: new Map(scopes.map(s => [s.botId, s])),
  }
}

function makeAgent(id, status = 'running') {
  const causes = []
  return { id, status, session: { id }, causes, followup() {}, cancel(cause) { causes.push(cause) } }
}

function makeFactory(live = new Map()) {
  return {
    async create(request) {
      const agent = makeAgent(String(request.sessionId), 'idle')
      live.set(String(request.sessionId), agent)
      return { agent, async dispose() {} }
    },
    async resume(request) {
      const agent = makeAgent(String(request.sessionId), 'idle')
      live.set(String(request.sessionId), agent)
      return { agent, async dispose() {} }
    },
    getLive(id) { return live.get(id) },
    setSelection() { return true },
  }
}

test('/stop cancels a live session picked from the 会话 menu (bound path)', () => {
  const env = makeEnv()
  const id = 'telegram:bot-a:42:g3'
  const agent = makeAgent(id)
  const sessions = new SessionManager({
    factory: makeFactory(new Map([[id, agent]])),
    stores: env.stores, scopes: env.scopes, defaultCwd: 'E:/ws', logger: silent,
  })
  sessions.bind(42, 'bot-a', id, 'E:/ws')

  assert.equal(sessions.cancel(42, 'bot-a'), true)
  assert.deepEqual(agent.causes, [{ kind: 'user' }])
})

test('/stop keeps the own-live-binding path working', async () => {
  const env = makeEnv()
  const sessions = new SessionManager({
    factory: makeFactory(), stores: env.stores, scopes: env.scopes, defaultCwd: 'E:/ws', logger: silent,
  })
  const binding = await sessions.getOrCreate(7, 'bot-a')

  assert.equal(sessions.cancel(7, 'bot-a'), true)
  assert.deepEqual(binding.handle.agent.causes, [{ kind: 'user' }])
})

test('/stop returns false when the chat has no live agent', () => {
  const env = makeEnv()
  const sessions = new SessionManager({
    factory: makeFactory(), stores: env.stores, scopes: env.scopes, defaultCwd: 'E:/ws', logger: silent,
  })

  assert.equal(sessions.cancel(99, 'bot-a'), false)
})

test('/stop follows routing precedence: bound agent wins over a stale own binding', async () => {
  const env = makeEnv()
  const live = new Map()
  const sessions = new SessionManager({
    factory: makeFactory(live), stores: env.stores, scopes: env.scopes, defaultCwd: 'E:/ws', logger: silent,
  })
  const own = await sessions.getOrCreate(5, 'bot-a')
  const boundId = 'telegram:bot-a:5:g9'
  const bound = makeAgent(boundId)
  live.set(boundId, bound)
  sessions.bind(5, 'bot-a', boundId, 'E:/ws')

  assert.equal(sessions.cancel(5, 'bot-a'), true)
  assert.deepEqual(bound.causes, [{ kind: 'user' }], 'the routed (bound) agent must be cancelled')
  assert.deepEqual(own.handle.agent.causes, [], 'a stale own binding must not be cancelled')
})
