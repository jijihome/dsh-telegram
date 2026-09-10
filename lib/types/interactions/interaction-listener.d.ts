/**
 * 交互监听编排：注册 Seam A（user-questions/request）与 Seam B（approval/request）
 * 两个主机瀑布事件监听，把「归属本插件 Telegram 聊天」的 agent 交互提示转发到
 * Telegram 并从 Telegram 回收人工回答，从而让 DSH 的任何弹窗式交互都能在手机上
 * 完成（全闭环）。
 *
 * 关键事实（按参考实现 dsh-acp / dsh-client-ui-* 验证）：
 * - 注册用 `ctx.on(event, (request, next) => …)`；返回一个「认领值」即终结瀑布，
 *   调用 `next()` 则交还给下一个监听（最终是 GUI）。派发端（service.ask）用
 *   `ctx.waterfall(scopeTarget(agent, agent), …)`，插件侧不需要也不该触碰。
 * - 事件是 agent 作用域：一个未作用域注册的监听会收到所有 agent 的请求，因此必须
 *   在监听体内判断「该 agent 是否属于一个绑定到本插件 Telegram 聊天的会话」，
 *   不属于则 `next()` 放行给 GUI。
 * - 超时必须自实现（宿主没有我们看不见的默认超时）；超时后调 `next()` 交还宿主，
 *   不丢失问题（GUI 会接管展示同一提示）。
 *
 * @module interactions/interaction-listener
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionManager } from '../core/session-manager.js';
import type { Delivery } from '../telegram/delivery.js';
export interface InteractionConfig {
    /** 挂起问题等待人工应答的最长秒；超时 call next() 交还宿主。默认 300。 */
    pendingQuestionTimeoutSec?: number;
    /** 审批文本「允许」词表。 */
    approvalDecisionWords?: string[];
    /** 审批文本「拒绝」词表。 */
    rejectDecisionWords?: string[];
}
export interface InteractionOptions {
    ctx: Context;
    sessions: SessionManager;
    deliveries: ReadonlyMap<string, Delivery>;
    config: InteractionConfig;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** 一个 Telelegram 聊天在某 bot 上的归属。 */
export interface ChatTarget {
    chatId: number;
    botId: string;
}
/** 由 bot-manager 调用的入站应答钩子。返回 true 表示已作为「挂起交互的答案」消费。 */
export interface InteractionRespond {
    onCallback(data: string, chatId: number, botId: string): Promise<boolean>;
    onText(text: string, chatId: number, botId: string): Promise<boolean>;
}
/** 注册两个瀑布监听，返回入站应答钩子。 */
export declare function registerInteractions(options: InteractionOptions): InteractionRespond;
