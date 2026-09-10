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

import type { ApprovalMeta, Pending } from './pending-store.js'
import type { ApprovalOutcome } from './types.js'
import type { TelegramInlineKeyboard } from '../telegram/api.js'
import { randomUUID } from 'node:crypto'

export function newApprovalToken(): string {
  return randomUUID()
}

export interface ApprovalWords {
  approve: string[]
  reject: string[]
}

/** 渲染审批卡片文本与键盘。 */
export function renderApproval(
  toolName: string,
  reason: string | undefined,
  token: string,
  words: ApprovalWords,
): { text: string; keyboard: TelegramInlineKeyboard } {
  const lines = ['🔐 请求审批', `工具：<code>${escapeHtml(toolName)}</code>`]
  if (reason !== undefined && reason !== '') lines.push(`说明：${reason}`)
  lines.push('回复「批准」或「拒绝」，或点下方按钮：')
  const keyboard: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ 允许', callback_data: `a:${token}:allow` },
        { text: '⛔ 拒绝', callback_data: `a:${token}:reject` },
      ],
    ],
  }
  // 词表只在文档/提示里体现，实际解析由 answerApprovalFromText 完成。
  void words
  return { text: lines.join('\n'), keyboard }
}

export function approvalMetaOf(token: string, toolName: string, reason: string | undefined): ApprovalMeta {
  return { token, toolName, reason }
}

/** 处理审批内联键盘回调；返回 true 表示消费（含「点错」，需返回可回答）。 */
export function answerApprovalFromCallback(pending: Pending, data: string): { consumed: boolean; outcome?: ApprovalOutcome } {
  const meta = pending.meta as ApprovalMeta | undefined
  if (meta === undefined) return { consumed: false }
  const m = /^a:([^:]+):(allow|reject)$/.exec(data)
  if (m === null || m[1] !== meta.token) return { consumed: false }
  return { consumed: true, outcome: m[2] === 'allow' ? 'allowed-once' : 'rejected' }
}

/** 处理审批纯文本回复。 */
export function answerApprovalFromText(
  pending: Pending,
  text: string,
  words: ApprovalWords,
): { consumed: boolean; outcome?: ApprovalOutcome } {
  const meta = pending.meta as ApprovalMeta | undefined
  if (meta === undefined) return { consumed: false }
  const t = text.trim().toLowerCase()
  if (words.approve.some(w => w.toLowerCase() === t)) return { consumed: true, outcome: 'allowed-once' }
  if (words.reject.some(w => w.toLowerCase() === t)) return { consumed: true, outcome: 'rejected' }
  return { consumed: false }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}