/**
 * typing 保活测试（编译后的 lib）。
 *
 * Telegram 的 chat action 只显示约 5 秒，长回合里发一次会中途消失。要求：
 * 处理期间持续续发 typing，答复送达/回合结束后才停。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Delivery } from '../lib/telegram/delivery.js'

/** Telegram client stub recording every chat action. */
function fakeClient() {
  const actions = []
  return {
    actions,
    async sendChatAction(chatId, action) { actions.push({ chatId, action }); return true },
  }
}

test('startTyping: 立即发一次, 之后按间隔续发; stopTyping 后不再发', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const client = fakeClient()
  const delivery = new Delivery({ client })

  delivery.startTyping(7)
  assert.equal(client.actions.length, 1, '立即显示 typing')
  assert.deepEqual(client.actions[0], { chatId: 7, action: 'typing' })

  t.mock.timers.tick(4000)
  assert.equal(client.actions.length, 2, '4 秒后续发一次')
  t.mock.timers.tick(8000)
  assert.equal(client.actions.length, 4, '持续续发')

  delivery.stopTyping(7)
  t.mock.timers.tick(60000)
  assert.equal(client.actions.length, 4, 'stopTyping 后不再续发')
  t.mock.timers.reset()
})

test('startTyping 幂等: 重复调用不叠加定时器', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const client = fakeClient()
  const delivery = new Delivery({ client })

  delivery.startTyping(7)
  delivery.startTyping(7)
  delivery.startTyping(7)
  assert.equal(client.actions.length, 1, '只立即发一次')

  t.mock.timers.tick(4000)
  assert.equal(client.actions.length, 2, '重复 start 不应加倍续发')
  delivery.stopTyping(7)
  t.mock.timers.reset()
})

test('每个 chat 独立保活; stopAllTyping 全部清掉', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const client = fakeClient()
  const delivery = new Delivery({ client })

  delivery.startTyping(1)
  delivery.startTyping(2)
  assert.equal(client.actions.length, 2)
  t.mock.timers.tick(4000)
  assert.equal(client.actions.length, 4, '两个 chat 各续发一次')

  delivery.stopTyping(1)
  t.mock.timers.tick(4000)
  assert.equal(client.actions.length, 5, '只停了 chat 1')

  delivery.stopAllTyping()
  t.mock.timers.tick(60000)
  assert.equal(client.actions.length, 5, 'stopAllTyping 后全部停止')
  t.mock.timers.reset()
})

test('stopTyping 未开始的 chat 是安全 no-op', () => {
  const delivery = new Delivery({ client: fakeClient() })
  assert.doesNotThrow(() => delivery.stopTyping(99))
  assert.doesNotThrow(() => delivery.stopAllTyping())
})
