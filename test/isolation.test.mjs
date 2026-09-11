/**
 * Multi-bot isolation tests (compiled `lib`).
 *
 * Covers the strict-tenancy guarantees of 方案1:
 * - unique bot ids/tokens and per-bot policy resolution;
 * - cross-bot session sharing refused unless explicitly opted in;
 * - per-bot state files, cross-bot key guard, and legacy state migration;
 * - real resumed session id, real `/new` (fresh id + binding cleared);
 * - per-route model selection (no host-global model service involvement);
 * - stream routing that cannot reach another bot's delivery.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBotScopes, assertSessionOwnership } from '../lib/core/bot-scope.js'
import { StateStore, migrateLegacyState, stateFilePath, botDataDir } from '../lib/core/state-store.js'
import { SessionManager, preferSession } from '../lib/core/session-manager.js'
import { scopeSessionsToDir } from '../lib/telegram/menu.js'
import { DshAgentFactory } from '../lib/harness/agent-factory.js'
import { StreamListener } from '../lib/harness/stream-listener.js'
import { parseAgentDefaultModel, readHostDefaultModel } from '../lib/core/host-default-model.js'

const TWO_BOTS = [{ id: 'bot-a', token: 'token-a' }, { id: 'bot-b', token: 'token-b' }]
const silent = { warn() {}, error() {} }

/** Temp dir per test. */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-tg-iso-'))
}

/** Resolve scopes + per-bot stores for a bot list. */
function makeEnv({ bots = TWO_BOTS, config = {} } = {}) {
  const dir = tmp()
  const scopes = resolveBotScopes(bots, { dataDir: dir, ...config }, 'E:/ws')
  const stores = new Map(scopes.map(s => [s.botId, new StateStore({ dataDir: s.dataDir, botId: s.botId })]))
  return { dir, scopes, stores, scopeById: new Map(scopes.map(s => [s.botId, s])) }
}

/** Minimal agent registry stub: records requests, returns handles. */
function fakeFactory({ realSessionId, sessionModels } = {}) {
  const requests = []
  const selections = new Map()
  const disposals = []
  const live = new Map()
  const sessionSelectionCalls = []
  const handleFor = (id, label) => ({
    agent: {
      session: { id },
      status: 'idle',
      followup() {},
      cancel() {},
    },
    async dispose() { disposals.push(label) },
  })
  return {
    requests,
    selections,
    disposals,
    sessionSelectionCalls,
    async create(request) {
      requests.push({ kind: 'create', ...request })
      const id = String(request.sessionId)
      const handle = handleFor(id, id)
      live.set(id, handle)
      return handle
    },
    async resume(request) {
      requests.push({ kind: 'resume', ...request })
      const id = realSessionId ?? String(request.sessionId)
      const handle = handleFor(id, id)
      live.set(id, handle)
      return handle
    },
    getLive(id) { return live.get(id)?.agent },
    setSelection(key, selection) {
      const known = selections.has(key) || requests.some(r => r.routeKey === key)
      selections.set(key, selection)
      return known
    },
    /** Model recorded on an existing conversation (the "inherited" model). */
    sessionSelection(id) {
      sessionSelectionCalls.push(id)
      return sessionModels?.[id]
    },
  }
}

/** SessionManager over an env + fake factory. */
function makeManager(env, factory, defaultCwd = 'E:/ws', defaultSelection) {
  return new SessionManager({
    factory,
    stores: env.stores,
    scopes: env.scopeById,
    defaultCwd,
    ...(defaultSelection !== undefined ? { defaultSelection } : {}),
    logger: silent,
  })
}

// ---------------------------------------------------------------- bot scope

test('duplicate bot ids are refused (fail loud, not last-wins)', () => {
  assert.throws(
    () => resolveBotScopes([{ id: 'dup', token: 'a' }, { id: 'dup', token: 'b' }], {}, 'E:/ws'),
    /重复的 bot id/,
  )
})

test('two bots sharing one token are refused (they would fight over getUpdates)', () => {
  assert.throws(
    () => resolveBotScopes([{ id: 'a', token: 'same' }, { id: 'b', token: 'same' }], {}, 'E:/ws'),
    /token 与/,
  )
})

test("a bot id containing ':' is refused (it would break botId:chatId keys)", () => {
  assert.throws(
    () => resolveBotScopes([{ id: 'a:b', token: 't' }], {}, 'E:/ws'),
    /含非法字符/,
  )
})

test('per-bot overrides win over plugin defaults and stay per bot', () => {
  const scopes = resolveBotScopes([
    { id: 'bot-a', token: 'ta', model: 'model-a', allowedUserIds: [1] },
    { id: 'bot-b', token: 'tb', model: 'model-b', allowAllUsers: true },
  ], { model: 'plugin-model', allowedUserIds: [9] }, 'E:/ws')
  const a = scopes.find(s => s.botId === 'bot-a')
  const b = scopes.find(s => s.botId === 'bot-b')
  assert.equal(a.model, 'model-a')
  assert.deepEqual(a.allowedUserIds, [1])
  assert.equal(a.allowAllUsers, false)
  assert.equal(b.model, 'model-b')
  assert.deepEqual(b.allowedUserIds, [9], 'bot-b inherits the plugin default list')
  assert.equal(b.allowAllUsers, true)
})

