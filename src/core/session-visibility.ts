/**
 * Session visibility rules: which session ids belong in a user-facing picker.
 *
 * Mirrors the Web GUI's own rule (`sessionVisible` in
 * `dsh-client-ui-workspace`): child agents are NOT conversations. The GUI learns
 * that from its list projection's `origin === 'subagent'`, but the raw projection
 * CACHE on disk carries no `origin` at all (`identity` only holds
 * formatVersion/createdAt/cwd/isSeeded/inheritedEventCount), so a roster built
 * from those files cannot apply the origin test and ends up listing every
 * memory-keeper / companion child run as if the user had created it.
 *
 * What the cache DOES distinguish is the id shape:
 * - top-level GUI sessions are `session-<uuid>`;
 * - this plugin's own sessions are `telegram:<bot>:<chat>[:g<N>]`;
 * - child/subagent sessions are a BARE uuid with no session log of their own.
 *
 * @module core/session-visibility
 */

/** Id shape of a top-level (user-facing) session. */
const TOP_LEVEL = /^(session-[0-9a-f-]+|telegram:)/i

/**
 * Whether a session id may appear in the user-facing session picker.
 *
 * Applies to ids sourced from the raw projection cache, where no `origin`
 * marker exists. Ids coming from the host gateway keep their own `origin` test
 * and are not routed through this shim.
 *
 * @param id - session id as spelled by the source.
 * @returns `true` for top-level conversations, `false` for bare-uuid child runs.
 */
export function isUserFacingSessionId(id: string): boolean {
  return TOP_LEVEL.test(id)
}

/**
 * Whether an id is one this plugin created (its own agent sessions).
 *
 * @param id - session id to test.
 * @returns `true` for `telegram:…` ids.
 */
export function isOwnSessionId(id: string): boolean {
  return id.startsWith('telegram:')
}

/**
 * Workspace-member sessions missing from a roster.
 *
 * The GUI groups sessions by a Workspace's `sessionIds` membership — not by the
 * session's own cwd — and sessions created by a plugin have no projection-cache
 * entry at all, so a cwd-matched roster silently omits them. Callers add these
 * ids to close that gap; archived ids are never added (the GUI hides them).
 *
 * @param existing - ids already present in the roster.
 * @param members - the workspace's `sessionIds`.
 * @param archived - the registry-global archive set.
 * @returns member ids worth adding, in membership order.
 */
export function workspaceMemberIdsToAdd(
  existing: ReadonlySet<string>,
  members: readonly string[],
  archived: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const seen = new Set(existing)
  for (const id of members) {
    if (id === '' || seen.has(id) || archived.has(id)) continue
    out.push(id)
    seen.add(id)
  }
  return out
}

/**
 * Apply the host's blank rule to a roster.
 *
 * The GUI's `sessionVisible` hides a Session whose folded prefix contains no turn
 * (`blank`) unless it is the one currently selected — that provisional "New
 * Session" row is the only blank it shows. A workspace-membership roster built
 * from disk therefore lists abandoned empty sessions (they appear in the
 * Workspace account but never ran a turn), which is exactly the row the user sees
 * here but not in the Web GUI.
 *
 * @param list - candidate sessions, newest first is caller's concern.
 * @param activeId - the session this chat currently drives (kept even when blank).
 * @returns the list without abandoned blank sessions.
 */
export function dropBlankSessions<T extends { id: string; blank?: boolean }>(
  list: readonly T[],
  activeId: string | undefined,
): T[] {
  return list.filter(s => s.blank !== true || s.id === activeId)
}
