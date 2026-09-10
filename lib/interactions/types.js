/**
 * 两个交互缝的结构化类型（按宿主参考实现的类型声明逐字对齐）。
 *
 * 这些事件由宿主侧的服务派发（dsh-user-questions / dsh-user-approval），
 * 它们的类型声明不在本插件依赖树里，所以这里用最小结构类型本地声明，
 * 只声明我们用到的字段，避免把宿主新 API 硬编码成必装依赖。
 *
 * @module interactions/types
 */
/** 从 agent 抽取会话 id 的可靠方式（与 sessionIdOf 同构）。 */
export function agentSessionId(agent) {
    const id = agent?.session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
