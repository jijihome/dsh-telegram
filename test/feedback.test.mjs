/**
 * A+B feedback tests for the StreamListener (compiled `lib`).
 *
 * A (event-based): when the agent reaches a stop boundary / goes idle while a
 * turn is still open, the bot is told the agent is waiting for input — instead
 * of the chat appearing silently stalled.
 *
 * B (time-based watchdog): while a turn is open, producing no output for
 * `stallNoticeMs` raises a "no output, possibly stalled" notice (once per turn).
 *
 * The windows are injected tiny here so the tests run fast.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamListener } from '../lib/harness/stream-listener.js'

/** Minimal Cordis-like context: record listeners by event, return a disposer. */
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

/** SessionManager stub mapping any session id to one bound chat. */
function fakeSessions(chatId, botId) {
  return {
    bySessionId: (id) => ({ chatId, botId, sessionId: id }),
    byBoundSessionId: () => undefined,
    isRelevant: () => true,
  }
}

/** Delivery stub that records every sent line. */
function fakeDelivery() {
  const sent = []
  return {
    sent,
    async sendFinal(_chatId, text) { sent.push(text) },
    async endLive() {},
    async typing() {},
    async appendDelta() {},
    async finalizeLive() { return false },
    resetStream() {},
    discardLive() {},
  }
}

const SESSION = { id: 'telegram:bot-a:10' }
const WAITING = '⏳ agent 已暂停，正在等待你的回复/继续…'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Build a listener with fake delivery + tiny windows, and return its handles. */
function build({ stallNoticeMs = 0, waitQuiescenceMs = 30 } = {}) {
  const ctx = fakeCtx()
  const delivery = fakeDelivery()
  const deliveries = new Map([['bot-a', delivery]])
  const listener = new StreamListener({
    ctx,
    sessions: fakeSessions(10, 'bot-a'),
    deliveries,
    stallNoticeMs,
    waitQuiescenceMs,
    logger: { warn() {}, error() {} },
  })
  listener.start()
  return { ctx, delivery, listener }
}

test('A: turn open + agent idle with no turn/end → "waiting for input" notice', async () => {
  const { ctx, delivery } = build()
  // Open a turn, then let the agent go idle without a turn/end.
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['agent/status']({ agent: { session: SESSION }, status: 'idle' })

  await sleep(90)
  assert.ok(delivery.sent.includes(WAITING), 'expected the waiting notice, got: ' + JSON.stringify(delivery.sent))
})

test('A guard: a normal turn/end then idle must NOT produce a waiting notice', async () => {
  const { ctx, delivery } = build()
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.handlers['agent/status']({ agent: { session: SESSION }, status: 'idle' })

  await sleep(90)
  assert.ok(!delivery.sent.includes(WAITING), 'completed turn must not look like waiting: ' + JSON.stringify(delivery.sent))
})

test('A: activity inside the quiescence window cancels the waiting notice', async () => {
  const { ctx, delivery } = build({ waitQuiescenceMs: 60 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['agent/turn-stopping']({ agent: { session: SESSION }, turn: 1 })
  // The agent speaks again before the window elapses → not waiting.
  await sleep(15)
  ctx.handlers['session/event'](SESSION, { type: 'step/start', data: { turn: 1, step: 1 } })

  await sleep(120)
  assert.ok(!delivery.sent.includes(WAITING), 'activity must cancel the waiting notice: ' + JSON.stringify(delivery.sent))
})

test('B: an open turn silent past stallNoticeMs raises a stall notice', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 40, waitQuiescenceMs: 100000 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })

  await sleep(120)
  const stall = delivery.sent.find((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.ok(stall !== undefined, 'expected a stall notice, got: ' + JSON.stringify(delivery.sent))
})

test('B: closing the turn cancels the stall watchdog', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 40, waitQuiescenceMs: 100000 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  await sleep(120)
  const stall = delivery.sent.find((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.equal(stall, undefined, 'a closed turn must not raise a stall notice')
})

test('B: the stall watchdog fires at most once per turn', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 30, waitQuiescenceMs: 100000 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })

  await sleep(140)
  const stalls = delivery.sent.filter((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.equal(stalls.length, 1, 'exactly one stall notice per turn, got: ' + JSON.stringify(delivery.sent))
})

test('B regression: an open step (long tool call) must NOT be reported as a stall', async () => {
  // Real report: a long read-only tool call produced no visible output for
  // minutes while the agent was perfectly healthy -> the watchdog cried wolf.
  const { ctx, delivery } = build({ stallNoticeMs: 30, waitQuiescenceMs: 100000 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'step/start', data: { turn: 1, step: 1 } })

  await sleep(140)
  const stalls = delivery.sent.filter((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.equal(stalls.length, 0, 'a step in flight means the agent is working, not stalled: ' + JSON.stringify(delivery.sent))
})

test('B: once the step closes and silence continues, the stall IS reported', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 40, waitQuiescenceMs: 100000 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event'](SESSION, { type: 'step/start', data: { turn: 1, step: 1 } })
  await sleep(70)
  ctx.handlers['session/event'](SESSION, { type: 'step/end', data: { turn: 1, step: 1 } })

  await sleep(120)
  const stalls = delivery.sent.filter((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.equal(stalls.length, 1, 'silence with no open step is a real stall: ' + JSON.stringify(delivery.sent))
})

test('A then B: a turn already reported as waiting is not also reported as stalled', async () => {
  const { ctx, delivery } = build({ stallNoticeMs: 40, waitQuiescenceMs: 20 })
  ctx.handlers['session/event'](SESSION, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['agent/status']({ agent: { session: SESSION }, status: 'idle' })

  await sleep(140)
  assert.ok(delivery.sent.includes(WAITING), 'expected the waiting notice first')
  const stalls = delivery.sent.filter((line) => line.startsWith('⚠️') && line.includes('无输出'))
  assert.equal(stalls.length, 0, 'the waiting notice already covered this turn: ' + JSON.stringify(delivery.sent))
})