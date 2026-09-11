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
export declare function isUserFacingSessionId(id: string): boolean;
/**
 * Whether an id is one this plugin created (its own agent sessions).
 *
 * @param id - session id to test.
 * @returns `true` for `telegram:…` ids.
 */
export declare function isOwnSessionId(id: string): boolean;
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
export declare function workspaceMemberIdsToAdd(existing: ReadonlySet<string>, members: readonly string[], archived: ReadonlySet<string>): string[];
