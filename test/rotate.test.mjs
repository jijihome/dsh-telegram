/**
 * 「新建会话」回归测试（编译后的 lib）：
 * - rotate() 必须用**当前选定的工作目录**（持久化状态），而不是旧绑定的 cwd；
 * - rotate() 铸新会话 id 并清掉配置绑定；
 * - 确认文案必须包含 新会话 id、工作目录、（如有）被丢弃的旧会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBotScopes } from '../lib/core/bot-scope.js'
import { StateStore } from '../lib/core/state-store.js'
import { SessionManager } from '../lib/core/session-manager.js'
import { handleMenuCallback } from '../lib/telegram/menu.js'

const silent = { warn() {}, error() {} }
const BOTS = [{ id: 'bot-a', token: 'token-a' }]

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-rotate-'))
  const scopes = resolveBotScopes(BOTS, { dataDir: dir }, 'E:/ws')
  const stores = new Map(scopes.map(s => [s.botId, new StateStore({ dataDir: s.dataDir, botId: s.botId })]))
  return { scopes, stores, scopeById: new Map(scopes.map(s => [s.botId, s])) }
}

/** Fake factory recording every create/resume request (so cwd is inspectable). */
function makeFactory() {
  const requests = []
  const handleFor = (id) => ({
    agent: { session: { id }, status: 'idle', followup() {}, cancel() {} },
    async dispose() {},
  })
  return {
    requests,
    async create(request) { requests.push({ kind: 'create', ...request }); return handleFor(String(request.sessionId)) },
    async resume(request) { requests.push({ kind: 'resume', ...request }); return handleFor(String(request.sessionId)) },
    getLive() { return undefined },
  }
}

function makeManager(env, factory, defaultCwd = 'E:/ws') {
  return new SessionManager({ factory, stores: env.stores, scopes: env.scopeById, defaultCwd, logger: silent })
}

test('rotate 用当前选定的工作目录(而不是旧绑定的 cwd) —— 回归', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory, 'E:/old')
  const chatId = 42

  // 先建一个会话(默认目录 E:/old), 再切换到新目录
  const first = await sessions.getOrCreate(chatId, 'bot-a')
  assert.equal(first.cwd, 'E:/old')
  sessions.setCwd(chatId, 'bot-a', 'E:/new')

  const rotated = await sessions.rotate(chatId, 'bot-a')

  assert.equal(rotated.cwd, 'E:/new', 'rotate 必须用切换后的工作目录')
  const lastCreate = [...factory.requests].reverse().find(r => r.kind === 'create')
  assert.equal(lastCreate.cwd, 'E:/new', 'factory.create 必须收到新目录')
})

test('rotate 铸新会话 id 并清掉配置绑定', async () => {
  const env = makeEnv()
  const sessions = makeManager(env, makeFactory())
  const chatId = 7

  sessions.bind(chatId, 'bot-a', 'session-old-uuid', 'E:/ws')
  assert.equal(sessions.getBound(chatId, 'bot-a')?.sessionId, 'session-old-uuid')

  const rotated = await sessions.rotate(chatId, 'bot-a')

  assert.notEqual(rotated.sessionId, 'session-old-uuid', '必须是全新会话 id')
  assert.ok(rotated.sessionId.startsWith('telegram:bot-a:'), `新 id 形如 telegram:bot-a:..., 实际 ${rotated.sessionId}`)
  assert.equal(sessions.getBound(chatId, 'bot-a'), undefined, '配置绑定已清除, 否则下一条消息仍走旧会话')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), rotated.sessionId, '活动会话应指向新会话')
})

test('新建会话确认文案含 新会话/工作目录/已丢弃旧会话', async () => {
  const ctx = {
    chatId: 1,
    botId: 'bot-a',
    sessions: {
      activeSessionId: () => 'telegram:bot-a:1:g1',
      rotate: async () => ({ sessionId: 'telegram:bot-a:1:g2', cwd: 'E:/projects/demo' }),
    },
  }
  const res = await handleMenuCallback('menu:new', ctx)
  assert.ok(res.text.includes('已开启新会话'), res.text)
  assert.ok(res.text.includes('telegram:bot-a:1:g2'), '显示新会话 id')
  assert.ok(res.text.includes('E:/projects/demo'), '显示工作目录')
  assert.ok(res.text.includes('telegram:bot-a:1:g1'), '显示被丢弃的旧会话')
})

test('清除会话确认文案同样含 工作目录', async () => {
  const ctx = {
    chatId: 1,
    botId: 'bot-a',
    sessions: {
      activeSessionId: () => undefined,
      rotate: async () => ({ sessionId: 'telegram:bot-a:1:g1', cwd: 'E:/ws/other' }),
    },
  }
  const res = await handleMenuCallback('menu:clear', ctx)
  assert.ok(res.text.includes('E:/ws/other'), res.text)
  // 没有旧会话时不显示「已丢弃」
  assert.ok(!res.text.includes('已丢弃'), '无旧会话时不应出现「已丢弃」')
})