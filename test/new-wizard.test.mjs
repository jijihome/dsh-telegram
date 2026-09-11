/**
 * 新建会话向导测试（编译后的 lib）：第 1 步选模型 → 第 2 步选工作方式 → 创建。
 * 每步可「用当前」跳过或取消；选中的模型/工作方式必须先落盘再 rotate，
 * 新会话才真正带上这两个选择。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMenuCallback } from '../lib/telegram/menu.js'

const MODELS = [
  { provider: 'api-bridge', model: 'csdn-deepseek-v4-flash' },
  { provider: 'api-bridge', model: 'zhipu-glm-5.3' },
  { provider: 'deepseek-official', model: 'deepseek-chat' },
]
const PRESETS = [{ id: 'standard', name: '标准' }, { id: 'claude', name: 'Claude 风格' }]

function fakeCtx({ models = MODELS, presets = PRESETS, currentPreset = 'standard' } = {}) {
  let draft = {}
  const calls = []
  const state = { chatModel: { provider: 'api-bridge', model: 'csdn-deepseek-v4-flash' }, chatPreset: currentPreset }
  const ctx = {
    calls,
    draftState: () => draft,
    chatId: 1,
    botId: 'bot-a',
    provider: 'api-bridge',
    model: 'csdn-deepseek-v4-flash',
    draft: {
      read: () => ({ ...draft }),
      patch: (next) => { draft = { ...draft, ...next } },
      reset: () => { draft = {} },
    },
    getCurrentModel: () => ({ ...state.chatModel }),
    listModels: async () => models,
    listPresets: async () => presets,
    getCurrentPresetId: async () => state.chatPreset,
    getCurrentPresetName: async () => presets.find(p => p.id === state.chatPreset)?.name ?? '默认',
    setModel: async (provider, model) => { calls.push(`setModel:${provider}/${model}`); state.chatModel = { provider, model } },
    setPreset: async (id) => { calls.push(`setPreset:${id}`); state.chatPreset = id },
    currentCwd: () => 'D:\\repos',
    sessions: {
      activeSessionId: () => 'telegram:bot-a:1:g6',
      rotate: async () => { calls.push('rotate'); return { sessionId: 'telegram:bot-a:1:g7', cwd: 'D:\\repos' } },
    },
  }
  return ctx
}

test('向导第 1 步: 模型按 provider 分组、唯一序号、当前模型 ✅, 带跳过/取消', async () => {
  const ctx = fakeCtx()
  const res = await handleMenuCallback('menu:new', ctx)
  assert.ok(res.text.includes('第 1/2 步:选择模型'), res.text)
  assert.ok(res.text.includes('**api-bridge**') && res.text.includes('**deepseek-official**'), '按 provider 分组')
  assert.ok(res.text.includes('1. ✅ `csdn-deepseek-v4-flash`'), '当前模型带 ✅')
  const buttons = res.keyboard.inline_keyboard.flat()
  assert.deepEqual(buttons.filter(b => b.callback_data.startsWith('nw:m:')).map(b => b.callback_data),
    ['nw:m:0', 'nw:m:1', 'nw:m:2'])
  assert.ok(buttons.some(b => b.callback_data === 'nw:skip:m'), '有「用当前模型」')
  assert.ok(buttons.some(b => b.callback_data === 'nw:cancel'), '有「取消」')
})

test('向导第 2 步: 显示已选模型 + 预设 ✅ 当前项', async () => {
  const ctx = fakeCtx()
  await handleMenuCallback('menu:new', ctx)
  const res = await handleMenuCallback('nw:m:1', ctx)
  assert.ok(res.text.includes('第 2/2 步:选择工作方式'), res.text)
  assert.ok(res.text.includes('已选模型 `zhipu-glm-5.3`'), '回显上一步的选择')
  assert.ok(res.text.includes('1. ✅ `标准`'), '当前工作方式带 ✅')
  assert.deepEqual(ctx.draftState(), { provider: 'api-bridge', model: 'zhipu-glm-5.3' })
})

test('向导完成: 先落盘模型与工作方式再 rotate, 确认文案含两者', async () => {
  const ctx = fakeCtx()
  await handleMenuCallback('menu:new', ctx)
  await handleMenuCallback('nw:m:1', ctx)     // 选 zhipu-glm-5.3
  const res = await handleMenuCallback('nw:p:1', ctx)  // 选 Claude 风格
  assert.deepEqual(ctx.calls, ['setModel:api-bridge/zhipu-glm-5.3', 'setPreset:claude', 'rotate'],
    '必须 setModel/setPreset 在 rotate 之前')
  assert.ok(res.text.includes('• 模型: api-bridge/zhipu-glm-5.3'), `确认文案应含生效模型, 实际:\n${res.text}`)
  assert.ok(res.text.includes('• 工作方式: Claude 风格'), '确认文案应含生效工作方式')
  assert.deepEqual(ctx.draftState(), {}, '创建后草稿清空')
})

test('向导跳过两步: 不写入模型/工作方式, 仍创建会话', async () => {
  const ctx = fakeCtx()
  await handleMenuCallback('menu:new', ctx)
  await handleMenuCallback('nw:skip:m', ctx)
  const res = await handleMenuCallback('nw:skip:p', ctx)
  assert.deepEqual(ctx.calls, ['rotate'], '跳过时不应改模型/工作方式')
  assert.ok(res.text.includes('已开启新会话'))
})

test('向导取消: 清空草稿且不创建会话', async () => {
  const ctx = fakeCtx()
  await handleMenuCallback('menu:new', ctx)
  await handleMenuCallback('nw:m:0', ctx)
  const res = await handleMenuCallback('nw:cancel', ctx)
  assert.ok(res.text.includes('已取消'))
  assert.deepEqual(ctx.calls, [], '取消不应有任何写入或创建')
  assert.deepEqual(ctx.draftState(), {}, '取消后草稿清空')
})

test('无预设时: 第 1 步之后直接创建(不再有第 2 步)', async () => {
  const ctx = fakeCtx({ presets: [] })
  await handleMenuCallback('menu:new', ctx)
  const res = await handleMenuCallback('nw:m:2', ctx)
  assert.ok(res.text.includes('已开启新会话'), `应直接创建, 实际:\n${res.text}`)
  assert.deepEqual(ctx.calls, ['setModel:deepseek-official/deepseek-chat', 'rotate'])
})

test('选到已失效的序号: 给出提示而不崩', async () => {
  const ctx = fakeCtx({ models: MODELS.slice(0, 1) })
  await handleMenuCallback('menu:new', ctx)
  const res = await handleMenuCallback('nw:m:9', ctx)
  assert.ok(res.text.includes('已不可用'), res.text)
})
