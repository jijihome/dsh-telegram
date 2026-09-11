/**
 * 会话管理三件套测试（编译后的 lib）：重命名 / 归档 / 删除(=归档)。
 *
 * 三个层面：
 * 1. RenamePendingStore —— 两步重命名的占位槽（下一条文本即标题），含超时失效。
 * 2. SessionManager.detach() —— 归档「当前会话」时释放绑定：自建会话免费 dispose、
 *    外来(GUI)会话只解绑不销毁、cwd 与模型保持不变、chat 进入无会话态。
 * 3. 菜单回调链路 —— 🛠 管理会话 → 详情卡 → ✏️ 重命名 / 🗄 归档（二次确认）。
 *
 * 方案定稿：删除 = 归档（方案2），宿主归档集是唯一隐藏面，无独立真删交互。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBotScopes } from '../lib/core/bot-scope.js'
import { StateStore } from '../lib/core/state-store.js'
import { SessionManager } from '../lib/core/session-manager.js'
import { RenamePendingStore } from '../lib/core/rename-pending.js'
import { handleMenuCallback } from '../lib/telegram/menu.js'

const silent = { warn() {}, error() {} }
const BOTS = [{ id: 'bot-a', token: 'token-a' }]

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-manage-'))
  const scopes = resolveBotScopes(BOTS, { dataDir: dir }, 'E:/ws')
  const stores = new Map(scopes.map(s => [s.botId, new StateStore({ dataDir: s.dataDir, botId: s.botId })]))
  return { scopes, stores, scopeById: new Map(scopes.map(s => [s.botId, s])) }
}

/** Fake factory recording create/resume requests and agent disposals. */
function makeFactory() {
  const requests = []
  const disposed = []
  const handleFor = (id) => ({
    agent: { session: { id }, status: 'idle', followup() {}, cancel() {} },
    async dispose() { disposed.push(id) },
  })
  return {
    requests, disposed,
    async create(request) { requests.push({ kind: 'create', ...request }); return handleFor(String(request.sessionId)) },
    async resume(request) { requests.push({ kind: 'resume', ...request }); return handleFor(String(request.sessionId)) },
    getLive() { return undefined },
    setSelection() { return true },
  }
}

function makeManager(env, factory, defaultCwd = 'E:/ws', extra = {}) {
  return new SessionManager({ factory, stores: env.stores, scopes: env.scopeById, defaultCwd, logger: silent, ...extra })
}

/* ----------------------------------------------------------- 1. RenamePendingStore */

test('renamePending: begin 登记目标, active 可查, clear 清理', () => {
  const store = new RenamePendingStore({ timeoutMs: 120_000 })
  assert.equal(store.active(10, 'bot-a'), undefined, '初始无 pending')
  assert.equal(store.active(10, 'bot-b'), undefined, '不同 bot 隔离')
  store.begin(10, 'bot-a', 'telegram:bot-a:10:g1')
  assert.deepEqual(store.active(10, 'bot-a'), { sessionId: 'telegram:bot-a:10:g1' })
  assert.equal(store.active(11, 'bot-a'), undefined, '不同 chat 隔离')
  store.clear(10, 'bot-a')
  assert.equal(store.active(10, 'bot-a'), undefined, 'clear 后清空')
})

test('renamePending: begin 覆盖同名占位(重进重命名), 不叠加', () => {
  const store = new RenamePendingStore({ timeoutMs: 120_000 })
  store.begin(10, 'bot-a', 's1')
  store.begin(10, 'bot-a', 's2')
  assert.deepEqual(store.active(10, 'bot-a'), { sessionId: 's2' }, '后登记覆盖先登记')
})

test('renamePending: 超时自动失效并触发 onExpire 通知', async () => {
  const expired = []
  const store = new RenamePendingStore({
    timeoutMs: 30,
    onExpire: (pending, chatId, botId) => expired.push({ pending, chatId, botId }),
  })
  store.begin(10, 'bot-a', 'telegram:bot-a:10:g1')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(store.active(10, 'bot-a'), undefined, '超时后占位清空（下一条文本恢复正常消息）')
  assert.equal(expired.length, 1)
  assert.equal(expired[0].chatId, 10)
  assert.deepEqual(expired[0].pending, { sessionId: 'telegram:bot-a:10:g1' })
})

