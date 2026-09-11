/**
 * 会话选择菜单渲染测试（编译后的 lib）：与模型菜单同款 ——
 * 上方按时间分组（组名加粗）+ 全局唯一序号 + 现行会话 ✅，下方序号按钮。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMenuCallback } from '../lib/telegram/menu.js'

const HOUR = 3600 * 1000

function fakeCtx({ list, active, cwd = 'D:\\repos' } = {}) {
  return {
    chatId: 1,
    botId: 'bot-a',
    listSessions: async () => list ?? [],
    currentCwd: () => cwd,
    sessions: { activeSessionId: () => active },
  }
}

function sessionList() {
  const now = Date.now()
  return [
    { id: 'session-aaa', cwd: 'D:\\repos', displayTitle: '今天的会话A', updatedAt: now - 1 * HOUR },
    { id: 'session-bbb', cwd: 'D:\\repos', displayTitle: '今天的会话B', updatedAt: now - 2 * HOUR },
    { id: 'session-ccc', cwd: 'D:\\repos', displayTitle: '昨天的会话', updatedAt: now - 30 * HOUR },
    { id: 'session-ddd', cwd: 'D:\\repos', displayTitle: '很久以前的会话', updatedAt: now - 20 * 24 * HOUR },
  ]
}

test('会话菜单: 分组标题加粗 + 全局唯一序号 + 现行会话 ✅', async () => {
  const res = await handleMenuCallback('menu:sessions', fakeCtx({ list: sessionList(), active: 'session-aaa' }))
  const t = res.text
  assert.ok(t.includes('**选择会话**'), '标题加粗')
  assert.ok(t.includes('**今天**'), '今天分组加粗')
  assert.ok(t.includes('**昨天**'), '昨天分组加粗')
  assert.ok(t.includes('**更早**'), '更早分组加粗')
  // 唯一序号 + 现行 ✅
  assert.ok(/　1\. ✅ /.test(t), '第1条为现行会话并带 ✅')
  assert.ok(t.includes('　2. '), '第2条无 ✅')
  const idxs = [...t.matchAll(/^　(\d+)\./gm)].map(m => Number(m[1]))
  assert.deepEqual(idxs, [1, 2, 3, 4], '序号全局唯一且连续')
})

test('会话菜单: 下方按钮为序号, 现行带 ✅, callback 为 session:<id>', async () => {
  const res = await handleMenuCallback('menu:sessions', fakeCtx({ list: sessionList(), active: 'session-aaa' }))
  const buttons = res.keyboard.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('session:'))
  assert.deepEqual(buttons.map(b => b.text), ['✅ 1', '2', '3', '4'])
  assert.deepEqual(
    buttons.map(b => b.callback_data),
    ['session:session-aaa', 'session:session-bbb', 'session:session-ccc', 'session:session-ddd'],
  )
})

test('会话菜单: 过长标题截断加省略号', async () => {
  const now = Date.now()
  const long = '这是一个非常长的会话标题'.repeat(5)
  const res = await handleMenuCallback('menu:sessions', fakeCtx({
    list: [{ id: 'session-x', cwd: 'D:\\repos', displayTitle: long, updatedAt: now - HOUR }],
    active: undefined,
  }))
  assert.ok(res.text.includes('…'), '超长标题应截断')
  assert.ok(!res.text.includes(long), '不应出现未截断的完整标题')
})

test('会话菜单: 当前目录无会话时的引导文案 + 始终有「🆕 新建会话」按钮', async () => {
  const res = await handleMenuCallback('menu:sessions', fakeCtx({ list: [], active: undefined }))
  assert.ok(res.text.includes('下暂无会话'), `应提示目录内无会话, 实际:\n${res.text}`)
  const flat = res.keyboard.inline_keyboard.flat().map(b => b.text)
  assert.ok(flat.includes('🆕 新建会话'), '空目录也必须给新建会话按钮(不能没有出路)')
})

test('会话菜单: 有会话时同样携带「🆕 新建会话」按钮(无会话消息弹出即可选)', async () => {
  const res = await handleMenuCallback('menu:sessions', fakeCtx({ list: sessionList(), active: 'session-aaa' }))
  const flat = res.keyboard.inline_keyboard.flat().map(b => b.text)
  assert.ok(flat.includes('🆕 新建会话'), '选择列表必须能直接新建会话')
})

test('切换会话确认文案显示标题 + 时间, 不再显示裸 id', async () => {
  const now = Date.now()
  const id = 'session-e136e1ff-d52d-4d09-90ac-3b256d539bba'
  let switched
  const ctx = {
    ...fakeCtx({ list: [{ id, cwd: 'D:\\repos', displayTitle: 'Telegram · Github趋势', updatedAt: now - 2 * HOUR }], active: undefined }),
    switchSession: async (sessionId, cwd) => { switched = { sessionId, cwd } },
  }
  const res = await handleMenuCallback(`session:${id}`, ctx)
  assert.ok(res.text.includes('Telegram · Github趋势'), `应显示标题, 实际:\n${res.text}`)
  assert.ok(res.text.includes('· '), '应带时间')
  assert.ok(!res.text.includes(id), '不应再显示裸 id')
  assert.deepEqual(switched, { sessionId: id, cwd: 'D:\\repos' }, '切换参数不变')
})

test('切换会话确认文案: 名单查不到时回退显示 id', async () => {
  const id = 'session-unknown-id'
  const ctx = { ...fakeCtx({ list: [], active: undefined }), switchSession: async () => {} }
  const res = await handleMenuCallback(`session:${id}`, ctx)
  assert.ok(res.text.includes(id), '查不到时回退 id')
})
