/**
 * 两个交互缝的结构化类型（按宿主参考实现的类型声明逐字对齐）。
 *
 * 这些事件由宿主侧的服务派发（dsh-user-questions / dsh-user-approval），
 * 它们的类型声明不在本插件依赖树里，所以这里用最小结构类型本地声明，
 * 只声明我们用到的字段，避免把宿主新 API 硬编码成必装依赖。
 *
 * @module interactions/types
 */
/** Seam A：user-questions/request 的一个问题项。 */
export interface UserQuestionItem {
    /** 调用方给的问题 id，会原样回显在答案里。 */
    id: string;
    /** 要展示的问题正文。 */
    question: string;
    /** 与问题一起展示但不出现在选项标签里的补充信息。 */
    detail?: string;
    /** 可选短标题/分组标签。 */
    header?: string;
    /** 可选选项，UI 可渲染成菜单。 */
    options?: {
        label: string;
        description?: string;
    }[];
    /** 是否允许多选，默认单选。 */
    multiSelect?: boolean;
    /** 展示语义（如 plan-review），对协议无影响。 */
    intent?: unknown;
}
/** Seam A 请求载荷。 */
export interface UserQuestionsRequest {
    questions: UserQuestionItem[];
    /** 被暂停等待回答的 agent（宿主投影的 Agent）。 */
    agent?: {
        session?: {
            id?: unknown;
        };
    };
    signal?: AbortSignal;
}
/** Seam A 答案。 */
export interface AskUserQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
export interface AskUserQuestionAnswer {
    answers: AskUserQuestionAnswerItem[];
}
/** Seam B：approval/request 请求载荷。 */
export interface ApprovalRequest {
    agent?: {
        session?: {
            id?: unknown;
        };
    };
    /** 需要决策的工具名。 */
    toolName: string;
    /** 精确的工具调用 id（如有）。 */
    callId?: string;
    /** 请求方给出的人读说明。 */
    reason?: string;
    signal?: AbortSignal;
}
/** Seam B 唯一合法结果集（fail-closed）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/** 从 agent 抽取会话 id 的可靠方式（与 sessionIdOf 同构）。 */
export declare function agentSessionId(agent: {
    session?: {
        id?: unknown;
    };
} | undefined): string | undefined;
