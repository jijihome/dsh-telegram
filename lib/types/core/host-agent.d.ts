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
export {};
