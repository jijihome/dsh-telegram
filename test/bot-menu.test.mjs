/**
 * Bot UI registration tests (compiled `lib`): the Telegram command-menu
 * registration (`setMyCommands` + `setChatMenuButton`), its non-fatal wiring
 * in BotManager, the /menu and /start command results (keyboard attached),
 * and the payload shapes the two new API methods build.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_COMMANDS, DEFAULT_MENU_BUTTON, registerBotCommands, registerMenuButton, registerBotUi } from '../lib/telegram/bot-commands.js'
import { TelegramClient } from '../lib/telegram/api.js'
import { handleCommand } from '../lib/commands/index.js'

/** Fake client that records setMyCommands/setChatMenuButton payloads. */
function fakeClient() {
  const calls = []
  return {
    calls,
    async setMyCommands(commands, scope) { calls.push({ method: 'setMyCommands', commands, scope }); return true },
    async setChatMenuButton(button) { calls.push({ method: 'setChatMenuButton', button }); return true },
  }
}

test('registerBotCommands sends the command list with the default scope', async () => {
  const client = fakeClient()
  await registerBotCommands(client)
  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.equal(call.method, 'setMyCommands')
  assert.deepEqual(call.scope, { type: 'default' })
  assert.equal(call.commands.length, BOT_COMMANDS.length)
  for (const c of call.commands) {
    assert.equal(typeof c.command, 'string')
    assert.ok(c.command.length > 0)
    assert.equal(typeof c.description, 'string')
  }
})

test('registerMenuButton sends the default commands menu button', async () => {
  const client = fakeClient()
  await registerMenuButton(client)
  assert.deepEqual(client.calls[0], { method: 'setChatMenuButton', button: { type: 'commands' } })
  assert.equal(DEFAULT_MENU_BUTTON.type, 'commands')
})

test('registerBotUi performs both registrations against a fake client', async () => {
  const client = fakeClient()
  await registerBotUi(client)
  assert.deepEqual(client.calls.map(c => c.method), ['setMyCommands', 'setChatMenuButton'])
})

test('registerBotUi propagates rejection (caller decides fatality)', async () => {
  const client = {
    async setMyCommands() { throw new Error('api down') },
    async setChatMenuButton() { throw new Error('should not be reached') },
  }
  await assert.rejects(() => registerBotUi(client), /api down/)
})

test('/start result carries the main-menu keyboard', async () => {
  const ctx = fakeCommandCtx()
  const result = await handleCommand('/start', ctx)
  assert.equal(result.handled, true)
  assert.ok(result.reply.includes('dsh-telegram 已就绪'))
  assert.deepEqual(result.keyboard, {
    inline_keyboard: [
      // 「清除会话」已与「新建会话」合并(同一动作), 不再单独成键。
      [{ text: '🆕 新建会话', callback_data: 'menu:new' }],
      [{ text: '📂 工作目录', callback_data: 'menu:workspace' }, { text: '💬 会话', callback_data: 'menu:sessions' }],
      [{ text: '🤖 切换模型', callback_data: 'menu:model' }, { text: '🧭 工作方式', callback_data: 'menu:preset' }],
      [{ text: '⚙️ 运维', callback_data: 'menu:ops' }],
    ],
  })
})

test('/menu result carries the main-menu text and keyboard', async () => {
  const ctx = fakeCommandCtx()
  const result = await handleCommand('/menu', ctx)
  assert.equal(result.handled, true)
  assert.ok(result.reply.includes('选择功能'))
  assert.ok(result.keyboard !== undefined)
  assert.ok(result.keyboard.inline_keyboard.length > 0)
})

test('/menu@botname variant is handled by handleCommand too', async () => {
  const ctx = fakeCommandCtx()
  const result = await handleCommand('/menu@other_bot', ctx)
  assert.equal(result.handled, true)
  assert.ok(result.keyboard !== undefined)
})

test('unknown command still reports the command list including /menu', async () => {
  const ctx = fakeCommandCtx()
  const result = await handleCommand('/nope', ctx)
  assert.equal(result.handled, true)
  assert.ok(result.reply.includes('/menu'))
})

test('TelegramClient.setMyCommands/setChatMenuButton build correct payloads', async () => {
  const requests = []
  const fakeFetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(init.body) })
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    }
  }
  const client = new TelegramClient('123:secret', { fetch: fakeFetch })
  const commands = [{ command: 'start', description: '开始' }]
  const scope = { type: 'default' }
  assert.equal(await client.setMyCommands(commands, scope), true)
  assert.equal(await client.setChatMenuButton({ type: 'commands' }), true)

  assert.equal(requests.length, 2)
  assert.match(requests[0].url, /\/bot123:secret\/setMyCommands$/)
  assert.deepEqual(requests[0].body, { commands, scope })
  assert.match(requests[1].url, /\/bot123:secret\/setChatMenuButton$/)
  assert.deepEqual(requests[1].body, { menu_button: { type: 'commands' } })
})

/** Minimal CommandContext stub for handleCommand tests. */
function fakeCommandCtx() {
  return {
    chatId: 10,
    botId: 'bot-a',
    userId: 6434599758,
    delivery: { async sendFinal() {}, discardLive() {} },
    sessions: {
      get: () => undefined,
      getBound: () => undefined,
      activeSessionId: () => undefined,
      rotate: async () => ({ sessionId: 's1' }),
      cancel: () => false,
      setCwd: () => {},
    },
    store: { getChat: () => undefined },
    workspaceRoots: [],
    defaultCwd: '.',
  }
}
