/**
 * Host restart-marker tests (compiled `lib`).
 *
 * Covers the "已上线" restart hook of 方案C:
 * - writeRestartMarker + readRestartMarker round-trip (fresh marker consumed);
 * - a stale marker is ignored AND consumed (never re-fires on a later boot);
 * - a missing/corrupt marker returns undefined without throwing;
 * - readRestartMarker deletes the file either way (no lingering marker).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeRestartMarker,
  readRestartMarker,
  restartMarkerPath,
} from '../lib/core/host.js'

/** Temp dir per test. */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-tg-host-'))
}

test('writeRestartMarker + readRestartMarker: fresh marker is returned and consumed', () => {
  const dir = tmp()
  writeRestartMarker(dir)
  assert.ok(existsSync(restartMarkerPath(dir)), 'marker file exists after write')

  const marker = readRestartMarker(dir)
  assert.ok(marker !== undefined, 'fresh marker is read')
  assert.equal(typeof marker.at, 'number')
  assert.equal(typeof marker.hostPid, 'number')
  assert.ok(!existsSync(restartMarkerPath(dir)), 'marker is consumed (file removed)')
})

test('stale marker is ignored and consumed (never re-fires on a later boot)', () => {
  const dir = tmp()
  // Write a marker "2 hours ago": from a manual/panic restart, must be ignored.
  writeRestartMarker(dir, Date.now() - 2 * 60 * 60 * 1000)
  const marker = readRestartMarker(dir, 60_000)
  assert.equal(marker, undefined, 'stale marker yields undefined')
  assert.ok(!existsSync(restartMarkerPath(dir)), 'stale marker is still cleaned up')
})

test('corrupt marker returns undefined without throwing, and is cleaned', () => {
  const dir = tmp()
  writeFileSync(restartMarkerPath(dir), 'not-json{{{', 'utf8')
  const marker = readRestartMarker(dir)
  assert.equal(marker, undefined)
  assert.ok(!existsSync(restartMarkerPath(dir)), 'corrupt marker is removed')
})

test('missing marker returns undefined without throwing', () => {
  const dir = tmp()
  const marker = readRestartMarker(dir)
  assert.equal(marker, undefined)
})