test('host-session visibility defaults off, host restart defaults to single-bot only', () => {
  const single = resolveBotScopes([{ id: 'only', token: 't' }], { dataDir: 'E:/d' }, 'E:/ws')
  const multi = resolveBotScopes(TWO_BOTS, { dataDir: 'E:/d' }, 'E:/ws')
  assert.equal(single[0].allowHostSessions, false)
  assert.equal(single[0].allowOpsRestart, true, 'single bot may restart its own host')
  assert.equal(multi[0].allowOpsRestart, false, 'restarting the host from one of N bots stops all')
  const opted = resolveBotScopes([{ id: 'a', token: 't', allowOpsRestart: true }], {}, 'E:/ws')
  assert.equal(opted[0].allowOpsRestart, true)
})

test('cross-bot session sharing is refused unless both bots opt in', () => {
  const shared = [{ id: 'bot-a', token: 'ta', bindings: { '1': 'session-x' } },
    { id: 'bot-b', token: 'tb', bindings: { '2': 'session-x' } }]
  assert.throws(
    () => assertSessionOwnership(resolveBotScopes(shared, { dataDir: 'E:/d' }, 'E:/ws')),
    /跨 Bot 会话共享/,
  )
  const opted = [{ ...shared[0], allowSharedSessions: true }, { ...shared[1], allowSharedSessions: true }]
  assert.doesNotThrow(() => assertSessionOwnership(resolveBotScopes(opted, { dataDir: 'E:/d' }, 'E:/ws')))
})

// -------------------------------------------------------------- state store

test('state store refuses keys belonging to another bot', () => {
  const env = makeEnv()
  const storeA = env.stores.get('bot-a')
  assert.throws(() => storeA.setChat('bot-b:1', { sessionId: 's', cwd: 'c', botId: 'bot-b' }), /跨 Bot 越界/)
  assert.throws(() => storeA.getChat('bot-b:1'), /跨 Bot 越界/)
  assert.throws(() => storeA.setChat('1', { sessionId: 's', cwd: 'c', botId: 'bot-a' }), /跨 Bot 越界/)
  assert.throws(() => storeA.setOffset('bot-b', 5), /offset 越界/)
  storeA.setChat('bot-a:1', { sessionId: 's', cwd: 'c', botId: 'bot-a' })
  assert.equal(storeA.getChat('bot-a:1').sessionId, 's')
})

test('each bot persists into its own file', () => {
  const env = makeEnv()
  env.stores.get('bot-a').setChat('bot-a:1', { sessionId: 'sa', cwd: 'c', botId: 'bot-a' })
  env.stores.get('bot-a').setOffset('bot-a', 111)
  env.stores.get('bot-a').flush()
  env.stores.get('bot-b').setChat('bot-b:2', { sessionId: 'sb', cwd: 'c', botId: 'bot-b' })
  env.stores.get('bot-b').flush()

  const fileA = stateFilePath(env.dir, 'bot-a')
  const fileB = stateFilePath(env.dir, 'bot-b')
  assert.ok(existsSync(fileA) && existsSync(fileB))
  const rawA = readFileSync(fileA, 'utf8')
  const rawB = readFileSync(fileB, 'utf8')
  assert.match(rawA, /bot-a:1/)
  assert.doesNotMatch(rawA, /bot-b:2/)
  assert.match(rawB, /bot-b:2/)
  assert.doesNotMatch(rawB, /bot-a:1/)
  assert.match(rawA, /"bot-a": 111/)
  assert.ok(!existsSync(join(env.dir, 'state.json')), 'no shared legacy file is written')
})

test('legacy shared state is split per bot and the original is preserved', () => {
  const dir = tmp()
  const legacy = {
    chats: {
      'bot-a:1': { sessionId: 'sa', cwd: 'E:/ws', botId: 'bot-a' },
      'bot-b:2': { sessionId: 'sb', cwd: 'E:/ws', botId: 'bot-b' },
      'bot-c:3': { sessionId: 'sc', cwd: 'E:/ws', botId: 'bot-c' },
    },
    offsets: { 'bot-a': 10, 'bot-b': 20, 'bot-c': 30 },
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(legacy), 'utf8')
  const report = migrateLegacyState(dir, ['bot-a', 'bot-b'], silent)

  assert.deepEqual(report.migrated.sort(), ['bot-a', 'bot-b'])
  assert.deepEqual(report.orphans, ['bot-c:3'])
  const a = JSON.parse(readFileSync(stateFilePath(dir, 'bot-a'), 'utf8'))
  assert.equal(a.chats['bot-a:1'].sessionId, 'sa')
  assert.equal(a.offsets['bot-a'], 10)
  assert.equal(a.chats['bot-c:3'], undefined)
  assert.ok(!existsSync(join(dir, 'state.json')), 'legacy file retired')
  assert.ok(existsSync(report.backup), 'backup copy kept')
  assert.ok(readdirSync(dir).some(n => n.includes('.migrated-')), 'legacy file archived, never deleted')
})

