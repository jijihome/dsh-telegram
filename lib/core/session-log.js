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
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
/** Zstandard frame magic (little-endian `28 B5 2F FD`). */
const ZSTD_MAGIC = 4247762216;
/** Longest title we keep from a first user message. */
const TITLE_MAX = 40;
/**
 * Locate every complete zstd frame in a concatenated-frame buffer.
 *
 * Mirrors the host's persistence scanner: parse the frame header (descriptor,
 * dictionary/content-size fields) then walk 3-byte block headers until the
 * `lastBlock` bit, honouring the optional 4-byte checksum.
 *
 * @param buffer - whole file contents.
 * @returns the complete frame ranges, in order.
 */
function scanFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            break;
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
            break;
        offset += 4;
        if (offset === buffer.length)
            break;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes)
            break;
        offset += remainingHeaderBytes;
        let complete = false;
        for (;;) {
            if (buffer.length - offset < 3)
                break;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes)
                break;
            offset += payloadBytes;
            if (lastBlock) {
                complete = true;
                break;
            }
        }
        if (!complete)
            break;
        if (checksum) {
            if (buffer.length - offset < 4)
                break;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}
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
export function encodeSessionId(id) {
    return id.replace(/[^A-Za-z0-9._-]/g, ch => `~${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
}
/**
 * Index every session log under a sessions root: id → log path + last write.
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions`.
 * @returns map keyed by the raw (decoded) session id.
 */
export function indexSessionLogs(sessionsRoot) {
    const out = new Map();
    let workspaces = [];
    try {
        workspaces = readdirSync(sessionsRoot);
    }
    catch {
        return out;
    }
    for (const ws of workspaces) {
        const wsDir = join(sessionsRoot, ws);
        let dirs = [];
        try {
            dirs = readdirSync(wsDir);
        }
        catch {
            continue;
        }
        for (const dir of dirs) {
            const file = join(wsDir, dir, 'session.v3.jsonl.zstd');
            if (!existsSync(file))
                continue;
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(file).mtimeMs;
            }
            catch { /* keep 0 */ }
            // The directory name is the encoded id; index both spellings so a caller
            // can look up by raw id without re-encoding.
            out.set(dir, { path: file, mtimeMs });
            out.set(decodeSessionId(dir), { path: file, mtimeMs });
        }
    }
    return out;
}
/**
 * Decode a directory-name spelling back to a session id (inverse of
 * {@link encodeSessionId}).
 *
 * @param encoded - directory name.
 * @returns the decoded id.
 */
export function decodeSessionId(encoded) {
    return encoded.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}
/**
 * Title + last-activity time + blank flag from one session log.
 *
 * The title is the first user message's first non-empty line, truncated — the
 * same fact the host derives its title projection from. `blank` mirrors the
 * host's rule: a Session stops being blank at its first `turn/start`, so a log
 * without one is an abandoned empty session (the GUI hides those). Returns what
 * it could read; callers keep whatever they had for the missing parts.
 *
 * @param logPath - path to `session.v3.jsonl.zstd`.
 * @returns the summary, best effort.
 */
export function readSessionSummary(logPath) {
    const out = {};
    try {
        out.updatedAt = statSync(logPath).mtimeMs;
    }
    catch { /* keep undefined */ }
    let sawTurn = false;
    try {
        const buffer = readFileSync(logPath);
        const frames = scanFrames(buffer);
        if (frames.length === 0)
            return out;
        for (const frame of frames) {
            let text;
            try {
                text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
            }
            catch {
                continue;
            }
            for (const line of text.split('\n')) {
                if (line === '')
                    continue;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (event.type === 'turn/start') {
                    sawTurn = true;
                    if (out.title !== undefined)
                        return { ...out, blank: false };
                    continue;
                }
                if (event.type !== 'user/message')
                    continue;
                const blocks = event.data?.content ?? [];
                const raw = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');
                const firstLine = raw.split('\n').map(s => s.trim()).find(s => s !== '');
                if (firstLine === undefined)
                    continue;
                out.title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
                if (sawTurn)
                    return { ...out, blank: false };
            }
        }
        out.blank = !sawTurn;
    }
    catch { /* best effort: an unreadable log yields no blank verdict either */ }
    return out;
}
