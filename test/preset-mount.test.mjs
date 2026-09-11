/**
 * Agent preset 挂载测试（编译后的 lib）。
 *
 * 关键契约：preset 不只是会话头上的一个标签 —— 它必须由调用方在 `setup` 里通过
 * `agentPresets.mount(agentCtx, id)` 挂载，否则该会话的工具世界为空（没有 shell、
 * 没有文件工具）。create（fresh）与「我们自建的 telegram 会话」的 resume 都必须挂。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshAgentFactory } from '../lib/harness/agent-factory.js'

const fakeAgentCtx = { on: () => () => {} }

function handleFor(id) {
  return {
    agent: { session: { id }, status: 'idle', followup() {}, cancel() {} },
    async dispose() {},
  }
}

/** ctx stub: records requested preset mounts and runs the host's setup callback. */
function makeCtx() {
  const mounted = []
  const ctx = {
    mounted,
    agents: {
      async create(options) {
        if (options.setup !== undefined) await options.setup(fakeAgentCtx)
        return handleFor(String(options.sessionId))
      },
      async resume(options) {
        if (options.setup !== undefined) await options.setup(fakeAgentCtx)
        return handleFor(String(options.resumeSessionId))
      },
    },
    get(name) {
      if (name !== 'agentPresets') return undefined
      return {
        async mount(agentCtx, id) {
          mounted.push({ agentCtx, id })
          return { id }
        },
      }
    },
  }
  return ctx
}

test('factory.create 在 setup 中挂载 agent preset(工具世界的来源)', async () => {
  const ctx = makeCtx()
  const factory = new DshAgentFactory(ctx)
  await factory.create({
    sessionId: 'telegram:bot-a:1', cwd: 'D:/repos', provider: 'p', model: 'm',
    routeKey: 'bot-a:1', agentPreset: 'standard',
  })
  assert.equal(ctx.mounted.length, 1, 'create 必须挂载一次 preset')
  assert.equal(ctx.mounted[0].id, 'standard')
  assert.equal(ctx.mounted[0].agentCtx, fakeAgentCtx, '挂载发生在该 agent 的 scope 上')
})

test('factory.create 无显式 preset 时仍调用 mount(交给宿主默认)', async () => {
  const ctx = makeCtx()
  const factory = new DshAgentFactory(ctx)
  await factory.create({
    sessionId: 'telegram:bot-a:2', cwd: 'D:/repos', provider: 'p', model: 'm', routeKey: 'bot-a:2',
  })
  assert.equal(ctx.mounted.length, 1, '即使没传 id 也要 mount(宿主取默认)')
  assert.equal(ctx.mounted[0].id, undefined)
})

test('factory.resume: 自建会话带 preset 时挂载, 外来会话不挂载', async () => {
  const withPreset = makeCtx()
  const f1 = new DshAgentFactory(withPreset)
  await f1.resume({
    sessionId: 'telegram:bot-a:1:g1', cwd: 'D:/repos', provider: 'p', model: 'm',
    routeKey: 'bot-a:1', agentPreset: 'standard',
  })
  assert.equal(withPreset.mounted.length, 1, '自建会话 resume 必须重新挂 preset')

  const foreign = makeCtx()
  const f2 = new DshAgentFactory(foreign)
  await f2.resume({
    sessionId: 'session-bbafb673-e6d8-4460-a5ab-d7ac207e100a', cwd: 'D:/repos',
    provider: 'p', model: 'm', routeKey: 'bot-b:1',
  })
  assert.equal(foreign.mounted.length, 0, 'GUI 会话保持其创建者的组合, 我们不挂')
})

test('宿主无 agentPresets 服务时安静跳过(不阻断建会话)', async () => {
  const ctx = makeCtx()
  ctx.get = () => undefined
  const factory = new DshAgentFactory(ctx)
  const handle = await factory.create({
    sessionId: 'telegram:bot-a:3', cwd: 'D:/repos', provider: 'p', model: 'm', routeKey: 'bot-a:3',
  })
  assert.equal(String(handle.agent.session.id), 'telegram:bot-a:3')
})