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

test('会话菜单: 当前目录无会话时的引导文案', async () => {
  const res = await handleMenuCallback('menu:sessions', fakeCtx({ list: [], active: undefined }))
  assert.ok(res.text.includes('当前目录下暂无会话'))
})
