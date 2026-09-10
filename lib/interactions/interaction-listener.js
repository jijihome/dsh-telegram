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
import { PendingStore } from './pending-store.js';
import { answerFromCallback, answerFromText, completeQuestion, newQuestionToken, questionMetaOf, renderQuestions, } from './telegram-questions.js';
import { answerApprovalFromCallback, answerApprovalFromText, approvalMetaOf, newApprovalToken, renderApproval, } from './telegram-approval.js';
import { agentSessionId } from './types.js';
/** 解析 agent → Telegram 聊天归属；无归属返回 undefined。 */
function resolveChatTarget(sessions, agent) {
    const sid = agentSessionId(agent);
    if (sid === undefined)
        return undefined;
    const active = sessions.bySessionId(sid);
    if (active !== undefined)
        return { chatId: active.chatId, botId: active.botId };
    const bound = sessions.byBoundSessionIds(sid)[0];
    if (bound !== undefined)
        return { chatId: bound.chatId, botId: bound.botId };
    return undefined;
}
/** 注册两个瀑布监听，返回入站应答钩子。 */
export function registerInteractions(options) {
    const { ctx, sessions, deliveries, config, logger } = options;
    const store = new PendingStore({ logger });
    const timeoutMs = (config.pendingQuestionTimeoutSec ?? 300) * 1000;
    const words = {
        approve: [...(config.approvalDecisionWords ?? ['批准', '同意', 'yes'])],
        reject: [...(config.rejectDecisionWords ?? ['拒绝', '不同意', 'no'])],
    };
    // 事件类型声明在宿主侧包（不在本插件依赖树），这里用宽松签名注册。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onHostEvent = (name, listener) => ctx.on(name, listener);
    // ---- Seam A：user-questions/request ----
    onHostEvent('user-questions/request', async (request0, next) => {
        const request = request0;
        const target = resolveChatTarget(sessions, request.agent);
        if (target === undefined)
            return next();
        const delivery = deliveries.get(target.botId);
        if (delivery === undefined)
            return next();
        const token = newQuestionToken();
        const pending = store.create('question', target.chatId, target.botId, timeoutMs);
        if (pending === undefined)
            return next(); // 该聊天已有问题在等 → 交还宿主
        const answer = await new Promise(resolveWait => {
            const onAbort = () => store.finish(pending, undefined);
            request.signal?.addEventListener('abort', onAbort, { once: true });
            pending.resolve = value => {
                request.signal?.removeEventListener('abort', onAbort);
                resolveWait(value);
            };
            pending.onTimeout = () => {
                void delivery.sendFinal(target.chatId, '⏳ 该选择等待超时，已交还宿主处理');
            };
            try {
                const { text, keyboard } = renderQuestions(request.questions, token);
                pending.meta = questionMetaOf(request.questions, token);
                void delivery.sendMenu(target.chatId, text, keyboard).catch(() => {
                    store.finish(pending, undefined);
                });
            }
            catch (error) {
                // 渲染/发送同步异常不得让瀑布停摆：放弃等待并交还宿主。
                store.finish(pending, undefined);
            }
        });
        if (answer === undefined)
            return next();
        return answer;
    });
    // ---- Seam B：approval/request ----
    onHostEvent('approval/request', async (request0, next) => {
        const request = request0;
        const target = resolveChatTarget(sessions, request.agent);
        if (target === undefined)
            return next();
        const delivery = deliveries.get(target.botId);
        if (delivery === undefined)
            return next();
        const token = newApprovalToken();
        const pending = store.create('approval', target.chatId, target.botId, timeoutMs);
        if (pending === undefined)
            return next(); // 该聊天已有审批在等 → 交还宿主
        const outcome = await new Promise(resolveWait => {
            const onAbort = () => store.finish(pending, undefined);
            request.signal?.addEventListener('abort', onAbort, { once: true });
            pending.resolve = value => {
                request.signal?.removeEventListener('abort', onAbort);
                resolveWait(value);
            };
            pending.onTimeout = () => {
                void delivery.sendFinal(target.chatId, '⏳ 该审批等待超时，已交还宿主处理');
            };
            try {
                const { text, keyboard } = renderApproval(request.toolName, request.reason, token, words);
                pending.meta = approvalMetaOf(token, request.toolName, request.reason);
                void delivery.sendMenu(target.chatId, text, keyboard).catch(() => {
                    store.finish(pending, undefined);
                });
            }
            catch (error) {
                // 渲染/发送同步异常不得让瀑布停摆：放弃等待并交还宿主。
                store.finish(pending, undefined);
            }
        });
        if (outcome === undefined)
            return next();
        return outcome;
    });
    // ---- 入站应答：由 bot-manager 在回调/文本处调用 ----
    return {
        /** 处理内联键盘回调；true=已被当作某一挂起交互的答案消费。 */
        async onCallback(data, chatId, botId) {
            const question = store.active('question', chatId, botId);
            if (question !== undefined && answerFromCallback(question, data)) {
                const value = completeQuestion(question);
                if (value !== undefined)
                    store.finish(question, value);
                return true;
            }
            const approval = store.active('approval', chatId, botId);
            if (approval !== undefined) {
                const r = answerApprovalFromCallback(approval, data);
                if (r.consumed) {
                    store.finish(approval, r.outcome);
                    return true;
                }
            }
            return false;
        },
        /** 处理一条文本回复；true=已被当作某一挂起交互的答案消费。 */
        async onText(text, chatId, botId) {
            const approval = store.active('approval', chatId, botId);
            if (approval !== undefined) {
                const r = answerApprovalFromText(approval, text, words);
                if (r.consumed) {
                    store.finish(approval, r.outcome);
                    return true;
                }
            }
            const question = store.active('question', chatId, botId);
            if (question !== undefined) {
                const r = answerFromText(question, text);
                if (r.consumed) {
                    if (r.value !== undefined)
                        store.finish(question, r.value);
                    return true;
                }
            }
            return false;
        },
    };
}
