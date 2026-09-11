/**
 * 工作目录切换释放会话 + boundFollowup 工具世界回归测试（编译后的 lib）。
 *
 * 问题一（切目录不释放会话）：switchCwd 到不同目录必须让 chat 进入「无会话」态 ——
 * 活绑定(bindings)、配置绑定(bound)、持久化 sessionId 全部释放，activeSessionId
 * 返回 undefined；下一条普通消息在 bot-manager 弹出带「🆕 新建会话」的会话选择列表，
 * 绝不能继续驱动旧会话。选同一目录（大小写/分隔符不同）是 no-op。
 *
 * 问题二（选回自建会话无工具）：boundFollowup 对自建 telegram 会话 resume 必须
 * 重新挂 agent preset（chat 已选优先，其次宿主默认），否则 resume 出来的会话工具
 * 世界为空（dd5cbac 修过 create/getOrCreate 路径，这里补齐菜单选回路径）。
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
const BOTS = [{ id: 'bot-a', token: 'token-a' }]

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-detach-'))
  const scopes = resolveBotScopes(BOTS, { dataDir: dir }, 'E:/ws')
  const stores = new Map(scopes.map(s => [s.botId, new StateStore({ dataDir: s.dataDir, botId: s.botId })]))
  return { scopes, stores, scopeById: new Map(scopes.map(s => [s.botId, s])) }
}

/** Fake factory recording create/resume requests and agent disposals. */
function makeFactory() {
  const requests = []
  const disposed = []
  const followups = []
  const handleFor = (id) => ({
    agent: {
      session: { id },
      status: 'idle',
      followup(message) { followups.push({ id, text: message?.content?.[0]?.text ?? '' }) },
      cancel() {},
    },
    async dispose() { disposed.push(id) },
  })
  return {
    requests, disposed, followups,
    async create(request) { requests.push({ kind: 'create', ...request }); return handleFor(String(request.sessionId)) },
    async resume(request) { requests.push({ kind: 'resume', ...request }); return handleFor(String(request.sessionId)) },
    getLive() { return undefined },
    setSelection() { return true },
  }
}

function makeManager(env, factory, defaultCwd = 'E:/ws', extra = {}) {
  return new SessionManager({ factory, stores: env.stores, scopes: env.scopeById, defaultCwd, logger: silent, ...extra })
}

test('switchCwd 切到不同目录: 释放活绑定/配置绑定/持久化会话, chat 进入无会话态', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 5
  const key = 'bot-a:5'

  const first = await sessions.getOrCreate(chatId, 'bot-a')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), first.sessionId)

  const detached = await sessions.switchCwd(chatId, 'bot-a', 'E:/other')

  assert.equal(detached, true, '有会话时切换应报告已释放')
  assert.equal(sessions.get(chatId, 'bot-a'), undefined, '活绑定必须删除, 否则 getOrCreate 返回已 dispose 的死句柄')
  assert.equal(sessions.getBound(chatId, 'bot-a'), undefined, '配置/菜单绑定必须清除')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), undefined, '无会话态: 下一条消息应弹会话选择列表')
  const state = env.stores.get('bot-a').getChat(key)
  assert.equal(state.sessionId, '', '持久化 sessionId 清空')
  assert.equal(state.sessionDetached, true, '显式分离标记落盘')
  assert.equal(state.cwd, 'E:/other', '新工作目录已持久化')
  assert.deepEqual(factory.disposed, [first.sessionId], '自建会话的 agent 已 dispose')
})

test('switchCwd 后 getOrCreate 走 fresh 创建(绝不 resume 已释放的旧会话)', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 6

  const first = await sessions.getOrCreate(chatId, 'bot-a')
  await sessions.switchCwd(chatId, 'bot-a', 'E:/other')
  const second = await sessions.getOrCreate(chatId, 'bot-a')

  const kinds = factory.requests.map(r => r.kind)
  assert.equal(kinds[kinds.length - 1], 'create', '释放后重建必须是 fresh create')
  assert.notEqual(second.cwd, 'E:/ws')
  assert.equal(second.cwd, 'E:/other', '新会话使用切换后的目录')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), second.sessionId)
  const state = env.stores.get('bot-a').getChat('bot-a:6')
  assert.equal(state.sessionDetached, false, '重新挂上会话后清除分离标记')
})

test('switchCwd 同一目录(仅大小写/分隔符不同)为 no-op, 会话保留', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 7

  const first = await sessions.getOrCreate(chatId, 'bot-a')
  const detached = await sessions.switchCwd(chatId, 'bot-a', 'e:\\WS\\')

  assert.equal(detached, false, '同目录切换不释放会话')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), first.sessionId)
  assert.equal(factory.disposed.length, 0, '不得 dispose 正在使用的 agent')
})

test('菜单选回会话(bind)清除分离标记, activeSessionId 恢复', async () => {
  const env = makeEnv()
  const sessions = makeManager(env, makeFactory())
  const chatId = 8

  await sessions.getOrCreate(chatId, 'bot-a')
  await sessions.switchCwd(chatId, 'bot-a', 'E:/other')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), undefined)

  sessions.bind(chatId, 'bot-a', 'telegram:bot-a:8', 'E:/other')

  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), 'telegram:bot-a:8')
  assert.equal(env.stores.get('bot-a').getChat('bot-a:8').sessionDetached, false)
})

test('switchCwd 释放外来(GUI)绑定会话时不 dispose 其 agent', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 9

  sessions.bind(chatId, 'bot-a', 'session-0f0e0d0c-0b0a-4909-8807-060504030201', 'E:/ws')
  const detached = await sessions.switchCwd(chatId, 'bot-a', 'E:/other')

  assert.equal(detached, true)
  assert.equal(sessions.getBound(chatId, 'bot-a'), undefined, '绑定解除')
  assert.equal(factory.disposed.length, 0, '外来会话的 agent 不归本插件销毁')
})

test('boundFollowup: 自建会话 resume 必须带 preset(chat 已选优先, 其次宿主默认)', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory, 'E:/ws', { defaultPresetId: () => 'standard' })
  const chatId = 10

  // 宿主默认 preset
  sessions.bind(chatId, 'bot-a', 'telegram:bot-a:10', 'E:/ws')
  await sessions.boundFollowup(chatId, 'bot-a', 'hello')
  let resume = [...factory.requests].reverse().find(r => r.kind === 'resume')
  assert.equal(resume.agentPreset, 'standard', '自建会话 resume 必须重新挂宿主默认 preset')

  // chat 已选工作方式优先
  sessions.setPreset(chatId, 'bot-a', 'dev')
  sessions.bind(chatId, 'bot-a', 'telegram:bot-a:10:g1', 'E:/ws')
  await sessions.boundFollowup(chatId, 'bot-a', 'again')
  resume = [...factory.requests].reverse().find(r => r.kind === 'resume')
  assert.equal(resume.agentPreset, 'dev', 'chat 已选 preset 应优先于宿主默认')

  assert.ok(factory.followups.length >= 2, 'followup 消息必须送达到 resume 出来的 agent')
})

test('boundFollowup: 外来(GUI)会话 resume 不挂 preset(保持创建者的组合)', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory, 'E:/ws', { defaultPresetId: () => 'standard' })
  const chatId = 11

  sessions.bind(chatId, 'bot-a', 'session-1f1e1d1c-1b1a-4909-8807-060504030201', 'E:/ws')
  await sessions.boundFollowup(chatId, 'bot-a', 'hi')

  const resume = [...factory.requests].reverse().find(r => r.kind === 'resume')
  assert.equal('agentPreset' in resume, false, '外来会话不挂我们的 preset')
})
