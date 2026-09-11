/**
 * 工作目录菜单测试（编译后的 lib）：与模型/会话菜单同款 ——
 * 按盘符分组（组名加粗）+ 全局唯一序号 + 当前目录 ✅ + 序号按钮。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMenuCallback } from '../lib/telegram/menu.js'

const ROOTS = [
  'D:\\repos',
  'D:\\projects\\dev\\api-bridge-gui',
  'E:\\projects\\DeepSeek Harness\\dsh-telegram',
  'C:\\Users\\Administrator\\.dsh',
]

function fakeCtx({ current = 'D:\\repos', roots = ROOTS } = {}) {
  return {
    chatId: 1,
    botId: 'bot-a',
    currentCwd: () => current,
    workspaceRoots: [],
    listWorkspaces: async () => roots,
  }
}

test('工作目录菜单: 按盘符分组, 组名加粗, 序号全局唯一', async () => {
  const res = await handleMenuCallback('menu:workspace', fakeCtx())
  const t = res.text
  assert.ok(t.includes('**选择工作目录**'), '标题加粗')
  assert.ok(t.includes('**D:\\**'), 'D 盘分组')
  assert.ok(t.includes('**E:\\**'), 'E 盘分组')
  assert.ok(t.includes('**C:\\**'), 'C 盘分组')
  const idxs = [...t.matchAll(/^　(\d+)\./gm)].map(m => Number(m[1]))
  assert.deepEqual(idxs, [1, 2, 3, 4], '序号全局唯一且连续')
})

test('工作目录菜单: 当前目录在文字与按钮上都带 ✅, 相对路径已去掉前导分隔符', async () => {
  const res = await handleMenuCallback('menu:workspace', fakeCtx())
  assert.ok(res.text.includes('　1. ✅ `repos`'), `当前目录带 ✅ 且相对路径无前导斜杠, 实际:\n${res.text}`)
  const buttons = res.keyboard.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('workspace:'))
  assert.deepEqual(buttons.map(b => b.text), ['✅ 1', '2', '3', '4'])
  assert.deepEqual(buttons.map(b => b.callback_data), ROOTS.map(r => `workspace:${r}`))
})

test('工作目录菜单: 当前目录比较忽略分隔符与大小写', async () => {
  const res = await handleMenuCallback('menu:workspace', fakeCtx({ current: 'd:/repos' }))
  const buttons = res.keyboard.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('workspace:'))
  assert.equal(buttons[0].text, '✅ 1', 'd:/repos 应匹配 D:\\repos')
})

test('工作目录菜单: 每行最多 5 个按钮', async () => {
  const many = Array.from({ length: 7 }, (_, i) => `D:\\ws${i}`)
  const res = await handleMenuCallback('menu:workspace', fakeCtx({ roots: many }))
  const rows = res.keyboard.inline_keyboard.filter(r => r.some(b => (b.callback_data ?? '').startsWith('workspace:')))
  assert.equal(rows[0].length, 5)
  assert.equal(rows[1].length, 2)
})

test('工作目录菜单: 无候选时回退为当前目录', async () => {
  const res = await handleMenuCallback('menu:workspace', fakeCtx({ roots: [] }))
  const buttons = res.keyboard.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('workspace:'))
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].text, '✅ 1')
})
