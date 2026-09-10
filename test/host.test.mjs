/**
 * Host restart-marker tests (compiled `lib`).
 *
 * Covers the "已上线" restart hook of 方案C:
 * - writeRestartMarker + readRestartMarker read-to-send (marker PERSISTS until
 *   the broadcast succeeds; see clearRestartMarker);
 * - a stale marker yields undefined (peek returns nothing for a manual boot);
 * - a missing/corrupt marker returns undefined without throwing;
 * - clearRestartMarker removes the marker only after delivery succeeds, so a
 *   transient send failure can retry instead of dropping the announcement.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeRestartMarker,
  readRestartMarker,
  clearRestartMarker,
  restartMarkerPath,
  readHostInstance,
  writeHostInstance,
  hostInstancePath,
  resolveRestartNotice,
} from '../lib/core/host.js'

/** Temp dir per test. */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-tg-host-'))
}

test('writeRestartMarker + readRestartMarker: fresh marker is read WITHOUT deleting', () => {
  const dir = tmp()
  writeRestartMarker(dir)
  assert.ok(existsSync(restartMarkerPath(dir)), 'marker file exists after write')

  // First peek: read succeeds, file stays (so a failed broadcast can retry).
  const m1 = readRestartMarker(dir)
  assert.ok(m1 !== undefined, 'fresh marker is read')
  assert.equal(typeof m1.at, 'number')
  assert.equal(typeof m1.hostPid, 'number')
  assert.ok(existsSync(restartMarkerPath(dir)), 'marker PERSISTS after peek (retryable)')

  // Second peek is idempotent.
  const m2 = readRestartMarker(dir)
  assert.ok(m2 !== undefined, 'peek is idempotent')

  // After a confirmed send, the caller clears the marker.
  clearRestartMarker(dir)
  assert.ok(!existsSync(restartMarkerPath(dir)), 'marker removed after clearRestartMarker')
})

test('stale marker yields undefined but does NOT delete (peek-only contract)', () => {
  const dir = tmp()
  writeRestartMarker(dir, Date.now() - 2 * 60 * 60 * 1000)
  const marker = readRestartMarker(dir, 60_000)
  assert.equal(marker, undefined, 'stale marker yields undefined')
  // Peek must not delete; only clearRestartMarker deletes. Verifies the retry
  // contract that "已上线" is never lost to an eager delete.
  assert.ok(existsSync(restartMarkerPath(dir)), 'stale marker is NOT removed by peek')
})

test('corrupt marker returns undefined without throwing', () => {
  const dir = tmp()
  writeFileSync(restartMarkerPath(dir), 'not-json{{{', 'utf8')
  const marker = readRestartMarker(dir)
  assert.equal(marker, undefined)
})

test('missing marker returns undefined without throwing', () => {
  const dir = tmp()
  const marker = readRestartMarker(dir)
  assert.equal(marker, undefined)
})

test('clearRestartMarker is a safe no-op when nothing is present', () => {
  const dir = tmp()
  clearRestartMarker(dir)
  assert.ok(true, 'clear on missing marker does not throw')
})

// --- host-instance record + resolveRestartNotice (ANY-restart detection) ---

test('host-instance record: write then read round-trips; missing/corrupt yields undefined', () => {
  const dir = tmp()
  assert.equal(readHostInstance(dir), undefined, 'missing record yields undefined')
  writeHostInstance(dir)
  const rec = readHostInstance(dir)
  assert.ok(rec !== undefined)
  assert.equal(rec.pid, process.pid)
  assert.equal(typeof rec.startedAt, 'number')
  assert.equal(typeof rec.lastSeenAt, 'number')
  writeFileSync(hostInstancePath(dir), 'broken{{', 'utf8')
  assert.equal(readHostInstance(dir), undefined, 'corrupt record yields undefined')
})

test('first ever start (no prev record, no marker) does not announce', () => {
  assert.equal(resolveRestartNotice({}), 'none')
})

test('second start with a previous record (pid differs) announces as external', () => {
  assert.equal(resolveRestartNotice({ prev: { pid: 111, startedAt: 1, lastSeenAt: 2 }, pid: 222 }), 'external')
})

test('fresh restart marker announces as requested (plugin-menu wording)', () => {
  assert.equal(resolveRestartNotice({ prev: { pid: 111, startedAt: 1, lastSeenAt: 2 }, marker: { at: 5, hostPid: 111 }, pid: 222 }), 'requested')
  // Marker wins even without a previous record.
  assert.equal(resolveRestartNotice({ marker: { at: 5, hostPid: 1 }, pid: 222 }), 'requested')
})

test('same pid (re-entry in one process) does not announce', () => {
  const pid = process.pid
  assert.equal(resolveRestartNotice({ prev: { pid, startedAt: 1, lastSeenAt: 2 } }), 'none')
})

test('restartNotice off suppresses even a requested restart', () => {
  assert.equal(resolveRestartNotice({ marker: { at: 5, hostPid: 1 }, mode: 'off' }), 'none')
  assert.equal(resolveRestartNotice({ prev: { pid: 111, startedAt: 1, lastSeenAt: 2 }, pid: 222, mode: 'off' }), 'none')
})

test('marked mode: only plugin-menu restarts announce', () => {
  const prev = { pid: 111, startedAt: 1, lastSeenAt: 2 }
  assert.equal(resolveRestartNotice({ prev, pid: 222, mode: 'marked' }), 'none')
  assert.equal(resolveRestartNotice({ marker: { at: 5, hostPid: 1 }, mode: 'marked' }), 'requested')
})

test('restartNoticeMaxGapMs: previous record older than the gap suppresses the notice', () => {
  const prev = { pid: 111, startedAt: 1000, lastSeenAt: 2000 }
  const now = 2000 + 61_000
  assert.equal(resolveRestartNotice({ prev, pid: 222, maxGapMs: 60_000, now }), 'none')
  // Within the gap (falls back to startedAt when lastSeenAt is missing) announces.
  assert.equal(resolveRestartNotice({ prev: { pid: 111, startedAt: 1000 }, pid: 222, maxGapMs: 60_000, now: 1000 + 60_000 }), 'external')
})