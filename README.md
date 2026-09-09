# dsh-telegram

Telegram 桥接插件,让 DeepSeek Harness (dsh) 的 agent 通过 Telegram 使用。配置 Bot Token 即可用:多 Bot 长轮询、会话过程实时流式转发、工作区切换、会话管理命令。

> 代码基于 [@loserfox/telegram](https://github.com/LoserFox/telegram) (BSD-3-Clause) 改造:单 Bot 泛化为多 Bot 数组、流式增量(原版只有最终消息)、命令系统扩展 (/stop /workspace /session)、会话绑定持久化(重启恢复)。

## 功能

- **多 Bot 长轮询**:`bots: [{ id, token }]`,每个 Bot 独立连接、独立故障隔离(一个 Bot 挂掉不影响其他)
- **完整会话过程实时转发**(任务书核心要求):
  - 文本增量:`assistant/chunk` → `text-delta` 实时编辑同一条消息
  - 推理增量:`reasoning-delta` 流入同一条消息
  - 工具调用:`tool-call-delta` 显示工具名 + 参数增量
  - 最终消息、运行/完成状态、取消、错误
- **会话中断捕获**:不再把 `turn/end` 一律当「完成」——按 `reason` 区分并通知 bot:`⛔ 已取消(用户/父级/钩子/释放)`、`❌ 错误(带 message/code)`、`🔒 已阻塞`、`⏳ 输出 token 超限`、`⚠️ 会话中断(崩溃/遗留)`;`agent/error`(无回合内位置)也会转发;同一回合 `agent/error` + `turn/end(error)` 去重只通知一次
- **每 chat 独立 agent 会话**:session id = `telegram:<botId>:<chatId>`,`/new` 轮换新会话
- **命令系统**:`/start` `/help` `/new` `/clear` `/stop` `/workspace` `/session`
- **持久化**:chat↔session 绑定、工作目录、长轮询 offset 存 `<cwd>/data/state.json`,重启后自动恢复(会话经 `ctx.agents.resume` 续接,offset 不重复拉取)
- **白名单**:默认拒绝所有用户,`allowedUserIds` 放行,`allowAllUsers: true` 放行一切(仅开发)
- **fail loud**:无 Token 直接启动报错;fail closed:白名单为空拒绝所有人

## 安装

```bash
# 本地目录安装(注意:Windows 下路径不能含空格)
dsh plugin --profile <name> add <dir|git-url>

# 验证组合层
dsh --profile <name> --dump-config | grep telegram
```

安装后需重启目标 profile 的 DSH 进程(组合层变更不参与 HMR)。卸载:`dsh plugin --profile <name> remove telegram`。

## 配置

在 profile 的 `cordis.yml`(用户层)里写:

```yaml
# 单 Bot(极简)
- id: telegram
  token: '123456:ABC-DEF...'
  allowAllUsers: true

# 或多 Bot
- id: telegram
  bots:
    - id: bot-a
      token: 'AAA...'
      bindings:            # 可选:该 bot 的 chat ↔ 已经存在的 DSH 会话
        '123456789': 'session-<uuid>'
    - id: bot-b
      token: 'BBB...'
      bindings:
        '123456789': 'session-<uuid>'
  allowedUserIds: [123456789]   # 只允许这些 Telegram user id
```

> `bindings` 把某个 Telegram chat 绑定到一个**已经存在的** DSH 会话(比如 GUI 会话 `session-<uuid>`),实现双向:bot 消息直入该会话、会话出站实时推回 bot。多 bot 时把 chat 直接写在各 bot 的 `bindings` 下(键 = chatId,省略 bot 前缀);旧的顶层 `bindings`(`botId:chatId` 复合键/裸 chatId)仍兼容。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `bots` | `[]` | Bot 数组;`[{ id, token, bindings? }]` |
| `token` | - | 单 Bot 简写;与 `bots` 二选一 |
| `allowedUserIds` | `[]` | 允许的 Telegram 用户 id;空 = 拒绝所有人 |
| `allowAllUsers` | `false` | 放行所有用户(仅开发) |
| `provider` | `deepseek-official` | LLM provider id |
| `model` | `deepseek-v4-flash` | 模型 id |
| `maxMessageLength` | `4096` | 消息长度上限 |
| `pollingTimeoutSec` | `30` | 长轮询超时(秒) |
| `workspaceRoots` | `[cwd]` | /workspace 可浏览的根目录 |
| `dataDir` | `<cwd>/data` | 持久化目录 |
| `bots[].bindings` | - | 该 bot 的 chatId → 已存在 DSH 会话(双向绑定) |

## 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎信息 |
| `/help` | 帮助 |
| `/new` `/clear` | 开启全新会话(丢弃上下文) |
| `/stop` | 取消当前运行回合 |
| `/workspace` | 查看/切换工作目录 |
| `/session` | 查看会话绑定与状态 |

## 架构

```
src/
├── index.ts                # apply 入口、inject=['agents']、生命周期(ctx.effect)
├── config.ts               # Schemastery 配置 schema
├── telegram/
│   ├── api.ts              # Telegram Bot API 客户端(getMe/getUpdates/sendMessage/editMessageText/sendChatAction)
│   ├── long-poll.ts        # 单 Bot 长轮询(offset 游标、退避重连)
│   ├── delivery.ts         # 分片投递 + 增量编辑(流式核心)+ typing
│   └── bot-manager.ts      # 多 Bot 生命周期、授权、命令路由
├── harness/
│   ├── agent-factory.ts    # ctx.agents.create/resume 封装
│   └── stream-listener.ts  # session/event 订阅 → normalizer → delivery
├── core/
│   ├── event-normalizer.ts # DSH 事件 → 统一消息流(文本/推理/工具/状态)
│   ├── renderer.ts         # 消息流 → Telegram 显示文本
│   ├── state-store.ts      # chat↔session/offset 持久化(JSON)
│   ├── session-manager.ts  # per-chat 会话获取/轮换/取消/resume
│   └── format.ts           # escapeHtml / markdown→HTML / 4096 分片
└── commands/
    └── index.ts            # /start /help /new /clear /stop /workspace /session
```

### 事件流(实测 dsh 0.1.2-rc.1)

插件订阅全局 `session/event`,事件带 `session.id`;只处理属于本插件创建的 session。增量来源是 `assistant/chunk` 事件(`data.chunk` = StreamChunk:`text-delta` / `reasoning-delta` / `tool-call-delta`)。注意 `agent/assistant-stream` 在 headless profile 不触发(实测),因此不依赖它。

回合结束状态取自 `turn/end` 的 `reason` 字段(`completed / aborted / blocked / error / max-tokens / interrupted`);`assistant/message` 带 `interrupted: true` 表示中途中止的部分结果;`agent/error` 作为「无回合内位置错误」的兜底,与 `turn/end(error)` 通过会话内回合号去重,避免同一回合重复通知。

## 开发

```bash
# 类型解析(Windows):node_modules junction 指向 dsh 安装目录
# 编译
tsc -p tsconfig.json
# 安装到测试 profile(路径无空格)
dsh plugin --profile headless add E:\dsh-telegram-dist
```

## License

BSD-3-Clause。派生自 [@loserfox/telegram](https://github.com/LoserFox/telegram)(BSD-3-Clause)。
