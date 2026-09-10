/**
 * dsh-telegram deployment config. 极简:只配置一个或多个 Bot Token 即可运行。
 *
 * 多 Bot 采用「严格租户隔离」模型:每一个 Bot 是一个隔离域(BotScope)。
 * 插件级字段提供默认值,`bots[].<field>` 可以逐 Bot 覆盖;任何跨 Bot 的
 * 隐式共享(裸 chatId 绑定、同一 DSH 会话被多个 Bot 绑定)默认被拒绝,
 * 必须显式开启 `allowSharedSessions`。
 *
 * @module telegram/config
 */
import Schema from '@deepseek-ai/schemastery';
export const Config = Schema.object({
    bots: Schema.array(Schema.object({
        id: Schema.string().required(),
        token: Schema.string().required(),
        bindings: Schema.dict(Schema.string()),
        allowedUserIds: Schema.array(Schema.number()),
        allowAllUsers: Schema.boolean(),
        provider: Schema.string(),
        model: Schema.string(),
        workspaceRoots: Schema.array(Schema.string()),
        proxy: Schema.string(),
        dataDir: Schema.string(),
        allowHostSessions: Schema.boolean(),
        allowOpsRestart: Schema.boolean(),
        allowSharedSessions: Schema.boolean(),
    })).default([]),
    token: Schema.string(),
    allowedUserIds: Schema.array(Schema.number()).default([]),
    allowAllUsers: Schema.boolean().default(false),
    provider: Schema.string(),
    model: Schema.string(),
    maxMessageLength: Schema.number().default(4096),
    pollingTimeoutSec: Schema.number().default(30),
    notifyEnd: Schema.boolean().default(true),
    workspaceRoots: Schema.array(Schema.string()),
    dataDir: Schema.string(),
    proxy: Schema.string(),
    keepAlive: Schema.boolean().default(true),
    bindings: Schema.dict(Schema.string()),
    allowHostSessions: Schema.boolean().default(false),
    allowOpsRestart: Schema.boolean(),
    allowSharedSessions: Schema.boolean().default(false),
});
