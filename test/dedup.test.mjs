/**
 * Interruption-dedup test for the StreamListener (compiled `lib`).
 *
 * Verifies the core of方案1's "no silent interruption + no duplicate
 * notification": when both `agent/error` and `turn/end(reason:error)` fire for
 * the same turn, the bot is notified exactly once; and a real interruption
 * (cancel/error/…) that was previously swallowed as "done" now produces a bot
 * message.
 *
 * Uses a fake Cordis `ctx` (records `on` handlers) + a fake Delivery.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamListener } from '../lib/harness/stream-listener.js'

/** Minimal Cordis-like context: record listeners by event, return a disposer. */
function fakeCtx() {
  const handlers = {}
  const ctx = {
    handlers,
    on(event, handler) {
      handlers[event] = handler
      return () => { delete handlers[event] }
    },
  }
  return ctx
}

/** SessionManager stub that maps any session id to a bound chat. */
function fakeSessions(chatId, botId) {
  return {
    bySessionId: (id) => ({ chatId, botId, sessionId: id }),
    byBoundSessionId: () => undefined,
    // The stream listener now gates on the plugin's own sessions; this stub owns
    // the one session under test, so it must report it as relevant.
    isRelevant: () => true,
  }
}

/** Delivery stub that records every sent/edited/typing call. */
function fakeDelivery() {
  const sent = []
  let ended = 0
  return {
    sent,
    ended() { return ended },
    async sendFinal(_chatId, text) { sent.push(text) },
    async endLive() { ended += 1 },
    async typing() {},
    async appendDelta() {},
    // No live segment to finalize -> caller must send the final fresh.
    async finalizeLive() { return false },
    resetStream() {},
    discardLive() {},
  }
}

/** Build a StreamListener wired to fakes and return the recorded handlers. */
function build({ chatId = 10, botId = 'bot-a' } = {}) {
  const ctx = fakeCtx()
  const delivery = fakeDelivery()
  const deliveries = new Map([[botId, delivery]])
  const listener = new StreamListener({
    ctx,
    sessions: fakeSessions(chatId, botId),
    deliveries,
    logger: { warn() {}, error() {} },
  })
  listener.start()
  return { ctx, delivery }
}

const SESSION = { id: 'telegram:bot-a:10' }

/** Let fire-and-forget async delivery calls settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('agent/error + turn/end(error) for the same turn notify once', async () => {
  const { ctx, delivery } = build()
  const agentError = ctx.handlers['agent/error']
  const sessionEvent = ctx.handlers['session/event']

  agentError({ agent: { session: SESSION }, turn: 5, error: { message: 'boom', code: 'E_X' } })
  sessionEvent(SESSION, { type: 'turn/end', data: { turn: 5, reason: { kind: 'error', error: { message: 'boom', code: 'E_X' } } } })
  await flush()

  assert.equal(delivery.sent.length, 1, 'one notification expected, got ' + delivery.sent.length)
  assert.match(delivery.sent[0], /(错误|步骤出错).*boom/)
})

test('turn/end(aborted) alone produces a bot notification (previously swallowed as done)', async () => {
  const { ctx, delivery } = build()
  const sessionEvent = ctx.handlers['session/event']

  sessionEvent(SESSION, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await flush()

  assert.equal(delivery.sent.length, 1)
  assert.equal(delivery.sent[0], '⛔ 已取消: 用户 /stop 取消')
})

test('turn/end(completed) still ends the live stream, no terminal message', () => {
  const { ctx, delivery } = build()
  const sessionEvent = ctx.handlers['session/event']

  sessionEvent(SESSION, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

  assert.equal(delivery.sent.length, 0)
  assert.equal(delivery.ended(), 1, 'endLive should flush the live segment on completion')
})

test('interrupted assistant message is flagged with a prefix', async () => {
  const { ctx, delivery } = build()
  const sessionEvent = ctx.handlers['session/event']

  sessionEvent(SESSION, { type: 'assistant/message', data: { turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } } })
  await flush()

  assert.equal(delivery.sent.length, 1)
  assert.equal(delivery.sent[0], '⛔ [已中断] partial')
})

test('assistant-final does not duplicate when the live message already carried the answer', async () => {
  const ctx = fakeCtx()
  let sends = 0
  const delivery = {
    sendFinal: async () => { sends += 1 },
    endLive: async () => {},
    typing: async () => {},
    appendDelta: async () => {},
    // The answer was streamed into a live message -> finalizeLive reports it
    // so the caller must NOT send a second (duplicate) final message.
    finalizeLive: async () => true,
    resetStream: () => {},
  }
  const deliveries = new Map([['bot-a', delivery]])
  const listener = new StreamListener({
    ctx,
    sessions: fakeSessions(10, 'bot-a'),
    deliveries,
    logger: { warn() {}, error() {} },
  })
  listener.start()
  ctx.handlers['session/event']({ id: 'telegram:bot-a:10' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: 'the answer' }] } },
  })
  await flush()
  assert.equal(sends, 0, 'must not send a duplicate final when the answer was already streamed live')
})
