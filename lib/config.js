/**
 * dsh-telegram deployment config. 极简:只配置一个或多个 Bot Token 即可运行。
 * @module telegram/config
 */
import Schema from '@deepseek-ai/schemastery';
export const Config = Schema.object({
    bots: Schema.array(Schema.object({
        id: Schema.string().required(),
        token: Schema.string().required(),
    })).default([]),
    token: Schema.string(),
    allowedUserIds: Schema.array(Schema.number()).default([]),
    allowAllUsers: Schema.boolean().default(false),
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-v4-flash'),
    maxMessageLength: Schema.number().default(4096),
    pollingTimeoutSec: Schema.number().default(30),
    workspaceRoots: Schema.array(Schema.string()),
    dataDir: Schema.string(),
    keepAlive: Schema.boolean().default(true),
});
