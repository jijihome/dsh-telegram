/**
 * typing 停止路径测试（编译后的 lib）。
 *
 * 陛下的要求：处理期间一直显示 typing，答复送达/回合结束才停。本测试覆盖
 * **意外中断**的每条路径都必须把保活停掉，否则会一直转圈：
 * - turn/start → startTyping；
 * - assistant/message(定稿) / turn/end(终止原因) → stopTyping；
 * - agent/error（无 turn/end 的兜底失败路径）→ stopTyping；
 * - 「等待输入」与「停滞」通知（agent 已不再产出）→ stopTyping。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamListener } from '../lib/harness/stream-listener.js'

/** Minimal Cordis-like context: record listeners by event. */
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

function fakeSessions(chatId, botId) {
  return {
    bySessionId: (id) => ({ chatId, botId, sessionId: id }),
    byBoundSessionId: () => undefined,
    isRelevant: () => true,
  }
}

/** Delivery stub recording typing start/stop and sent lines. */
function fakeDelivery() {
  const sent = []
  const typingCalls = { starts: 0, stops: 0 }
  return {
    sent,
    typingCalls,
    async sendFinal(_chatId, text) { sent.push(text) },
    async endLive() {},
    startTyping() { typingCalls.starts += 1 },
    stopTyping() { typingCalls.stops += 1 },
    async appendDelta() {},
    async finalizeLive() { return false },
    resetStream() {},
    discardLive() {},
  }
}

const SESSION = { id: 'telegram:bot-a:10' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function build({ stallNoticeMs = 0, waitQuiescenceMs = 100000 } = {}) {
  const ctx = fakeCtx()
  const delivery = fakeDelivery()
  const listener = new StreamListener({
    ctx,
    sessions: fakeSessions(10, 'bot-a'),
    deliveries: new Map([['bot-a', delivery]]),
    stallNoticeMs,
    waitQuiescenceMs,
    logger: { warn() {}, error() {} },
  })
  listener.start()
  return { ctx, delivery, listener }
}

test('turn/start → 开始 typing 保活', () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(delivery.typingCalls.starts, 1, '回合开始应启动 typing 保活')
})

test('assistant 定稿 → 停止 typing(答复已送达)', async () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '答案' }] } },
  })
  // 该分支在 await finalizeLive 之后才停 typing, 属微任务, 稍等再断言。
  await sleep(10)
  assert.ok(delivery.typingCalls.stops >= 1, '答复送达后必须停 typing')
})

test('turn/end(aborted) 用户在 GUI 停止 → 停止 typing', () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.ok(delivery.typingCalls.stops >= 1, '中止也应停 typing')
})

test('turn/end(error) → 停止 typing', () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.ok(delivery.typingCalls.stops >= 1)
})

test('agent/error(无 turn/end 的中断兜底) → 停止 typing 并报错', () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['agent/error']({ agent: { session: SESSION }, turn: 1, error: new Error('network down') })
  return sleep(10).then(() => {
    assert.ok(delivery.typingCalls.stops >= 1, 'agent 级失败必须停 typing, 否则会一直转圈')
    assert.ok(delivery.sent.some(l => l.includes('步骤出错')), '应报告失败')
  })
})

test('「等待输入」通知 → agent 已暂停, 停止 typing', async () => {
  const { ctx, delivery } = build({ waitQuiescenceMs: 30 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['agent/status']({ agent: { session: SESSION }, status: 'idle' })
  await sleep(90)
  assert.ok(delivery.sent.some(l => l.includes('等待你的回复')), '应有等待通知')
  assert.ok(delivery.typingCalls.stops >= 1, '等待输入时不应继续 typing')
})

test('「停滞」通知 → 停止 typing', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 40 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  await sleep(120)
  assert.ok(delivery.sent.some(l => l.includes('无输出')), '应有停滞通知')
  assert.ok(delivery.typingCalls.stops >= 1, '停滞时不应继续 typing')
})
