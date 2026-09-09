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
}
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
