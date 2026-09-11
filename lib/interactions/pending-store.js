/**
 * 挂起交互存储：每个 (chat, bot, kind) 同时最多一个在等的交互提示（问题或审批）。
 *
 * 当 DSH agent 在某一条交互缝（user-questions/request、approval/request）上停下
 * 等人回答时，dsh-telegram 把提示推给 Telegram 并在这里登记一条 Pending，这样
 * 入站的 Telegram 答复（行内键盘回调或纯文本）能路由回正确的等待 Promise。
 * 按 (chat, bot) 占一个槽位并配超时，避免同一 agent 的多个提示互相覆盖、
 * 也避免「无人在 Telegram 回答」时 agent 被永久卡死。
 *
 * @module interactions/pending-store
 */
/** 进行中交互的注册表，键 = `<botId>:<chatId>`。 */
export class PendingStore {
    byKey = new Map();
    logger;
    constructor(options = {}) {
        this.logger = options.logger;
    }
    static key(chatId, botId, kind) {
        return `${botId}:${chatId}:${kind}`;
    }
    /** (chat, bot) 上某种 kind 的进行中 Pending，若无则 undefined。 */
    active(kind, chatId, botId) {
        const pending = this.byKey.get(PendingStore.key(chatId, botId, kind));
        return pending !== undefined && pending.kind === kind ? pending : undefined;
    }
    /**
     * 为一个 kind 在 (chat, bot) 上占槽。若同 kind 已有进行中项则返回 undefined
     * （此时调用方应走 next() 交还宿主，保证提示不丢、答复不错乱）。
     */
    create(kind, chatId, botId, timeoutMs) {
        const key = PendingStore.key(chatId, botId, kind);
        if (this.byKey.has(key))
            return undefined;
        const pending = { kind, chatId, botId, resolve: () => { } };
        this.byKey.set(key, pending);
        pending.timer = setTimeout(() => {
            if (pending.finished)
                return;
            this.logger?.warn(`[tg] 交互 ${kind} chat=${chatId}/${botId} 等待超时(${timeoutMs}ms),交还宿主`);
            this.byKey.delete(key);
            pending.finished = true;
            try {
                pending.onTimeout?.();
            }
            catch { /* 超时清理不得抛 */ }
            pending.resolve(undefined);
        }, timeoutMs);
        // unref: 超时定时器不得拽住进程事件循环（测试进程/宿主关停时能立即退出）。
        pending.timer.unref?.();
        return pending;
    }
    /** 用一个具体答案值结束 pending（undefined 表示放弃/交还）。 */
    finish(pending, value) {
        if (pending.finished)
            return;
        pending.finished = true;
        if (pending.timer !== undefined)
            clearTimeout(pending.timer);
        const key = PendingStore.key(pending.chatId, pending.botId, pending.kind);
        if (this.byKey.get(key) === pending) {
            this.byKey.delete(key);
        }
        pending.onTimeout = undefined;
        try {
            pending.resolve(value);
        }
        catch { /* 忽略 */ }
    }
    /** 当前所有进行中（未结束）的 pending 数量。 */
    get size() {
        return this.byKey.size;
    }
}
