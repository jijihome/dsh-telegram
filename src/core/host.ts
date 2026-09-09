/**
 * Host operations: schedule a DSH process restart and read host info.
 *
 * "Restart dsh" means restarting the host process this plugin runs in (the
 * `dsh ... web` process, PID 18808 in the live deployment). Because the plugin
 * lives inside that process, a restart is performed by a *detached* agent (see
 * ./host-agent.ts) that the plugin spawns, then unrefs — the agent kills the
 * host PID and relaunches the exact same command line. See that module for why
 * the agent must be detached.
 *
 * @module core/host
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Options for {@link scheduleRestart}. */
export interface ScheduleRestartOptions {
  /** Milliseconds to wait before taking the host down (delivery buffer). */
  delayMs?: number
  /**
   * Test seam: override the host-derived values. Omitted in production, where
   * everything is read from the live host process.
   */
  seam?: { hostPid?: number; nodePath?: string; upstreamArgv?: string[]; cwd?: string }
}

/** Return a human-readable snapshot of the host process for the ops panel. */
export function getHostInfo(): string {
  const text = [
    `• PID: ${process.pid}`,
    `• Node: ${process.version} (${process.platform}/${process.arch})`,
    `• 启动命令: ${process.argv.join(' ')}`,
    `• 工作目录: ${process.cwd()}`,
  ]
  return text.join('\n')
}

/**
 * Schedule a restart of the host dsh process.
 *
 * The agent is spawned detached and unref'd so it outlives the host. The
 * delayMs (default 3s) is the confirmation-window: the caller should have
 * already told the user "restarting" via Telegram, and the agent waits out
 * this window before killing the host so that message is delivered.
 *
 * @returns the agent payload used (for logging/tests).
 */
export function scheduleRestart(options: ScheduleRestartOptions = {}): string {
  const delayMs = options.delayMs ?? 3000
  const seam = options.seam ?? {}
  const hostPid = seam.hostPid ?? process.pid
  const nodePath = seam.nodePath ?? process.execPath
  const upstreamArgv = seam.upstreamArgv ?? process.argv.slice(1)
  const cwd = seam.cwd ?? process.cwd()

  // Resolve the agent script path from this module's own location.
  const agentPath = fileURLToPath(new URL('./host-agent.js', import.meta.url))
  const payload = JSON.stringify({ delayMs, hostPid, nodePath, upstreamArgv, cwd })

  const child = spawn(nodePath, [agentPath, payload], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DSH_RESTART_AGENT: '1' },
  })
  child.unref()
  return payload
}