test('legacy bare chatId migrates only with a single bot', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    chats: { '77': { sessionId: 's77', cwd: 'E:/ws', botId: '' } },
    offsets: {},
  }), 'utf8')
  const report = migrateLegacyState(dir, ['only'], silent)
  assert.deepEqual(report.migrated, ['only'])
  const file = JSON.parse(readFileSync(stateFilePath(dir, 'only'), 'utf8'))
  // The bare legacy key is renamed to the canonical namespaced form.
  assert.equal(file.chats['only:77'].sessionId, 's77')
  assert.equal(file.chats['only:77'].botId, 'only')
  assert.equal(file.chats['77'], undefined)
})

test('legacy bare chatId aborts migration when several bots exist (no guessed owner)', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'state.json')
  writeFileSync(legacyPath, JSON.stringify({ chats: { '77': { sessionId: 's77', cwd: 'E:/ws', botId: '' } }, offsets: {} }), 'utf8')
  assert.throws(() => migrateLegacyState(dir, ['bot-a', 'bot-b'], silent), /裸 chatId/)
  assert.ok(existsSync(legacyPath), 'legacy file left untouched on refusal')
  assert.ok(!existsSync(stateFilePath(dir, 'bot-a')), 'no partial migration')
})

// ----------------------------------------------------------- session manager

test('resume records the real resumed session id, not the template id', async () => {
  const env = makeEnv()
  const factory = fakeFactory({ realSessionId: 'session-real-uuid' })
  env.stores.get('bot-a').setChat('bot-a:5', { sessionId: 'session-old-uuid', cwd: 'E:/ws', botId: 'bot-a' })
  const manager = makeManager(env, factory)

  const binding = await manager.getOrCreate(5, 'bot-a')
  assert.equal(binding.sessionId, 'session-real-uuid')
  assert.equal(env.stores.get('bot-a').getChat('bot-a:5').sessionId, 'session-real-uuid')
  assert.ok(manager.isRelevant('session-real-uuid'))
  assert.equal(manager.bySessionId('session-real-uuid').chatId, 5)
})

test('/new always starts a fresh session and clears the route binding', async () => {
  const env = makeEnv()
  const factory = fakeFactory({ realSessionId: 'session-real-uuid' })
  env.stores.get('bot-a').setChat('bot-a:5', { sessionId: 'session-old-uuid', cwd: 'E:/ws', botId: 'bot-a' })
  const manager = makeManager(env, factory)
  await manager.getOrCreate(5, 'bot-a')
  manager.bind(5, 'bot-a', 'session-real-uuid', 'E:/ws')

  const rotated = await manager.rotate(5, 'bot-a')
  assert.notEqual(rotated.sessionId, 'session-real-uuid')
  assert.match(rotated.sessionId, /:g1$/)
  assert.equal(manager.getBound(5, 'bot-a'), undefined, 'the old binding no longer captures the chat')
  assert.equal(env.stores.get('bot-a').getChat('bot-a:5').sessionId, rotated.sessionId)
  assert.ok(factory.disposals.includes('session-real-uuid'), 'the old agent was disposed')
  assert.equal(factory.requests.filter(r => r.kind === 'resume').length, 1, '/new must not resume anything')
})

test('a session cannot be bound by two routes unless sharing is opted in', () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory())
  manager.bind(1, 'bot-a', 'session-shared', 'E:/ws')
  assert.throws(() => manager.bind(2, 'bot-a', 'session-shared', 'E:/ws'), /已被路由/)
  assert.throws(() => manager.bind(1, 'bot-b', 'session-shared', 'E:/ws'), /已被路由/)

  const sharing = makeEnv({ bots: TWO_BOTS.map(b => ({ ...b, allowSharedSessions: true })) })
  const sharedManager = makeManager(sharing, fakeFactory())
  sharedManager.bind(1, 'bot-a', 'session-shared', 'E:/ws')
  assert.doesNotThrow(() => sharedManager.bind(1, 'bot-b', 'session-shared', 'E:/ws'))
  assert.equal(sharedManager.byBoundSessionIds('session-shared').length, 2)
})

test('bare chatId bindings are single-bot only', () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory())
  assert.throws(() => manager.bind(9, '', 'session-bare', 'E:/ws'), /裸 chatId 绑定/)

  const one = makeEnv({ bots: [{ id: 'only', token: 't' }] })
  const single = makeManager(one, fakeFactory())
  single.bind(9, '', 'session-bare', 'E:/ws')
  assert.equal(single.getBound(9, 'only').sessionId, 'session-bare')
  assert.equal(single.getBound(9, 'only').botId, 'only')
})