test('renamePending: clear 后再超时不触发 onExpire', async () => {
  let called = 0
  const store = new RenamePendingStore({ timeoutMs: 30, onExpire: () => { called++ } })
  store.begin(10, 'bot-a', 's1')
  store.clear(10, 'bot-a')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(called, 0, '已被 clear 的占位不再通知')
})

/* ------------------------------------------------------------- 2. SessionManager.detach */

test('detach: 释放自建会话(dispose agent), 清持久化 sessionId, 标 detached, cwd 不变', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 5
  const key = 'bot-a:5'
  sessions.setCwd(chatId, 'bot-a', 'E:/work')
  const { sessionId } = await sessions.getOrCreate(chatId, 'bot-a')

  const detached = await sessions.detach(chatId, 'bot-a')

  assert.equal(detached, true, '有会话时批量报告已释放')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), undefined, '进入无会话态')
  assert.equal(sessions.get(chatId, 'bot-a'), undefined, '活绑定删除')
  assert.equal(sessions.getBound(chatId, 'bot-a'), undefined, '配置绑定清除')
  const state = env.stores.get('bot-a').getChat(key)
  assert.equal(state.sessionId, '', '持久化 sessionId 清空')
  assert.equal(state.sessionDetached, true, '分离标记落盘')
  assert.equal(state.cwd, 'E:/work', '归档当前会话保留工作目录(归档只释放会话,不切目录)')
  assert.deepEqual(factory.disposed, [sessionId], '自建会话的 agent 被 dispose')
})

test('detach: 外来(GUI)会话只解绑不 dispose 其 agent', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 6
  sessions.bind(chatId, 'bot-a', 'session-0f0e0d0c-0b0a-4909-8807-060504030201', 'E:/ws')

  const detached = await sessions.detach(chatId, 'bot-a')

  assert.equal(detached, true)
  assert.equal(sessions.getBound(chatId, 'bot-a'), undefined, '绑定解除')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), undefined)
  assert.equal(factory.disposed.length, 0, '外来会话的 agent 不归本插件销毁')
})

test('detach: 无会话时是 no-op(返回 false, 不崩)', async () => {
  const env = makeEnv()
  const sessions = makeManager(env, makeFactory())
  const detached = await sessions.detach(999, 'bot-a')
  assert.equal(detached, false, '没有会话要释放')
})

test('detach 后 getOrCreate 重建走 fresh create, 且使用保留的 cwd', async () => {
  const env = makeEnv()
  const factory = makeFactory()
  const sessions = makeManager(env, factory)
  const chatId = 7
  sessions.setCwd(chatId, 'bot-a', 'E:/work')
  await sessions.getOrCreate(chatId, 'bot-a')
  await sessions.detach(chatId, 'bot-a')

  const second = await sessions.getOrCreate(chatId, 'bot-a')

  const kinds = factory.requests.map(r => r.kind)
  assert.equal(kinds[kinds.length - 1], 'create', '释放后重建必须是 fresh create')
  assert.equal(second.cwd, 'E:/work', '新会话复用归档时保留的目录')
  assert.equal(sessions.activeSessionId(chatId, 'bot-a'), second.sessionId)
  assert.equal(env.stores.get('bot-a').getChat('bot-a:7').sessionDetached, false, '重新挂上会话清除分离标记')
})

/* ----------------------------------------------------------------- 3. 菜单回调链路 */

const HOUR = 3600 * 1000

function fakeMenuCtx(overrides = {}) {
  const list = overrides.list ?? [
    { id: 'telegram:bot-a:5', cwd: 'E:/work', displayTitle: '我的会话', updatedAt: Date.now() - HOUR },
  ]
  return {
    chatId: 5,
    botId: 'bot-a',
    listSessions: async () => list,
    currentCwd: () => 'E:/work',
    sessions: { activeSessionId: () => overrides.active },
    switchSession: async () => {},
    renameSession: async () => '新标题',
    archiveSession: async () => {},
    beginRename: () => {},
    cancelRename: () => {},
    ...overrides,
  }
}

