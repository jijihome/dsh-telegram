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
import type { ApprovalMeta, Pending } from './pending-store.js';
import type { ApprovalOutcome } from './types.js';
import type { TelegramInlineKeyboard } from '../telegram/api.js';
export declare function newApprovalToken(): string;
export interface ApprovalWords {
    approve: string[];
    reject: string[];
}
/** 渲染审批卡片文本与键盘。 */
export declare function renderApproval(toolName: string, reason: string | undefined, token: string, words: ApprovalWords): {
    text: string;
    keyboard: TelegramInlineKeyboard;
};
export declare function approvalMetaOf(token: string, toolName: string, reason: string | undefined): ApprovalMeta;
/** 处理审批内联键盘回调；返回 true 表示消费（含「点错」，需返回可回答）。 */
export declare function answerApprovalFromCallback(pending: Pending, data: string): {
    consumed: boolean;
    outcome?: ApprovalOutcome;
};
/** 处理审批纯文本回复。 */
export declare function answerApprovalFromText(pending: Pending, text: string, words: ApprovalWords): {
    consumed: boolean;
    outcome?: ApprovalOutcome;
};