test('model selection is per route and persisted per bot', async () => {
  const env = makeEnv()
  const factory = fakeFactory()
  const manager = makeManager(env, factory)
  await manager.getOrCreate(5, 'bot-a')

  assert.deepEqual(manager.modelFor(5, 'bot-a'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const liveApplied = manager.setModel(5, 'bot-a', 'prov-2', 'model-2')
  assert.equal(liveApplied, true, 'the live route selection is switched in place')
  assert.deepEqual(manager.modelFor(5, 'bot-a'), { provider: 'prov-2', model: 'model-2' })
  const persisted = env.stores.get('bot-a').getChat('bot-a:5')
  assert.equal(persisted.provider, 'prov-2')
  assert.equal(persisted.model, 'model-2')

  // Another bot's chat on the same id is unaffected.
  assert.deepEqual(manager.modelFor(5, 'bot-b'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.equal(env.stores.get('bot-b').getChat('bot-b:5'), undefined)
  assert.deepEqual(factory.selections.get('bot-a:5'), { provider: 'prov-2', model: 'model-2' })
  assert.equal(factory.selections.has('bot-b:5'), false)
})

test('a bot without a pinned model follows the host default (继续会话)', async () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory(), 'E:/ws', () => ({ provider: 'command-code', model: 'deepseek/deepseek-v4-flash-vision-exp' }))
  await manager.getOrCreate(5, 'bot-a')
  assert.deepEqual(manager.modelFor(5, 'bot-a'), {
    provider: 'command-code',
    model: 'deepseek/deepseek-v4-flash-vision-exp',
  })
  // Resuming/creating an agent carries that same effective selection.
  const factory = fakeFactory()
  const manager2 = makeManager(env, factory, 'E:/ws', () => ({ provider: 'command-code', model: 'host-model' }))
  await manager2.getOrCreate(6, 'bot-a')
  const request = factory.requests.at(-1)
  assert.equal(request.provider, 'command-code')
  assert.equal(request.model, 'host-model')
})

test('an explicitly pinned bot model wins over the host default', async () => {
  const env = makeEnv({ bots: TWO_BOTS.map(b => ({ ...b, provider: 'pinned-prov', model: 'pinned-model' })) })
  const manager = makeManager(env, fakeFactory(), 'E:/ws', () => ({ provider: 'host-prov', model: 'host-model' }))
  assert.deepEqual(manager.modelFor(9, 'bot-a'), { provider: 'pinned-prov', model: 'pinned-model' })
})

test('a per-chat pick wins over both the host default and the bot pin', async () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory(), 'E:/ws', () => ({ provider: 'host-prov', model: 'host-model' }))
  await manager.getOrCreate(5, 'bot-a')
  assert.deepEqual(manager.modelFor(5, 'bot-a'), { provider: 'host-prov', model: 'host-model' })
  manager.setModel(5, 'bot-a', 'picked-prov', 'picked-model')
  assert.deepEqual(manager.modelFor(5, 'bot-a'), { provider: 'picked-prov', model: 'picked-model' })
  // The host default is only ever READ: nothing about it is persisted.
  const state = env.stores.get('bot-a').getChat('bot-a:5')
  assert.equal(state.provider, 'picked-prov')
})

test('a bot falls back to its scope default when the host default is unavailable', async () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory(), 'E:/ws', () => undefined)
  assert.deepEqual(manager.modelFor(5, 'bot-b'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('agent creation carries the per-route selection and never touches the host default model', async () => {
  const created = []
  let hostDefaultTouched = 0
  const ctx = {
    agents: {
      async create(options) {
        created.push(options)
        return { agent: { session: { id: String(options.sessionId) }, followup() {}, cancel() {} }, async dispose() {} }
      },
      get() { return undefined },
    },
    // A host-global default model service that any write would be a leak.
    get(key) {
      if (key === 'agentDefaultModel') {
        return {
          currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }),
          saveSelection: async () => { hostDefaultTouched += 1 },
        }
      }
      return undefined
    },
  }
  const factory = new DshAgentFactory(ctx)
  await factory.create({ sessionId: 'telegram:a:1', cwd: 'E:/ws', provider: 'bot-prov', model: 'bot-model', routeKey: 'a:1' })
  assert.deepEqual(created[0].agentOptions, { provider: 'bot-prov', model: 'bot-model' })

  factory.setSelection('a:1', { provider: 'bot-prov-2', model: 'bot-model-2' })
  await factory.create({ sessionId: 'telegram:a:2', cwd: 'E:/ws', provider: 'bot-prov-2', model: 'bot-model-2', routeKey: 'a:1' })
  assert.deepEqual(created[1].agentOptions, { provider: 'bot-prov-2', model: 'bot-model-2' })
  assert.equal(hostDefaultTouched, 0, 'the host-global model selection is never written')
})

