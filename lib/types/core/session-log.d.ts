/**
 * Session-log reading for ids the host does not project.
 *
 * The host writes a projection-cache entry per GUI session, but NOT for the
 * `telegram:…` sessions this plugin creates. Those therefore have no title and
 * no last-activity time anywhere the host exposes, and the picker showed them as
 * `-- · telegram:bot-a:…:g7`. This module reads the durable session log itself:
 * the file's mtime is the last activity, and the first user message is the title
 * (the same fact the host's title projection is derived from).
 *
 * Format trap: a `session.v3.jsonl.zstd` is a concatenation of INDEPENDENT zstd
 * frames (header frame first, then one frame per appended batch). Node's
 * `zstdDecompressSync` decodes only the FIRST frame — the header — so a naive
 * read yields metadata and no events. The frame walk below is the same algorithm
 * the host's persistence layer uses.
 *
 * @module core/session-log
 */
/**
 * Encode a session id the way the sessions directory spells it.
 *
 * Observed on this host: `telegram:bot-a:6434599758:g6` lives in a directory
 * named `telegram~003Abot-a~003A6434599758~003Ag6`, i.e. every character outside
 * the filesystem-safe set becomes `~` + its 4-hex-digit code point.
 *
 * @param id - raw session id.
 * @returns the directory-name-safe spelling.
 */
export declare function encodeSessionId(id: string): string;
/**
 * Index every session log under a sessions root: id → log path + last write.
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions`.
 * @returns map keyed by the raw (decoded) session id.
 */
export declare function indexSessionLogs(sessionsRoot: string): Map<string, {
    path: string;
    mtimeMs: number;
}>;
/**
 * Decode a directory-name spelling back to a session id (inverse of
 * {@link encodeSessionId}).
 *
 * @param encoded - directory name.
 * @returns the decoded id.
 */
export declare function decodeSessionId(encoded: string): string;
/**
 * Title + last-activity time from one session log.
 *
 * The title is the first user message's first non-empty line, truncated — the
 * same fact the host derives its title projection from. Returns `{}` when the log
 * cannot be read; callers then keep whatever they had.
 *
 * @param logPath - path to `session.v3.jsonl.zstd`.
 * @returns the summary, best effort.
 */
export declare function readSessionSummary(logPath: string): {
    title?: string;
    updatedAt?: number;
};
