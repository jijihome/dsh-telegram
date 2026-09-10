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
/** Options for {@link scheduleRestart}. */
export interface ScheduleRestartOptions {
    /** Milliseconds to wait before taking the host down (delivery buffer). */
    delayMs?: number;
    /**
     * Test seam: override the host-derived values. Omitted in production, where
     * everything is read from the live host process.
     */
    seam?: {
        hostPid?: number;
        nodePath?: string;
        upstreamArgv?: string[];
        cwd?: string;
    };
    /**
     * Directory to record a one-shot "restart requested" marker into, so the
     * rebooted host can announce it came back online. Defaults to `<cwd>/data`.
     */
    markerDir?: string;
}
/** Content of the one-shot restart marker written before the host goes down. */
export interface RestartMarker {
    /** Unix-epoch-ms of when the restart was scheduled. */
    at: number;
    /** PID of the host that was scheduled to be killed. */
    hostPid: number;
}
/** Path of the one-shot restart marker file. */
export declare function restartMarkerPath(markerDir: string): string;
/**
 * Record that a DSH restart was requested by this plugin. Written right before
 * the host is scheduled down; the rebooted instance looks for a fresh marker
 * and, when one is found, announces "已上线" over Telegram before deleting it.
 * A marker that is too old (or from a manual host restart) is ignored.
 */
export declare function writeRestartMarker(markerDir: string, at?: number): void;
/**
 * Peek at the one-shot restart marker WITHOUT deleting it. Returns the marker
 * only when it was written recently (within `freshMs`, default 60s) — i.e. this
 * host came back up because of a plugin-triggered restart, not a manual one.
 *
 * Deliberately does not delete: the caller broadcasts "已上线" over Telegram and
 * must retry on transient delivery failure, then clear the marker only after a
 * confirmed send (see {@link clearRestartMarker}). Deleting eagerly would drop
 * the announcement when the first send hits a network hiccup.
 */
export declare function readRestartMarker(markerDir: string, freshMs?: number): RestartMarker | undefined;
/**
 * Remove the restart marker after the "已上线" announcement was delivered, so a
 * later manual boot never re-fires. Safe to call repeatedly.
 */
export declare function clearRestartMarker(markerDir: string): void;
/** Return a human-readable snapshot of the host process for the ops panel. */
export declare function getHostInfo(): string;
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
export declare function scheduleRestart(options?: ScheduleRestartOptions): string;