test('owner bookkeeping separates bots', async () => {
  const env = makeEnv()
  const factory = fakeFactory()
  const manager = makeManager(env, factory)
  const a = await manager.getOrCreate(11, 'bot-a')
  const b = await manager.getOrCreate(22, 'bot-b')
  assert.ok(manager.ownsSession('bot-a', a.sessionId))
  assert.equal(manager.ownsSession('bot-a', b.sessionId), false)
  assert.ok(manager.ownsSession('bot-b', b.sessionId))
  assert.equal(manager.ownsSession('bot-b', a.sessionId), false)
  assert.ok(manager.sessionIdsFor('bot-a').has(a.sessionId))
  assert.equal(manager.sessionIdsFor('bot-a').has(b.sessionId), false)
})

// ------------------------------------------------------------- stream routing

/** Delivery stub recording what reached it. */
function fakeDelivery(tag) {
  const texts = []
  let ended = 0
  return {
    tag,
    texts,
    endedCount: () => ended,
    async sendFinal(_chatId, text) { texts.push(text) },
    async sendMenu() {},
    async typing() {},
    startTyping() {},
    stopTyping() {},
    async appendDelta(_chatId, delta) { texts.push(delta) },
    async finalizeLive() { return false },
    resetStream() {},
    async endLive() { ended += 1 },
    discardLive() {},
  }
}

/** Cordis-like context recording event handlers. */
function fakeCtx() {
  const handlers = {}
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler
      return () => { delete handlers[event] }
    },
  }
}

