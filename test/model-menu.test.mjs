/**
 * 模型菜单渲染测试（编译后的 lib）：`menu:model` 应为
 * 「上方按 provider 分组的文字列表(全局唯一序号) + 下方序号按钮」，且现行模型
 * 在文字与按钮上都带 ✅。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMenuCallback } from '../lib/telegram/menu.js'

function fakeMenuCtx(overrides = {}) {
  const base = {
    provider: 'p1',
    model: 'm1',
    getCurrentModel: () => ({ provider: 'p1', model: 'm1' }),
    listModels: async () => [
      { provider: 'p1', model: 'm1' },
      { provider: 'p1', model: 'm2' },
      { provider: 'p2', model: 'n1' },
    ],
    setModel: async () => {},
  }
  return { ...base, ...overrides }
}

test('模型菜单: 分组文字列表 + 唯一序号,现行模型文字带 ✅', async () => {
  const res = await handleMenuCallback('menu:model', fakeMenuCtx())
  const t = res.text
  // 按 provider 分组
  assert.ok(t.includes('p1:'), '含 p1 分组')
  assert.ok(t.includes('p2:'), '含 p2 分组')
  // 全局唯一序号 + 现行模型文字带 ✅
  assert.ok(t.includes('1. ✅ m1'), '现行模型文字带 ✅ 且序号为1')
  assert.ok(t.includes('2. m2'), 'p1 第二个模型序号2')
  assert.ok(t.includes('3. n1'), 'p2 模型序号3(全局唯一)')
  // 序号必须唯一且连续
  const idxs = [...t.matchAll(/^\s*(\d+)\./gm)].map(m => Number(m[1]))
  assert.deepEqual(idxs, [1, 2, 3], '序号全局唯一且连续')
})

test('模型菜单: 下方按钮为序号,现行模型按钮带 ✅,callback 为 model:provider:model', async () => {
  const res = await handleMenuCallback('menu:model', fakeMenuCtx())
  const kb = res.keyboard
  assert.ok(kb !== undefined)
  // 排除 withBack 追加的返回键,只统计 model 选择按钮
  const buttons = kb.inline_keyboard.flat().filter(b => (b.callback_data ?? '').startsWith('model:'))
  assert.equal(buttons.length, 3)
  assert.deepEqual(buttons.map(b => b.text), ['✅ 1', '2', '3'])
  assert.deepEqual(
    buttons.map(b => b.callback_data),
    ['model:p1:m1', 'model:p1:m2', 'model:p2:n1'],
  )
})

test('模型菜单: 每行最多5个按钮(6个模型 → 2行)', async () => {
  const models = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p1', model: 'm2' },
    { provider: 'p1', model: 'm3' },
    { provider: 'p1', model: 'm4' },
    { provider: 'p1', model: 'm5' },
    { provider: 'p1', model: 'm6' },
  ]
  const res = await handleMenuCallback('menu:model', fakeMenuCtx({ listModels: async () => models }))
  const kb = res.keyboard
  const rows = kb.inline_keyboard.filter(r => r.some(b => /^\d+$/.test(b.text.replace('✅ ', '').replace('✅ ', ''))))
  // 数字按钮行(去掉返回行)
  assert.ok(rows[0].length === 5, `第一行 5 个,实际 ${rows[0].length}`)
  assert.ok(rows[1].length === 1, `第二行 1 个,实际 ${rows[1].length}`)
})

test('模型选择: 仍能通过 model:provider:model 应用(model:p2:n1)', async () => {
  let picked
  const ctx = fakeMenuCtx({ setModel: async (p, m) => { picked = { p, m } } })
  const res = await handleMenuCallback('model:p2:n1', ctx)
  assert.deepEqual(picked, { p: 'p2', m: 'n1' })
  assert.ok(res.text.includes('已切换到模型'))
})