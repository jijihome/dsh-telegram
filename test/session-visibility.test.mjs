/**
 * 会话可见性测试（编译后的 lib）。
 *
 * 背景：磁盘上的投影缓存（session_projcache）**不写 `origin`**，所以「子代理」无法
 * 靠 origin 判定；缓存里子代理会话是**裸 uuid** 文件名（且没有自己的会话日志），
 * 顶层会话是 `session-<uuid>`，本插件自建的是 `telegram:…`。
 * 会话选择器必须按这个 id 形态过滤，否则会把子代理（记忆管家/生活助手）当成
 * 用户创建的话题列出来 —— 与 Web GUI 的列表不一致。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUserFacingSessionId, isOwnSessionId } from '../lib/core/session-visibility.js'

test('顶层会话( session-<uuid> ) 可见', () => {
  assert.equal(isUserFacingSessionId('session-222ff68d-5093-4612-abec-a3685d0f2359'), true)
  assert.equal(isUserFacingSessionId('session-af9753f7-6b82-4a5e-9dd1-92021e2d4cac'), true)
})

test('本插件自建会话( telegram:… ) 可见', () => {
  assert.equal(isUserFacingSessionId('telegram:bot-a:6434599758'), true)
  assert.equal(isUserFacingSessionId('telegram:bot-a:6434599758:g6'), true)
})

test('子代理会话(裸 uuid) 不可见 —— 本次修复的核心', () => {
  // 真实样本: 这些在 projcache 里 cwd=D:\repos 但其实是记忆管家/生活助手子代理
  for (const id of [
    '0462c8cb-742e-4afa-9c07-7f09e02fa99a',
    '7f79dac6-a04b-4121-abcb-58bdc416c6c9',
    'b73df702-1ea3-4714-ae08-3e54be02093c',
  ]) {
    assert.equal(isUserFacingSessionId(id), false, `${id} 应被隐藏`)
  }
})

test('isOwnSessionId 只认 telegram: 前缀', () => {
  assert.equal(isOwnSessionId('telegram:bot-a:1'), true)
  assert.equal(isOwnSessionId('session-222ff68d-5093-4612-abec-a3685d0f2359'), false)
  assert.equal(isOwnSessionId('0462c8cb-742e-4afa-9c07-7f09e02fa99a'), false)
})

test('D:\\repos 真实数据集: 22 条缓存条目过滤后剩 3 条顶层会话', () => {
  // 取自 2026-09-11 实测: projcache cwd=D:\repos 共 22 条(19 裸 uuid 子代理 + 3 session-*)
  const bare = Array.from({ length: 19 }, (_, i) => `${String(i).padStart(8, '0')}-742e-4afa-9c07-7f09e02fa99a`)
  const top = [
    'session-222ff68d-5093-4612-abec-a3685d0f2359',
    'session-af9753f7-6b82-4a5e-9dd1-92021e2d4cac',
    'session-e136e1ff-d52d-4d09-90ac-3b256d539bba',
  ]
  const kept = [...bare, ...top].filter(isUserFacingSessionId)
  assert.equal(kept.length, 3, '子代理全部被过滤, 只剩 3 条真实话题')
  assert.deepEqual(kept, top)
})
