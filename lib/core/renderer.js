/**
 * Renderer: turns normalized messages into human-readable Telegram display
 * text. Pure and synchronous for easy testing.
 *
 * @module core/renderer
 */
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
export function renderMessage(message, state) {
    switch (message.kind) {
        case 'text-delta':
        case 'reasoning-delta':
            // Streamed raw by delivery; nothing to render as a separate line.
            return undefined;
        case 'tool-call-delta': {
            if (message.name !== '')
                state.toolName = message.name;
            const name = state.toolName ?? 'tool';
            return `🛠 <code>${escapeDisplay(name)}</code> ${message.argumentsDelta}`;
        }
        case 'assistant-final':
            state.toolName = undefined;
            return message.text;
        case 'status':
            switch (message.status) {
                case 'running':
                    return '⏳ agent 开始运行…';
                case 'done':
                    return '✅ 完成';
                case 'cancelled':
                    return '⛔ 已取消';
                case 'error':
                    return `❌ 错误${message.detail ? `: ${message.detail}` : ''}`;
            }
            break;
        case 'approval':
            return `🔐 审批:${message.summary}`;
        case 'user-message':
            return `🧑 {quote}${message.text}`;
    }
}
/** Escape angle brackets for display inside <code> spans. */
function escapeDisplay(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Short summary of a LiveState line prefix for the streaming segment. */
export function renderSegmentHeader(state) {
    return state.toolName !== undefined ? `🛠 ${state.toolName}` : '🤖';
}
