/**
 * Renderer: turns normalized messages into human-readable Telegram display
 * text. Pure and synchronous for easy testing.
 *
 * @module core/renderer
 */
import type { NormalizedMessage, TerminalStatus } from './event-normalizer.js';
/** Per-chat live rendering state: reasoning/tool buffers that accompany the text stream. */
export interface RenderState {
    /** Currently visible tool call name (reset on block-end/assistant-final). */
    toolName?: string;
}
/**
 * Render one normalized message into a display line (or undefined for pure
 * deltas that the delivery layer already appends directly).
 *
 * Design: text-delta and reasoning-delta are *streamed* (delivery appends
 * them raw), so renderer only produces discrete status/echo lines:
 * - tool-call-delta → inline overlay line
 * - assistant-final → the final answer (delivery sends it as a fresh message)
 * - status → status line
 * - approval → approval line
 * - user-message → echo line
 */
export declare function renderMessage(message: NormalizedMessage, state: RenderState): string | undefined;
/**
 * Render a status line for a turn-lifecycle signal. Running/done are the
 * non-interrupting states; every terminal status carries its own emoji so the
 * bot reader can tell the interruption cause at a glance.
 */
export declare function renderStatus(status: 'running' | 'done' | TerminalStatus, detail?: string): string;
/** Short summary of a LiveState line prefix for the streaming segment. */
export declare function renderSegmentHeader(state: RenderState): string;
