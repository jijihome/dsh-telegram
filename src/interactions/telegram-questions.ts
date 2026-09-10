/**
 * Seam A（user-questions/request）的 Telegram 渲染与解析。
 *
 * 将一轮问题渲染成「编号文本 + 每选项一个内联按钮」，并支持两种作答方式：
 * - 点按钮：单选每题一个按钮，多题逐题累积，全部答完才判定一轮完成。
 * - 纯文本：多选/单选用序号回复（单个 "2"，多选 "1,3"）；仅单题时支持。
 *
 * 回调数据格式：`q:<token>:<qIdx>:<labelIdx>`
 *
 * @module interactions/telegram-questions
 */

import type { Pending, QuestionMeta } from './pending-store.js'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, UserQuestionItem } from './types.js'
import type { TelegramInlineKeyboard } from '../telegram/api.js'
import { randomUUID } from 'node:crypto'

/** 每道题解析到的局部答案累积器（随 pending 生命周期）。 */
const accumulators = new WeakMap<Pending, Map<number, string[]>>()

function accumulatorFor(pending: Pending): Map<number, string[]> {
  let acc = accumulators.get(pending)
  if (acc === undefined) {
    acc = new Map()
    accumulators.set(pending, acc)
  }
  return acc
}

export function newQuestionToken(): string {
  return randomUUID()
}

/** 渲染问题文本与内联键盘。 */
export function renderQuestions(
  questions: UserQuestionItem[],
  token: string,
): { text: string; keyboard: TelegramInlineKeyboard | undefined } {
  const meta: QuestionMeta['items'] = questions.map(q => ({
    id: q.id,
    options: (q.options ?? []).map(o => o.label),
    multiSelect: q.multiSelect === true,
  }))
  const parts: string[] = ['❓ 需要你选择：']
  const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = []
  questions.forEach((q, qi) => {
    const title = q.header ? `${q.header}：` : ''
    parts.push(`${qi + 1}. ${title}${q.question}`)
    if (q.detail !== undefined && q.detail !== '') parts.push(`　${q.detail}`)
    const labels = meta[qi].options
    labels.forEach((label, li) => {
      parts.push(`　${li + 1}. ${label}`)
    })
    // 单选才给内联键盘按钮；多选依赖文本序号。
    if (!meta[qi].multiSelect && labels.length > 0) {
      keyboardRows.push(labels.map((label, li) => ({ text: `${li + 1}`, callback_data: `q:${token}:${qi}:${li}` })))
    }
    if (meta[qi].multiSelect) {
      parts.push(`　（可多选，请用序号回复，逗号分隔，如 1,3）`)
    } else {
      parts.push(`　（回复序号，或点下方按钮）`)
    }
  })
  return { text: parts.join('\n'), keyboard: keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined }
}

/** 回填渲染时用到的 meta（供解析）。 */
export function questionMetaOf(questions: UserQuestionItem[], token: string): QuestionMeta {
  return {
    token,
    items: questions.map(q => ({
      id: q.id,
      options: (q.options ?? []).map(o => o.label),
      multiSelect: q.multiSelect === true,
    })),
  }
}

/** 若一整轮问题已全部答完则返回完整答案；否则 undefined（仍等待剩余题）。 */
export function completeQuestion(pending: Pending): AskUserQuestionAnswer | undefined {
  const meta = pending.meta as QuestionMeta
  const acc = accumulatorFor(pending)
  if (meta === undefined || meta.items.length === 0) return undefined
  const answers: AskUserQuestionAnswerItem[] = []
  for (let i = 0; i < meta.items.length; i++) {
    const selected = acc.get(i)
    if (selected === undefined) return undefined // 未完
    answers.push({ id: meta.items[i].id, selected })
  }
  return { answers }
}

/** 处理一次内联键盘回调；返回 true 表示消费了这次点击。 */
export function answerFromCallback(pending: Pending, data: string): boolean {
  const meta = pending.meta as QuestionMeta | undefined
  if (meta === undefined) return false
  const m = /^q:([^:]+):(\d+):(\d+)$/.exec(data)
  if (m === null || m[1] !== meta.token) return false
  const qi = Number(m[2])
  const li = Number(m[3])
  const q = meta.items[qi]
  if (q === undefined || q.multiSelect || q.options[li] === undefined) return false
  accumulatorFor(pending).set(qi, [q.options[li]])
  return true
}

/**
 * 处理一条纯文本回复。返回 { consumed, value }：
 * - consumed=false：不是本问题认识的回复（透传给会话/菜单）。
 * - consumed=true, value=undefined：已接受但还没答完（多题累积中途）。
 * - consumed=true, value=答案：这一轮问题全部答完。
 */
export function answerFromText(
  pending: Pending,
  text: string,
): { consumed: boolean; value?: AskUserQuestionAnswer } {
  const meta = pending.meta as QuestionMeta | undefined
  if (meta === undefined || meta.items.length === 0) return { consumed: false }
  // 只支持「整轮作答」为 1 道题；多题时文本无法无歧义分隔，忽略文本。
  if (meta.items.length !== 1) return { consumed: false }
  const q = meta.items[0]
  const nums = text
    .trim()
    .split(/[,\s、，]+/)
    .map(s => Number(s))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= q.options.length)
  if (nums.length === 0) return { consumed: false }
  const selected = nums.map(n => q.options[n - 1])
  if (selected.some(s => s === undefined)) return { consumed: false }
  const acc = accumulatorFor(pending)
  acc.set(0, selected)
  const value = completeQuestion(pending)
  return value !== undefined ? { consumed: true, value } : { consumed: true }
}