/**
 * Host restart agent — a *separate, detached* process that owns the actual
 * kill-and-relaunch of the host dsh process.
 *
 * Why it must be detached: the dsh-telegram plugin runs *inside* the host dsh
 * process. If the plugin itself killed the host, nothing would remain to bring
 * it back. So the plugin only *schedules* this agent; the agent survives the
 * host's death (it is spawned detached and unref'd), waits out the delay (so
 * the Telegram confirmation is delivered first), force-kills the host PID, then
 * relaunches it with the exact command line the host was originally started
 * with.
 *
 * This file is a pure agent entry point: it is never imported by the plugin.
 * The plugin resolves its path and runs it with `node <host-agent.js> <payload>`
 * plus the `DSH_RESTART_AGENT=1` environment flag. Nothing here is exported.
 *
 * @module core/host-agent
 */

import { spawn } from 'node:child_process'

/** Payload serialized by the plugin and passed as argv[2]. */
interface AgentPayload {
  /** Milliseconds to wait before taking the host down. */
  delayMs: number
  /** Host dsh/plugin process id to kill. */
  hostPid: number
  /** Node executable used to relaunch the host. */
  nodePath: string
  /** Original host argv (minus the node executable) used to relaunch. */
  upstreamArgv: string[]
  /** Working directory the relaunched host should run in. */
  cwd: string
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Drain an agent payload from argv[2] (JSON) when invoked by the plugin. */
function readPayload(): AgentPayload | undefined {
  if (process.env.DSH_RESTART_AGENT !== '1') return undefined
  if (process.argv.length < 3) return undefined
  try {
    return JSON.parse(process.argv[2]) as AgentPayload
  } catch {
    return undefined
  }
}

/** Run the agent: wait, kill the host, relaunch it. */
async function run(payload: AgentPayload): Promise<void> {
  // Wait out the confirmation window so the "restarting" message is delivered.
  await sleep(payload.delayMs)
  // Force-kill the host regardless of whether it is mid-flight.
  try {
    process.kill(payload.hostPid)
  } catch {
    // Already gone; nothing to kill.
  }
  // Give the listening port a moment to release before relaunching.
  await sleep(1200)
  // Relaunch the host detached so it outlives this agent.
  const child = spawn(payload.nodePath, payload.upstreamArgv, {
    cwd: payload.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

const payload = readPayload()
if (payload !== undefined) {
  void run(payload)
}
