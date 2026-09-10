/**
 * 交互层纯逻辑测试（编译后的 lib）。
 *
 * 覆盖：问题渲染、单选/多选解析、多题累积、审批卡片与词表、PendingStore 的
 * 占槽/完成/超时，以及 agentSessionId 抽取。wire 层（cordis 瀑布 + bot-manager
 * respond 钩子）由实机验证覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  renderQuestions,
  questionMetaOf,
  answerFromCallback,
  answerFromText,
  completeQuestion,
} from '../lib/interactions/telegram-questions.js'
import {
  renderApproval,
  approvalMetaOf,
  answerApprovalFromCallback,
  answerApprovalFromText,
} from '../lib/interactions/telegram-approval.js'
import { PendingStore } from '../lib/interactions/pending-store.js'
import { agentSessionId } from '../lib/interactions/types.js'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function questionPending(token) {
  const store = new PendingStore()
  const pending = store.create('question', 42, 'bot-a', 300_000)
  pending.meta = questionMetaOf(
    [
      { id: 'symptom', question: '你的问题?', options: [{ label: 'A' }, { label: 'B' }] },
    ],
    token,
  )
  return { store, pending }
}

function approvalPending(token) {
  const store = new PendingStore()
  const pending = store.create('approval', 7, 'bot-b', 300_000)
  pending.meta = approvalMetaOf(token, 'pwsh', '需完整权限')
  return { store, pending }
}

test('renderQuestions: 编号文本 + 单选内联键盘', () => {
  const { text, keyboard } = renderQuestions(
    [{ id: 'q', question: '选哪个?', options: [{ label: '甲' }, { label: '乙' }] }],
    'tok',
  )
  assert.ok(text.includes('1. 选哪个?'))
  assert.ok(text.includes('1. 甲'))
  assert.ok(text.includes('2. 乙'))
  assert.ok(keyboard !== undefined)
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'q:tok:0:0')
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, 'q:tok:0:1')
})

test('answerFromCallback: 单选直接答完', () => {
  const { pending } = questionPending('tok')
  assert.equal(answerFromCallback(pending, 'q:tok:0:1'), true)
  const value = completeQuestion(pending)
  assert.deepEqual(value, { answers: [{ id: 'symptom', selected: ['B'] }] })
})

test('answerFromCallback: token 不匹配不消费', () => {
  const { pending } = questionPending('tok')
  assert.equal(answerFromCallback(pending, 'q:other:0:1'), false)
  assert.equal(completeQuestion(pending), undefined)
})

test('answerFromText: 单选数字回复', () => {
  const { pending } = questionPending('tok')
  const r = answerFromText(pending, ' 2 ')
  assert.equal(r.consumed, true)
  assert.deepEqual(r.value, { answers: [{ id: 'symptom', selected: ['B'] }] })
})

test('answerFromText: 无效回复不消费', () => {
  const { pending } = questionPending('tok')
  assert.equal(answerFromText(pending, '随便聊聊').consumed, false)
  assert.equal(answerFromText(pending, '9').consumed, false)
})

test('多题累积: 逐题回调,全部答完才出结果', () => {
  const store = new PendingStore()
  const pending = store.create('question', 5, 'b', 300_000)
  pending.meta = questionMetaOf(
    [
      { id: 'a', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
      { id: 'b', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
    ],
    'tok',
  )
  answerFromCallback(pending, 'q:tok:0:1')
  assert.equal(completeQuestion(pending), undefined, '第一题未答完')
  answerFromCallback(pending, 'q:tok:1:0')
  assert.deepEqual(completeQuestion(pending), {
    answers: [
      { id: 'a', selected: ['a2'] },
      { id: 'b', selected: ['b1'] },
    ],
  })
})

test('多选: 逗号分隔数字', () => {
  const store = new PendingStore()
  const pending = store.create('question', 5, 'b', 300_000)
  pending.meta = questionMetaOf(
    [{ id: 'm', question: '选?', options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }], multiSelect: true }],
    'tok',
  )
  const r = answerFromText(pending, '1,3')
  assert.equal(r.consumed, true)
  assert.deepEqual(r.value, { answers: [{ id: 'm', selected: ['x', 'z'] }] })
})

test('renderApproval + 回调: 允许/拒绝', () => {
  const { text, keyboard } = renderApproval('pwsh', '需完整权限', 'tok', { approve: ['批准'], reject: ['拒绝'] })
  assert.ok(text.includes('pwsh'))
  assert.ok(text.includes('需完整权限'))
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'a:tok:allow')
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, 'a:tok:reject')

  const ok = approvalPending('tok')
  assert.deepEqual(answerApprovalFromCallback(ok.pending, 'a:tok:allow'), { consumed: true, outcome: 'allowed-once' })
  const no = approvalPending('tok')
  assert.deepEqual(answerApprovalFromCallback(no.pending, 'a:tok:reject'), { consumed: true, outcome: 'rejected' })
  const bad = approvalPending('tok')
  assert.equal(answerApprovalFromCallback(bad.pending, 'a:other:allow').consumed, false)
})

test('审批文本词表', () => {
  const words = { approve: ['批准', '同意', 'yes'], reject: ['拒绝', '不同意', 'no'] }
  const a = approvalPending('tok')
  assert.deepEqual(answerApprovalFromText(a.pending, '批准', words), { consumed: true, outcome: 'allowed-once' })
  const a2 = approvalPending('tok')
  assert.deepEqual(answerApprovalFromText(a2.pending, 'no', words), { consumed: true, outcome: 'rejected' })
  const a3 = approvalPending('tok')
  assert.equal(answerApprovalFromText(a3.pending, '随便', words).consumed, false)
})

test('PendingStore: 占槽/完成/释放', () => {
  const store = new PendingStore()
  const p = store.create('question', 1, 'b', 300_000)
  assert.ok(p !== undefined)
  assert.equal(store.active('question', 1, 'b'), p)
  assert.equal(store.create('question', 1, 'b', 300_000), undefined, '同 kind 重复占槽返回 undefined')
  // 不同 kind 可以并存
  const ap = store.create('approval', 1, 'b', 300_000)
  assert.ok(ap !== undefined)
  store.finish(p, { answers: [] })
  assert.equal(store.active('question', 1, 'b'), undefined, 'finish 后释放槽位')
  assert.equal(store.active('approval', 1, 'b'), ap, '审批槽仍在')
})

test('PendingStore: 超时自动释放并 resolve(undefined)', async () => {
  const store = new PendingStore()
  const p = store.create('question', 9, 'b', 20)
  assert.ok(p !== undefined)
  let got = 'unset'
  p.resolve = v => { got = v }
  await sleep(60)
  assert.equal(got, undefined, '超时 resolve undefined')
  assert.equal(store.active('question', 9, 'b'), undefined, '超时后槽位释放')
})

test('agentSessionId 抽取正确/容错', () => {
  assert.equal(agentSessionId({ session: { id: 'session-abc' } }), 'session-abc')
  assert.equal(agentSessionId({ session: {} }), undefined)
  assert.equal(agentSessionId(undefined), undefined)
  assert.equal(agentSessionId({ session: { id: 123 } }), undefined)
})