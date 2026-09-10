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
/**
 * Durable per-boot host record. Written by every host activation under the
 * data root; the next activation reads the previous record to detect that the
 * host process restarted (pid changed), so an external/manual restart — which
 * leaves no restart marker — is still announced.
 */
export interface HostInstanceRecord {
    /** PID of the host process that wrote the record. */
    pid: number;
    /** Unix-epoch-ms of that host's startup (record creation). */
    startedAt: number;
    /** Unix-epoch-ms of the last write by that host. */
    lastSeenAt: number;
}
/** Path of the durable host-instance record. */
export declare function hostInstancePath(dir: string): string;
/** Read the previous host-instance record; undefined when absent/corrupt. */
export declare function readHostInstance(dir: string): HostInstanceRecord | undefined;
/**
 * Write this host's instance record. Called once per activation AFTER the
 * previous record was read, so restart detection is idempotent: the next boot
 * sees this process's pid and does not announce again.
 */
export declare function writeHostInstance(dir: string, at?: number): void;
/** What the startup hook should broadcast after this boot. */
export type RestartNoticeKind = 'requested' | 'external' | 'none';
/** Options for {@link resolveRestartNotice}. */
export interface ResolveRestartNoticeOptions {
    /** Previous host-instance record, if one was on disk. */
    prev?: HostInstanceRecord;
    /** Fresh restart marker, if one was found. */
    marker?: RestartMarker;
    /** Current process pid. Defaults to `process.pid`. */
    pid?: number;
    /** Notice policy from config. Default `always`. */
    mode?: 'always' | 'marked' | 'off';
    /** Skip the notice when the previous record is older than this. 0 = no limit. */
    maxGapMs?: number;
    /** Test seam: override the clock used for the gap check. */
    now?: number;
}
/**
 * Decide the restart-notice kind for this boot. A fresh marker means the
 * restart was requested from the plugin menu (`requested`); otherwise a
 * previous record whose pid differs from this process means an external or
 * manual restart (`external`); anything else (`none`) stays silent.
 */
export declare function resolveRestartNotice(options?: ResolveRestartNoticeOptions): RestartNoticeKind;
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
