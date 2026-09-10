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
export type PendingKind = 'question' | 'approval';
/** 把入站 Telegram 回复转成答案所需的元数据。 */
export interface QuestionMeta {
    token: string;
    /** 有序问题 id；每项的选项标签用于序号→标签映射。 */
    items: {
        id: string;
        options: string[];
        multiSelect: boolean;
    }[];
}
export interface ApprovalMeta {
    token: string;
    toolName: string;
    reason?: string;
}
export interface Pending {
    kind: PendingKind;
    chatId: number;
    botId: string;
    /**
     * 解析等待中的 Promise。传 `undefined` 表示「放弃/交还宿主」。
     * 由等待方（interaction-listener）在 create() 后自行覆盖以接到自己的 Promise。
     */
    resolve(value: unknown): void;
    /** 超时被触发时先回调（在 resolve(undefined) 之前）。 */
    onTimeout?(): void;
    meta?: QuestionMeta | ApprovalMeta;
    timer?: NodeJS.Timeout;
    finished?: boolean;
}
export interface PendingStoreOptions {
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
/** 进行中交互的注册表，键 = `<botId>:<chatId>`。 */
export declare class PendingStore {
    private readonly byKey;
    private readonly logger;
    constructor(options?: PendingStoreOptions);
    static key(chatId: number, botId: string, kind: PendingKind): string;
    /** (chat, bot) 上某种 kind 的进行中 Pending，若无则 undefined。 */
    active(kind: PendingKind, chatId: number, botId: string): Pending | undefined;
    /**
     * 为一个 kind 在 (chat, bot) 上占槽。若同 kind 已有进行中项则返回 undefined
     * （此时调用方应走 next() 交还宿主，保证提示不丢、答复不错乱）。
     */
    create(kind: PendingKind, chatId: number, botId: string, timeoutMs: number): Pending | undefined;
    /** 用一个具体答案值结束 pending（undefined 表示放弃/交还）。 */
    finish(pending: Pending, value: unknown): void;
    /** 当前所有进行中（未结束）的 pending 数量。 */
    get size(): number;
}
