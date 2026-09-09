/**
 * Pure-function tests for the interruption-capture logic.
 *
 * These import the *compiled* `lib` outputs (which are dependency-free for the
 * pure functions under test) and run with Node's built-in test runner:
 *   npm test
 *
 * Scope: `normalizeSessionEvent` must surface each turn/end interruption cause
 * (completed / aborted / error / blocked / max-tokens / interrupted) instead of
 * flattening everything to `done`, and `renderStatus` must produce a distinct,
 * human-readable line per cause.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSessionEvent } from '../lib/core/event-normalizer.js'
import { renderStatus } from '../lib/core/renderer.js'

/** Minimal session event helper. */
function event(type, data) {
  return { type, data }
}

test('turn/start emits status running', () => {
  assert.deepEqual(normalizeSessionEvent(event('turn/start', { turn: 1 })),
    { kind: 'status', status: 'running' })
})

test('turn/end completed is a clean done', () => {
  const m = normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.deepEqual(m, { kind: 'status', status: 'done' })
})

test('turn/end aborted (user /stop) → cancelled', () => {
  const m = normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
  assert.deepEqual(m, { kind: 'status', status: 'cancelled', detail: '用户 /stop 取消' })
})

test('turn/end aborted (parent / hook / disposed) → cancelled with cause', () => {
  assert.equal(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } })).detail, '父级取消')
  assert.equal(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'x' } } })).detail, '钩子取消')
  assert.equal(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })).detail, 'agent 已释放')
})

test('turn/end error → error with message + code', () => {
  const m = normalizeSessionEvent(event('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { message: 'upstream 500', code: 'E_RATE_LIMIT' } },
  }))
  assert.equal(m.kind, 'status')
  assert.equal(m.status, 'error')
  assert.equal(m.detail, 'upstream 500 (E_RATE_LIMIT)')
})

test('turn/end error with message only', () => {
  const m = normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }))
  assert.equal(m.detail, 'boom')
})

test('turn/end blocked → blocked', () => {
  assert.deepEqual(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'blocked' } })),
    { kind: 'status', status: 'blocked' })
})

test('turn/end max-tokens → max-tokens', () => {
  assert.deepEqual(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })),
    { kind: 'status', status: 'max-tokens' })
})

test('turn/end interrupted → interrupted', () => {
  assert.deepEqual(normalizeSessionEvent(event('turn/end', { turn: 1, reason: { kind: 'interrupted' } })),
    { kind: 'status', status: 'interrupted' })
})

test('assistant/message interrupted flag is preserved', () => {
  const m = normalizeSessionEvent(event('assistant/message', {
    turn: 1,
    step: 1,
    interrupted: true,
    message: { content: [{ type: 'text', text: 'partial answer' }] },
  }))
  assert.equal(m.kind, 'assistant-final')
  assert.equal(m.interrupted, true)
  assert.equal(m.text, 'partial answer')
})

test('unmapped event type is dropped (noise logging)', () => {
  assert.equal(normalizeSessionEvent(event('step/start', { turn: 1, step: 1 })), undefined)
  assert.equal(normalizeSessionEvent(event('tool/call', {})), undefined)
})

test('renderStatus differentiates every terminal cause', () => {
  assert.equal(renderStatus('done'), '✅ 完成')
  assert.equal(renderStatus('running'), '⏳ agent 开始运行…')
  assert.equal(renderStatus('cancelled', '用户 /stop 取消'), '⛔ 已取消: 用户 /stop 取消')
  assert.equal(renderStatus('error', 'boom'), '❌ 错误: boom')
  assert.equal(renderStatus('blocked'), '🔒 已阻塞(未产生输出)')
  assert.equal(renderStatus('max-tokens'), '⏳ 输出已达 token 上限')
  assert.equal(renderStatus('interrupted'), '⚠️ 会话中断(未正常结束)')
})
