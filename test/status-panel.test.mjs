/**
 * 状态面板测试（编译后的 lib）：会话一栏必须显示**标题 + 时间**（与「💬 会话」
 * 菜单同一份数据），而不是裸 session id；名单里查不到时才回退到 id。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mainMenuText } from '../lib/telegram/menu.js'

const HOUR = 3600 * 1000
const SID = 'telegram:bot-a:6434599758:g7'

function baseCtx(sessions, { roster = [{ id: SID, displayTitle: '检查工具是否齐全', updatedAt: Date.now() - HOUR }] } = {}) {
  return {
    chatId: 1,
    botId: 'bot-a',
    provider: 'api-bridge',
    model: 'csdn-deepseek-v4-flash',
    currentCwd: () => 'D:\\repos',
    getCurrentModel: () => ({ provider: 'api-bridge', model: 'csdn-deepseek-v4-flash' }),
    getCurrentPresetName: async () => '标准',
    listSessions: async () => roster,
    sessions,
  }
}

test('状态: 有活会话时显示标题 + 时间', async () => {
  const ctx = baseCtx({ get: () => ({ sessionId: SID }), getBound: () => undefined, activeSessionId: () => SID })
  const text = await mainMenuText(ctx)
  assert.ok(text.includes('检查工具是否齐全'), '应显示标题')
  assert.ok(/检查工具是否齐全 · \d{2}-\d{2} \d{2}:\d{2}/.test(text), `应带时间, 实际:\n${text}`)
  assert.ok(!text.includes(SID), '不应再显示裸 session id')
})

test('状态: 无活会话但记录上次会话时, 同样显示标题 + 时间并保留提示', async () => {
  const ctx = baseCtx({ get: () => undefined, getBound: () => undefined, activeSessionId: () => SID })
  const text = await mainMenuText(ctx)
  assert.ok(text.includes('检查工具是否齐全'), '应显示标题')
  assert.ok(text.includes('上次会话'), '保留恢复提示')
  assert.ok(!text.includes(SID))
})

test('状态: 绑定会话一栏同样显示标题 + 时间', async () => {
  const ctx = baseCtx({ get: () => undefined, getBound: () => ({ sessionId: SID, botId: 'bot-a' }), activeSessionId: () => SID })
  const text = await mainMenuText(ctx)
  assert.ok(text.includes('🔗 绑定会话: 检查工具是否齐全'), `绑定会话应带标题, 实际:\n${text}`)
  assert.ok(!text.includes(SID))
})

test('状态: 名单里查不到该会话时回退显示 id(不崩)', async () => {
  const ctx = baseCtx(
    { get: () => ({ sessionId: 'telegram:bot-a:1:g99' }), getBound: () => undefined, activeSessionId: () => undefined },
    { roster: [] },
  )
  const text = await mainMenuText(ctx)
  assert.ok(text.includes('telegram:bot-a:1:g99'), '查不到时回退到 id')
})

test('状态: 无任何会话时提示尚未创建', async () => {
  const ctx = baseCtx({ get: () => undefined, getBound: () => undefined, activeSessionId: () => undefined }, { roster: [] })
  const text = await mainMenuText(ctx)
  assert.ok(text.includes('尚未创建会话'))
})