test('菜单: menu:sessions-manage 列出当前目录会话(命中数 + 序号按钮)', async () => {
  const ctx = fakeMenuCtx()
  const res = await handleMenuCallback('menu:sessions-manage', ctx)
  assert.ok(res.text.includes('**管理会话**'))
  assert.ok(res.text.includes('命中 1 条'))
  assert.ok(res.text.includes('我的会话'))
  const buttons = res.keyboard.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('sm:'))
  assert.deepEqual(buttons.map(b => b.callback_data), ['sm:telegram:bot-a:5'])
})

test('菜单: sm:<id> 显示详情卡, 含 ✏️重命名 与 🗄 归档入口', async () => {
  const ctx = fakeMenuCtx({ active: 'telegram:bot-a:5' })
  const res = await handleMenuCallback('sm:telegram:bot-a:5', ctx)
  assert.ok(res.text.includes('**会话管理**'))
  assert.ok(res.text.includes('我的会话'))
  assert.ok(res.text.includes('✅ 这是本 chat 当前会话'), '当前会话应提示归档会释放绑定')
  const flat = res.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text === '✏️ 重命名' && b.callback_data === 'smr:telegram:bot-a:5'))
  assert.ok(flat.some(b => b.text === '🗄 归档' && b.callback_data === 'sma:telegram:bot-a:5'))
})

test('菜单: smr:<id> 进入重命名模式(beginRename), 提示下一条消息即标题', async () => {
  let began = 0
  const ctx = fakeMenuCtx({ beginRename: () => { began++ } })
  const res = await handleMenuCallback('smr:telegram:bot-a:5', ctx)
  assert.equal(began, 1, '登记目标会话, 等下一条文本作为新标题')
  assert.ok(res.text.includes('**重命名会话**'))
  assert.ok(res.text.includes('请直接发送新的会话标题'))
  assert.ok(res.keyboard.inline_keyboard.flat().some(b => b.text === '❌ 取消重命名' && b.callback_data === 'smrc'))
})

test('菜单: smrc 取消重命名(cancelRename)', async () => {
  let cancelled = 0
  const ctx = fakeMenuCtx({ cancelRename: () => { cancelled++ } })
  const res = await handleMenuCallback('smrc', ctx)
  assert.equal(cancelled, 1)
  assert.ok(res.text.includes('已取消重命名'))
})

test('菜单: sma:<id> 归档二次确认(未执行 archiveSession)', async () => {
  const ctx = fakeMenuCtx({ active: 'telegram:bot-a:5' })
  let archived = false
  const ctx2 = { ...ctx, archiveSession: async () => { archived = true } }
  const res = await handleMenuCallback('sma:telegram:bot-a:5', ctx2)
  assert.equal(archived, false, '确认页不归档')
  assert.ok(res.text.includes('**确认归档会话**'))
  assert.ok(res.text.includes('归档后该会话将从所有列表隐藏'))
  const flat = res.keyboard.inline_keyboard.flat()
  assert.ok(flat.some(b => b.text === '🗄 确认归档' && b.callback_data === 'sma!:telegram:bot-a:5'))
})

test('菜单: sma!:<id> 执行归档, 当前会话附释放提示', async () => {
  const ctx = fakeMenuCtx({ active: 'telegram:bot-a:5' })
  let archived
  const ctx2 = { ...ctx, archiveSession: async (id) => { archived = id } }
  const res = await handleMenuCallback('sma!:telegram:bot-a:5', ctx2)
  assert.equal(archived, 'telegram:bot-a:5', '调宿主归档集')
  assert.ok(res.text.includes('✅ 已归档'))
  assert.ok(res.text.includes('当前会话已释放'), '归档当前会话后给出无会话指引')
})

test('菜单: sma!:<id> 归档失败(宿主抛错)给出错误页, 不崩', async () => {
  const ctx = fakeMenuCtx()
  const ctx2 = { ...ctx, archiveSession: async () => { throw new Error('registry down') } }
  const res = await handleMenuCallback('sma!:telegram:bot-a:5', ctx2)
  assert.ok(res.text.includes('❌ 归档失败'), `应显示失败, 实际:\n${res.text}`)
  assert.ok(res.text.includes('registry down'))
})

test('菜单: 管理列表无候选时提示并可返回', async () => {
  const ctx = fakeMenuCtx({ list: [] })
  const res = await handleMenuCallback('menu:sessions-manage', ctx)
  assert.ok(res.text.includes('暂无可管理的会话'))
})