test('session events never reach another bot delivery', async () => {
  const env = makeEnv()
  const factory = fakeFactory()
  const manager = makeManager(env, factory)
  const a = await manager.getOrCreate(11, 'bot-a')
  const b = await manager.getOrCreate(22, 'bot-b')

  const deliveryA = fakeDelivery('bot-a')
  const deliveryB = fakeDelivery('bot-b')
  const ctx = fakeCtx()
  const listener = new StreamListener({
    ctx,
    sessions: manager,
    deliveries: new Map([['bot-a', deliveryA], ['bot-b', deliveryB]]),
    logger: silent,
  })
  listener.start()

  const chunkFor = text => ({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } })
  ctx.handlers['session/event']({ id: a.sessionId }, chunkFor('for-a'))
  ctx.handlers['session/event']({ id: b.sessionId }, chunkFor('for-b'))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(deliveryA.texts, ['for-a'], 'bot-a receives only its own session output')
  assert.deepEqual(deliveryB.texts, ['for-b'], 'bot-b receives only its own session output')

  // A foreign session (another bot's, or the GUI's) is dropped entirely.
  ctx.handlers['session/event']({ id: 'session-not-ours' }, chunkFor('leak'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(deliveryA.texts, ['for-a'])
  assert.deepEqual(deliveryB.texts, ['for-b'])
})

test('a cancelling /stop only ends the owning bot live stream', async () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory())
  const a = await manager.getOrCreate(11, 'bot-a')
  const b = await manager.getOrCreate(22, 'bot-b')
  const deliveryA = fakeDelivery('bot-a')
  const deliveryB = fakeDelivery('bot-b')
  const ctx = fakeCtx()
  const listener = new StreamListener({
    ctx,
    sessions: manager,
    deliveries: new Map([['bot-a', deliveryA], ['bot-b', deliveryB]]),
    logger: silent,
  })
  listener.start()

  ctx.handlers['session/event']({ id: a.sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(deliveryA.endedCount(), 1)
  assert.equal(deliveryA.texts.length, 1)
  assert.equal(deliveryB.endedCount(), 0)
  assert.deepEqual(deliveryB.texts, [])
  assert.equal(manager.cancel(11, 'bot-b'), false, 'bot-b has no session for that chat')
  assert.equal(manager.cancel(11, 'bot-a'), true)
})

// ------------------------------------------------------- structural guards

test('the plugin never writes the host-global default model (source guard)', () => {
  /** Strip comments so documentation may name the service without failing. */
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const files = [
    new URL('../src/index.ts', import.meta.url),
    new URL('../src/harness/agent-factory.ts', import.meta.url),
    new URL('../src/core/session-manager.ts', import.meta.url),
  ]
  for (const url of files) {
    const code = stripComments(readFileSync(url, 'utf8'))
    assert.doesNotMatch(code, /saveSelection/, `${url.pathname} must not persist a host-global model`)
  }
  const factoryCode = stripComments(readFileSync(new URL('../src/harness/agent-factory.ts', import.meta.url), 'utf8'))
  assert.doesNotMatch(factoryCode, /agentDefaultModel/, 'agent creation must not read the host default model')
})

test('per-bot state and forward log live under the bot directory', () => {
  const env = makeEnv()
  const dirs = env.scopes.map(s => botDataDir(s.dataDir, s.botId))
  assert.equal(new Set(dirs).size, env.scopes.length, 'each bot gets a distinct data directory')
  for (const dir of dirs) {
    assert.match(dir.replace(/\\/g, '/'), /\/bots\/bot-[ab]$/)
  }
})

// ------------------------------------------------------- host default model

test('host default model is read from the settings.yaml block', () => {
  const text = [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    'agent-default-model:',
    '  provider: command-code',
    '  model: deepseek/deepseek-v4-flash-vision-exp',
    'ui-theme:',
    '  fontSize: 16',
  ].join('\n')
  assert.deepEqual(parseAgentDefaultModel(text), {
    provider: 'command-code',
    model: 'deepseek/deepseek-v4-flash-vision-exp',
  })
})

test('quoted values are unquoted and missing fields yield undefined', () => {
  assert.deepEqual(parseAgentDefaultModel([
    'agent-default-model:',
    "  provider: 'api-bridge'",
    '  model: "glm-5.3"',
  ].join('\n')), { provider: 'api-bridge', model: 'glm-5.3' })

  assert.equal(parseAgentDefaultModel(['agent-default-model:', '  provider: only-provider'].join('\n')), undefined)
  assert.equal(parseAgentDefaultModel('ui-theme:\n  fontSize: 16\n'), undefined)
  assert.equal(parseAgentDefaultModel(''), undefined)
})

test('the scan stops at the next top-level key (no bleed from nested blocks)', () => {
  const text = [
    'agent-default-model:',
    '  provider: command-code',
    'llm-pi-ai:',
    '  providers:',
    '    api-bridge:',
    '      model: should-not-be-used',
    'agent-default-model-extra:',
    '  model: also-not-used',
  ].join('\n')
  assert.equal(parseAgentDefaultModel(text), undefined, 'model comes from the wrong block -> refuse, do not guess')
})

test('readHostDefaultModel reads <home>/settings.yaml and tolerates a missing file', () => {
  const home = tmp()
  writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: command-code\n  model: host-model\n', 'utf8')
  assert.deepEqual(readHostDefaultModel(home), { provider: 'command-code', model: 'host-model' })
  assert.equal(readHostDefaultModel(join(home, 'nope')), undefined)
})

test('per-bot array fields that the schema materialized as [] still inherit the plugin list', () => {
  // The config schema turns an absent per-bot array into [] (verified against the
  // real schemastery validation), so `??`-style fallback silently lost the
  // plugin-level whitelist/workspace roots: every user was denied and the
  // workspace menu collapsed to a single entry.
  const scopes = resolveBotScopes(
    [{ id: 'bot-a', token: 't-a', allowedUserIds: [], workspaceRoots: [] }],
    { allowedUserIds: [6434599758], workspaceRoots: ['E:/ws'] },
    'E:/fallback',
  )
  assert.deepEqual(scopes[0].allowedUserIds, [6434599758])
  assert.deepEqual(scopes[0].workspaceRoots, ['E:/ws'])
})

test('an explicit per-bot list overrides the plugin list, an empty one never wins', () => {
  const scopes = resolveBotScopes([
    { id: 'bot-a', token: 't-a', allowedUserIds: [111], workspaceRoots: ['E:/a'] },
    { id: 'bot-b', token: 't-b', allowedUserIds: [] },
  ], { allowedUserIds: [222], workspaceRoots: ['E:/plugin'], dataDir: 'E:/d' }, 'E:/fallback')
  const a = scopes.find(s => s.botId === 'bot-a')
  const b = scopes.find(s => s.botId === 'bot-b')
  assert.deepEqual(a.allowedUserIds, [111])
  assert.deepEqual(a.workspaceRoots, ['E:/a'])
  assert.deepEqual(b.allowedUserIds, [222], 'empty per-bot list inherits instead of locking everyone out')
  assert.deepEqual(b.workspaceRoots, ['E:/plugin'], 'empty per-bot roots inherit the plugin roots')
})

test('after switching sessions the status shows the model that conversation inherits', () => {
  const env = makeEnv()
  const factory = fakeFactory({
    sessionModels: {
      'session-A': { provider: 'cmd', model: 'm-A' },
      'session-B': { provider: 'cmd', model: 'm-B' },
    },
  })
  const manager = makeManager(env, factory, 'E:/ws', () => ({ provider: 'host-prov', model: 'host-model' }))
  manager.bind(5, 'bot-a', 'session-A', 'E:/ws')
  assert.deepEqual(manager.modelInfo(5, 'bot-a'), { provider: 'cmd', model: 'm-A', source: 'session' })

  // An explicit pick applies to the session it was made on.
  manager.setModel(5, 'bot-a', 'picked', 'picked-model')
  assert.deepEqual(manager.modelInfo(5, 'bot-a'), { provider: 'picked', model: 'picked-model', source: 'chat' })

  // Switching to another conversation must surface THAT conversation's model
  // instead of the stale pick (this was the reported display bug).
  manager.bind(5, 'bot-a', 'session-B', 'E:/ws')
  assert.deepEqual(manager.modelInfo(5, 'bot-a'), { provider: 'cmd', model: 'm-B', source: 'session' })
  assert.deepEqual(manager.modelFor(5, 'bot-a'), { provider: 'cmd', model: 'm-B' })
})

test('with no session model the status falls back to host default, then the bot value', () => {
  const env = makeEnv()
  const withHost = makeManager(env, fakeFactory(), 'E:/ws', () => ({ provider: 'host-prov', model: 'host-model' }))
  assert.deepEqual(withHost.modelInfo(9, 'bot-a'), { provider: 'host-prov', model: 'host-model', source: 'host' })

  const noHost = makeManager(env, fakeFactory(), 'E:/ws', () => undefined)
  assert.deepEqual(noHost.modelInfo(9, 'bot-a'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    source: 'bot',
  })
})

test('a fresh session keeps using the route selection, not a foreign session model', async () => {
  const env = makeEnv()
  const factory = fakeFactory({ sessionModels: { 'session-other': { provider: 'cmd', model: 'm-other' } } })
  const manager = makeManager(env, factory, 'E:/ws', () => ({ provider: 'host-prov', model: 'host-model' }))
  const binding = await manager.getOrCreate(5, 'bot-a')
  assert.notEqual(binding.sessionId, 'session-other')
  assert.deepEqual(manager.modelInfo(5, 'bot-a'), { provider: 'host-prov', model: 'host-model', source: 'host' })
})

// ------------------------------------------------- restart / session survival

test('after a restart the persisted session is still active (no loss, marker intact)', async () => {
  const env = makeEnv()
  const factory = fakeFactory()
  const before = makeManager(env, factory)
  const created = await before.getOrCreate(5, 'bot-a')

  // Simulate a DSH restart: brand-new manager/factory over the same state store.
  const restarted = makeManager(env, fakeFactory())
  assert.equal(restarted.activeSessionId(5, 'bot-a'), created.sessionId,
    'the session list must still mark the conversation that will be resumed')
  assert.equal(restarted.get(5, 'bot-a'), undefined, 'no live binding exists yet')

  const resumed = await restarted.getOrCreate(5, 'bot-a')
  assert.equal(resumed.sessionId, created.sessionId, 'the same conversation continues')
  assert.equal(restarted.activeSessionId(5, 'bot-a'), created.sessionId)
})

test('an already-live session is adopted, never resumed (a failed resume would start a fresh session)', async () => {
  const env = makeEnv()
  const factory = fakeFactory()
  const before = makeManager(env, factory)
  const created = await before.getOrCreate(5, 'bot-a')
  const callsBefore = factory.requests.length

  // Same process, same registry: the agent for that session is still live.
  const restarted = makeManager(env, factory)
  const adopted = await restarted.getOrCreate(5, 'bot-a')
  assert.equal(adopted.sessionId, created.sessionId)
  assert.equal(factory.requests.length, callsBefore, 'no resume/create call was made for a live session')
  assert.equal(factory.disposals.length, 0, 'the plugin must not dispose an agent it does not own')
})

test('the active-session marker follows a menu-chosen binding across a restart', () => {
  const env = makeEnv()
  const before = makeManager(env, fakeFactory())
  before.bind(5, 'bot-a', 'session-chosen', 'E:/ws')
  before.setCwd(5, 'bot-a', 'E:/projects/x')
  assert.equal(before.activeSessionId(5, 'bot-a'), 'session-chosen')

  const restarted = makeManager(env, fakeFactory())
  assert.equal(restarted.getBound(5, 'bot-a'), undefined, 'menu bindings are not config bindings')
  assert.equal(restarted.activeSessionId(5, 'bot-a'), 'session-chosen',
    'the persisted session keeps its marker and is the one that gets resumed')
})

// --------------------------------------------------------------- proxy chain

test('the environment proxy is the last-resort Telegram proxy', () => {
  const scopes = resolveBotScopes(
    [{ id: 'a', token: 't1' }, { id: 'b', token: 't2', proxy: 'http://bot-proxy' }],
    { proxy: 'http://plugin-proxy', dataDir: 'E:/d' },
    'E:/ws',
    'http://env-proxy',
  )
  assert.equal(scopes.find(s => s.botId === 'a').proxy, 'http://plugin-proxy',
    'plugin config beats the environment proxy')
  assert.equal(scopes.find(s => s.botId === 'b').proxy, 'http://bot-proxy',
    'per-bot proxy beats the plugin config')

  const envOnly = resolveBotScopes([{ id: 'c', token: 't3' }], { dataDir: 'E:/d' }, 'E:/ws', 'http://env-proxy')
  assert.equal(envOnly[0].proxy, 'http://env-proxy',
    'a machine-wide TELEGRAM_PROXY/HTTPS_PROXY must still reach Telegram (no direct-connect timeout)')

  const explicitEmpty = resolveBotScopes([{ id: 'd', token: 't4', proxy: '' }], { dataDir: 'E:/d' }, 'E:/ws', 'http://env-proxy')
  assert.equal(explicitEmpty[0].proxy, 'http://env-proxy', 'an empty string is treated as "not set"')

  const none = resolveBotScopes([{ id: 'e', token: 't5' }], { dataDir: 'E:/d' }, 'E:/ws')
  assert.equal(none[0].proxy, undefined, 'no proxy anywhere -> undefined (plugin logs a direct-connect warning)')
})

// ------------------------------------------------------------ poll cursor

test('an undefined poll offset never erases the restored cursor', () => {
  // The periodic flush runs from plugin start, while a bot's cursor is still
  // unset; storing that undefined would make Telegram re-deliver already-answered
  // updates after the next restart.
  const env = makeEnv()
  const store = env.stores.get('bot-a')
  store.setOffset('bot-a', 4242)
  store.setOffset('bot-a', undefined)
  assert.equal(store.getOffset('bot-a'), 4242, 'an undefined write is ignored, not stored')
  store.flush()
  const file = JSON.parse(readFileSync(stateFilePath(env.dir, 'bot-a'), 'utf8'))
  assert.equal(file.offsets['bot-a'], 4242, 'the cursor survives a restart')
})

test('a session chosen later wins over the static config binding', () => {
  // The config binding is re-applied on every start; without this precedence the
  // operator's menu choice was silently replaced after each restart.
  assert.equal(preferSession('session-from-config', 'session-chosen-by-user'), 'session-chosen-by-user')
  assert.equal(preferSession('session-from-config', undefined), 'session-from-config', 'first start seeds from config')
  assert.equal(preferSession('session-from-config', ''), 'session-from-config', 'an empty record is not a choice')
})

test('the config binding is seeded only into the chat state, and the choice survives', () => {
  const env = makeEnv()
  const manager = makeManager(env, fakeFactory())
  // Startup seeding (what index.ts does for a config binding).
  const persisted = env.stores.get('bot-a').getChat('bot-a:5')?.sessionId
  manager.bind(5, 'bot-a', preferSession('session-from-config', persisted), 'E:/ws')
  assert.equal(manager.activeSessionId(5, 'bot-a'), 'session-from-config')
  assert.equal(env.stores.get('bot-a').getChat('bot-a:5').sessionId, 'session-from-config')

  // The operator picks another session from the menu.
  manager.bind(5, 'bot-a', 'session-chosen-by-user', 'E:/ws')

  // Next start: the persisted choice must win over the config binding.
  const restarted = makeManager(env, fakeFactory())
  const persisted2 = env.stores.get('bot-a').getChat('bot-a:5')?.sessionId
  assert.equal(persisted2, 'session-chosen-by-user')
  restarted.bind(5, 'bot-a', preferSession('session-from-config', persisted2), 'E:/ws')
  assert.equal(restarted.activeSessionId(5, 'bot-a'), 'session-chosen-by-user',
    'the restart keeps driving the conversation the operator picked')
})

test('an offline session still shows its own model (no wait for the first message)', () => {
  const env = makeEnv()
  // No live agent anywhere: the factory cannot answer, so the lookup does.
  const manager = new SessionManager({
    factory: fakeFactory(),
    stores: env.stores,
    scopes: env.scopeById,
    defaultCwd: 'E:/ws',
    defaultSelection: () => ({ provider: 'host-prov', model: 'host-model' }),
    sessionModelLookup: id => (id === 'session-cached' ? { provider: 'cmd', model: 'm-cached' } : undefined),
    logger: silent,
  })
  manager.bind(5, 'bot-a', 'session-cached', 'E:/ws')
  assert.deepEqual(manager.modelInfo(5, 'bot-a'), { provider: 'cmd', model: 'm-cached', source: 'session' })

  // Unknown session -> the deployment default is still the fallback.
  manager.bind(6, 'bot-a', 'session-unknown', 'E:/ws')
  assert.deepEqual(manager.modelInfo(6, 'bot-a'), { provider: 'host-prov', model: 'host-model', source: 'host' })
})

// ------------------------------------------------- session list directory scope

test('the session list exposes only the current directory, never a foreign active session', () => {
  const list = [
    { id: 'a1', cwd: 'E:\\dir-a', updatedAt: 300 },
    { id: 'a2', cwd: 'e:/DIR-A/', updatedAt: 100 },
    { id: 'b1', cwd: 'E:\\dir-b', updatedAt: 200 },
    { id: 'no-cwd', cwd: undefined, updatedAt: 400 },
  ]
  // Directory A: newest first, no session from B, and A's active session is marked.
  const inA = scopeSessionsToDir(list, 'E:\\dir-a', 'a1')
  assert.deepEqual(inA.scoped.map(s => s.id), ['a1', 'a2'], 'separator/case-insensitive match, newest first')
  assert.equal(inA.activeInScope, true)

  // Directory B: the session chosen in A must NOT appear, and there is no ✅.
  const inB = scopeSessionsToDir(list, 'E:\\dir-b', 'a1')
  assert.deepEqual(inB.scoped.map(s => s.id), ['b1'])
  assert.equal(inB.activeInScope, false, 'an active session from another directory is not shown as selected')

  // A directory with no sessions yields an empty scope (the menu then says so
  // instead of silently listing every session again).
  const empty = scopeSessionsToDir(list, 'E:\\dir-c', 'a1')
  assert.deepEqual(empty.scoped, [])
  assert.equal(empty.activeInScope, false)

  // Entries without a cwd never match any directory.
  assert.equal(scopeSessionsToDir(list, 'E:\\dir-a', 'no-cwd').scoped.some(s => s.id === 'no-cwd'), false)
})
