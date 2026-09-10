/**
 * Seam B（approval/request）的 Telegram 渲染与解析。
 *
 * 将一次审批请求渲染成卡片（工具名 + 原因）+「允许/拒绝」两个内联按钮，
 * 兜底接受纯文本词表（批准/同意/yes → allowed-once；拒绝/不同意/no → rejected）。
 *
 * 回调数据格式：`a:<token>:allow` | `a:<token>:reject`
 *
 * @module interactions/telegram-approval
 */
import { randomUUID } from 'node:crypto';
export function newApprovalToken() {
    return randomUUID();
}
/** 渲染审批卡片文本与键盘。 */
export function renderApproval(toolName, reason, token, words) {
    const lines = ['🔐 请求审批', `工具：<code>${escapeHtml(toolName)}</code>`];
    if (reason !== undefined && reason !== '')
        lines.push(`说明：${reason}`);
    lines.push('回复「批准」或「拒绝」，或点下方按钮：');
    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ 允许', callback_data: `a:${token}:allow` },
                { text: '⛔ 拒绝', callback_data: `a:${token}:reject` },
            ],
        ],
    };
    // 词表只在文档/提示里体现，实际解析由 answerApprovalFromText 完成。
    void words;
    return { text: lines.join('\n'), keyboard };
}
export function approvalMetaOf(token, toolName, reason) {
    return { token, toolName, reason };
}
/** 处理审批内联键盘回调；返回 true 表示消费（含「点错」，需返回可回答）。 */
export function answerApprovalFromCallback(pending, data) {
    const meta = pending.meta;
    if (meta === undefined)
        return { consumed: false };
    const m = /^a:([^:]+):(allow|reject)$/.exec(data);
    if (m === null || m[1] !== meta.token)
        return { consumed: false };
    return { consumed: true, outcome: m[2] === 'allow' ? 'allowed-once' : 'rejected' };
}
/** 处理审批纯文本回复。 */
export function answerApprovalFromText(pending, text, words) {
    const meta = pending.meta;
    if (meta === undefined)
        return { consumed: false };
    const t = text.trim().toLowerCase();
    if (words.approve.some(w => w.toLowerCase() === t))
        return { consumed: true, outcome: 'allowed-once' };
    if (words.reject.some(w => w.toLowerCase() === t))
        return { consumed: true, outcome: 'rejected' };
    return { consumed: false };
}
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
