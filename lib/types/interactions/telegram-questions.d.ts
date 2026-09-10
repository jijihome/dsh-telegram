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
import type { Pending, QuestionMeta } from './pending-store.js';
import type { AskUserQuestionAnswer, UserQuestionItem } from './types.js';
import type { TelegramInlineKeyboard } from '../telegram/api.js';
export declare function newQuestionToken(): string;
/** 渲染问题文本与内联键盘。 */
export declare function renderQuestions(questions: UserQuestionItem[], token: string): {
    text: string;
    keyboard: TelegramInlineKeyboard | undefined;
};
/** 回填渲染时用到的 meta（供解析）。 */
export declare function questionMetaOf(questions: UserQuestionItem[], token: string): QuestionMeta;
/** 若一整轮问题已全部答完则返回完整答案；否则 undefined（仍等待剩余题）。 */
export declare function completeQuestion(pending: Pending): AskUserQuestionAnswer | undefined;
/** 处理一次内联键盘回调；返回 true 表示消费了这次点击。 */
export declare function answerFromCallback(pending: Pending, data: string): boolean;
/**
 * 处理一条纯文本回复。返回 { consumed, value }：
 * - consumed=false：不是本问题认识的回复（透传给会话/菜单）。
 * - consumed=true, value=undefined：已接受但还没答完（多题累积中途）。
 * - consumed=true, value=答案：这一轮问题全部答完。
 */
export declare function answerFromText(pending: Pending, text: string): {
    consumed: boolean;
    value?: AskUserQuestionAnswer;
};
