/**
 * Event normalizer: translates DSH `session/event` / `assistant/chunk`
 * payloads into the plugin's unified message stream used by the renderer.
 *
 * Live facts (verified by probe on dsh 0.1.2-rc.1):
 * - `session/event` fires for every persisted event with the full lifecycle:
 *   turn/start, step/start, user/message, assistant/chunk (token deltas),
 *   assistant/message (final), step/end, turn/end, … plus approval/policy,
 *   permission/preset etc.
 * - `assistant/chunk` events carry `data.chunk: StreamChunk`:
 *   text-delta | reasoning-delta | tool-call-delta | block-start | block-end | usage | finish.
 * - `agent/assistant-stream` does NOT fire on headless profiles (verified), so
 *   incremental presence comes from the `assistant/chunk` events instead.
 *
 * @module core/event-normalizer
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/**
 * A turn-terminating status that is NOT a clean success. The plugin surfaces
 * each interruption cause as a distinct line so the bot always learns why a
 * turn ended (cancel / error / blocked / token ceiling / crash-orphaned).
 */
export type TerminalStatus = 'cancelled' | 'error' | 'blocked' | 'max-tokens' | 'interrupted';
/** One normalized outbound message for the renderer/delivery. */
export type NormalizedMessage = {
    kind: 'text-delta';
    text: string;
} | {
    kind: 'reasoning-delta';
    text: string;
} | {
    kind: 'tool-call-delta';
    name: string;
    argumentsDelta: string;
} | {
    kind: 'assistant-final';
    text: string;
    interrupted?: boolean;
} | {
    kind: 'status';
    status: 'running' | 'done' | TerminalStatus;
    detail?: string;
} | {
    kind: 'approval';
    summary: string;
} | {
    kind: 'user-message';
    text: string;
};
/** Normalize one assistant/chunk's StreamChunk into a message. */
export declare function normalizeChunk(chunk: StreamChunk): NormalizedMessage | undefined;
/**
 * Normalize a persisted `session/event` into a message, when the event type
 * is one we surface. Returns undefined for noise we do not forward.
 */
export declare function normalizeSessionEvent(event: SessionEvent): NormalizedMessage | undefined;
