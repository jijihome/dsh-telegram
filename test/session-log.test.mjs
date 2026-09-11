/**
 * 会话日志读取测试（编译后的 lib）。
 *
 * 关键点：session.v3.jsonl.zstd 是**多帧 zstd 拼接**（首帧 header + 后续事件帧），
 * `zstdDecompressSync` 只解第一帧（拿不到事件）。本测试自造多帧文件，验证逐帧解码
 * 能取到首条 user/message 作为标题，并用文件 mtime 作为最后活动时间。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  encodeSessionId,
  decodeSessionId,
  indexSessionLogs,
  readSessionSummary,
} from '../lib/core/session-log.js'

/** Build a multi-frame session log: header frame + one frame per event. */
function writeSessionLog(dir, header, events) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v3.jsonl.zstd')
  const frames = [header, ...events].map(obj => zstdCompressSync(Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')))
  writeFileSync(path, Buffer.concat(frames))
  return path
}

test('encode/decode 会话 id 与目录拼写互逆', () => {
  const id = 'telegram:bot-a:6434599758:g7'
  const encoded = encodeSessionId(id)
  assert.equal(encoded, 'telegram~003Abot-a~003A6434599758~003Ag7')
  assert.equal(decodeSessionId(encoded), id)
  assert.equal(encodeSessionId('session-222ff68d-5093-4612-abec-a3685d0f2359'), 'session-222ff68d-5093-4612-abec-a3685d0f2359')
})

test('readSessionSummary 跨帧读到首条 user/message 作为标题', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tg-log-'))
  const sessionId = 'telegram:bot-a:6434599758:g7'
  const dir = join(root, '--D-repos--', encodeSessionId(sessionId))
  const header = { type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd: 'D:\\repos' }
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看下这个仓库的结构' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ]
  const logPath = writeSessionLog(dir, header, events)

  const summary = readSessionSummary(logPath)
  assert.equal(summary.title, '帮我看下这个仓库的结构', '标题取首条 user/message')
  assert.equal(typeof summary.updatedAt, 'number', '时间取文件 mtime')
  assert.ok(summary.updatedAt > 0)
})

test('readSessionSummary 超长标题截断加省略号', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tg-log-'))
  const long = '这是一个特别长的用户提问'.repeat(6)
  const logPath = writeSessionLog(join(root, 'ws', 'session-x'), { type: 'session', id: 'session-x' }, [
    { type: 'user/message', data: { content: [{ type: 'text', text: long }] } },
  ])
  const summary = readSessionSummary(logPath)
  assert.ok(summary.title.endsWith('…'), '超长应截断')
  assert.ok(summary.title.length <= 41, `截断后长度 ${summary.title.length}`)
})

test('indexSessionLogs 按原始 id 与目录拼写都能命中', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tg-log-'))
  const sessionId = 'telegram:bot-a:1:g2'
  const logPath = writeSessionLog(join(root, '--D-repos--', encodeSessionId(sessionId)), { type: 'session', id: sessionId }, [])
  utimesSync(logPath, new Date(), new Date())

  const index = indexSessionLogs(root)
  assert.equal(index.get(sessionId)?.path, logPath, '按原始 id 命中')
  assert.equal(index.get(encodeSessionId(sessionId))?.path, logPath, '按目录拼写命中')
})

test('日志不可读时安静返回空(不抛)', () => {
  assert.deepEqual(readSessionSummary('E:/definitely-missing/session.v3.jsonl.zstd'), {})
})
