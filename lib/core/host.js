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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Path of the one-shot restart marker file. */
export function restartMarkerPath(markerDir) {
    return join(markerDir, 'restart-marker.json');
}
/**
 * Record that a DSH restart was requested by this plugin. Written right before
 * the host is scheduled down; the rebooted instance looks for a fresh marker
 * and, when one is found, announces "已上线" over Telegram before deleting it.
 * A marker that is too old (or from a manual host restart) is ignored.
 */
export function writeRestartMarker(markerDir, at = Date.now()) {
    try {
        const dir = dirname(restartMarkerPath(markerDir));
        mkdirSync(dir, { recursive: true });
        const payload = { at, hostPid: process.pid };
        writeFileSync(restartMarkerPath(markerDir), JSON.stringify(payload), 'utf8');
    }
    catch {
        // A failed marker write must never break the restart itself.
    }
}
/**
 * Read and clear the one-shot restart marker. Returns the marker only when it
 * was written recently (within `freshMs`, default 60s) — i.e. this host came
 * back up because of a plugin-triggered restart, not a manual one.
 */
export function readRestartMarker(markerDir, freshMs = 60_000) {
    const path = restartMarkerPath(markerDir);
    try {
        if (!existsSync(path))
            return undefined;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed?.at !== 'number')
            return undefined;
        const fresh = Date.now() - parsed.at <= freshMs;
        // Clear regardless of freshness so stale markers never linger or re-fire.
        rmSync(path, { force: true });
        return fresh ? parsed : undefined;
    }
    catch {
        try {
            rmSync(path, { force: true });
        }
        catch { /* best effort */ }
        return undefined;
    }
}
/** Return a human-readable snapshot of the host process for the ops panel. */
export function getHostInfo() {
    const text = [
        `• PID: ${process.pid}`,
        `• Node: ${process.version} (${process.platform}/${process.arch})`,
        `• 启动命令: ${process.argv.join(' ')}`,
        `• 工作目录: ${process.cwd()}`,
    ];
    return text.join('\n');
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
export function scheduleRestart(options = {}) {
    const delayMs = options.delayMs ?? 3000;
    const seam = options.seam ?? {};
    const hostPid = seam.hostPid ?? process.pid;
    const nodePath = seam.nodePath ?? process.execPath;
    const upstreamArgv = seam.upstreamArgv ?? process.argv.slice(1);
    const cwd = seam.cwd ?? process.cwd();
    // Record that this host is going down for a plugin-triggered restart, so the
    // rebooted instance can announce "已上线". A manual host restart leaves no
    // marker and stays silent.
    const markerDir = options.markerDir ?? join(cwd, 'data');
    writeRestartMarker(markerDir);
    // Resolve the agent script path from this module's own location.
    const agentPath = fileURLToPath(new URL('./host-agent.js', import.meta.url));
    const payload = JSON.stringify({ delayMs, hostPid, nodePath, upstreamArgv, cwd });
    const child = spawn(nodePath, [agentPath, payload], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, DSH_RESTART_AGENT: '1' },
    });
    child.unref();
    return payload;
}
