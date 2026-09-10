# dsh-telegram

Telegram 桥接插件,让 DeepSeek Harness (dsh) 的 agent 通过 Telegram 使用。配置 Bot Token 即可用:多 Bot 长轮询、会话过程实时流式转发、工作区切换、会话管理命令。

> 代码基于 [@loserfox/telegram](https://github.com/LoserFox/telegram) (BSD-3-Clause) 改造:单 Bot 泛化为多 Bot 数组、流式增量(原版只有最终消息)、命令系统扩展 (/stop /workspace /session)、会话绑定持久化(重启恢复)。

## 功能

- **多 Bot 长轮询 + 严格租户隔离**:`bots: [{ id, token }]`,每个 Bot 独立连接、独立故障隔离(一个 Bot 挂掉不影响其他),并且拥有**独立的授权/模型/工作区/代理/数据目录/日志**隔离域(见「多 Bot 隔离」一节)
- **完整会话过程实时转发**(任务书核心要求):
  - 文本增量:`assistant/chunk` → `text-delta` 实时编辑同一条消息
  - 推理增量:`reasoning-delta` 流入同一条消息
  - 工具调用:`tool-call-delta` 显示工具名 + 参数增量
  - 最终消息、运行/完成状态、取消、错误
- **会话中断捕获**:不再把 `turn/end` 一律当「完成」——按 `reason` 区分并通知 bot:`⛔ 已取消(用户/父级/钩子/释放)`、`❌ 错误(带 message/code)`、`🔒 已阻塞`、`⏳ 输出 token 超限`、`⚠️ 会话中断(崩溃/遗留)`;`agent/error`(无回合内位置)也会转发;同一回合 `agent/error` + `turn/end(error)` 去重只通知一次
- **每 chat 独立 agent 会话**:session id = `telegram:<botId>:<chatId>`,`/new` 轮换新会话
- **运维菜单**(`/menu` → ⚙️ 运维):**🔄 重启 DSH**、💻 系统信息。重启通过脱离宿主的代理进程 kill 宿主 DSH 再用原命令重建(宿主进程不在 pm2 下也能恢复);**仅白名单用户可用**(`allowedUserIds` / `allowAllUsers`)
- **命令系统**:`/start` `/help` `/new` `/clear` `/stop` `/workspace` `/session`
- **持久化**:chat↔session 绑定、工作目录、长轮询 offset、per-chat 模型存 `<dataDir>/bots/<botId>/state.json`(**每个 Bot 一个文件**),重启后自动恢复(会话经 `ctx.agents.resume` 续接,offset 不重复拉取);旧版共享 `state.json` 首次启动自动按 Bot 拆分并保留备份
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
| `bots` | `[]` | Bot 数组;`[{ id, token, ...per-bot 覆盖 }]` |
| `token` | - | 单 Bot 简写;与 `bots` 二选一 |
| `allowedUserIds` | `[]` | 允许的 Telegram 用户 id;空 = 拒绝所有人 |
| `allowAllUsers` | `false` | 放行所有用户(仅开发) |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | 各 Bot 的默认 LLM 选择 |
| `maxMessageLength` | `4096` | 消息长度上限 |
| `pollingTimeoutSec` | `30` | 长轮询超时(秒) |
| `workspaceRoots` | `[cwd]` | /workspace 可浏览的根目录 |
| `dataDir` | `<DSH_HOME>/plugin-data/dsh-telegram` | 每 Bot 状态根目录(实际写入 `<dataDir>/bots/<botId>/`) |
| `allowHostSessions` | `false` | 是否允许各 Bot 枚举/附加宿主的全部会话与工作区 |
| `allowOpsRestart` | 单 Bot 时 `true` | 是否允许「重启 DSH」(会停掉所有 Bot) |
| `allowSharedSessions` | `false` | 是否允许同一 DSH 会话被多个 Bot 绑定 |
| `bots[].bindings` | - | 该 bot 的 chatId → 已存在 DSH 会话(双向绑定) |
| `bots[].allowedUserIds` / `allowAllUsers` | 继承插件级 | 该 Bot 独立的授权名单 |
| `bots[].provider` / `model` | 继承插件级 | 该 Bot 独立的默认模型 |
| `bots[].workspaceRoots` / `proxy` / `dataDir` | 继承插件级 | 该 Bot 独立的工作区根、代理、状态目录 |
| `bots[].allowHostSessions` / `allowOpsRestart` / `allowSharedSessions` | 继承插件级 | 该 Bot 独立的可见性与运维权限 |

## 多 Bot 隔离

每个 Bot 是一个**隔离域(BotScope)**:授权名单、默认模型、工作区根、代理、状态目录、forward 日志、宿主会话可见性、运维权限全部按 Bot 解析,下游不再读取共享配置。

| 隔离面 | 行为 |
| --- | --- |
| 身份 | `botId` 必须唯一且不含 `:`;`token` 必须唯一(共用 token 会互抢 getUpdates)。违反则**启动即失败**,不做 last-wins 覆盖 |
| 模型 | 菜单切换写入 `botId:chatId` 的 per-chat 状态并热切换该路由的 agent;**从不读写宿主全局 `agentDefaultModel`**,因此不影响其他 Bot 与 GUI |
| 会话归属 | 一个 DSH 会话只能属于一个「Bot+chat」路由;重复绑定直接报错(除非相关 Bot 都设 `allowSharedSessions: true`) |
| 出站路由 | 事件按 sessionId 反查唯一路由;非本插件会话 O(1) 丢弃,不存在跨 Bot 扇出 |
| 入站绑定 | 裸 `chatId` 绑定仅在**单 Bot** 下可用;多 Bot 下写裸键会启动失败(必须写 `<botId>:<chatId>`) |
| `/new` | 一定新建全新 session(不 resume 旧会话),并解除该 chat 的配置绑定 |
| 状态 | 每 Bot 一个 `state.json`,store 带跨 Bot 键守卫(越界即抛错);forward 日志在各自目录 |
| 可见性 | 会话/工作区菜单默认只显示本 Bot 拥有的会话;要看到宿主全部会话需显式 `allowHostSessions: true` |
| 运维 | 「重启 DSH」默认仅单 Bot 可用;多 Bot 下需给该 Bot 显式 `allowOpsRestart: true`(重启会停掉所有 Bot) |
| 故障 | 仍共享一个宿主进程:Bot 连接与投递已隔离,但宿主崩溃/OOM/事件循环阻塞仍是共同风险。需要硬隔离请让每个 Bot 跑独立 `DSH_HOME`/profile |

**升级迁移**:首次启动会自动把旧的共享 `<dataDir>/state.json` 按 Bot 拆分到 `bots/<botId>/state.json`,原文件保留为 `state.json.migrated-<时间戳>` 并另存 `.backup-<时间戳>`;若旧文件里存在裸 `chatId` 键而配置了多个 Bot,启动会失败并列出这些键,需手工改写为 `<botId>:<chatId>`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 欢迎信息 |
| `/help` | 帮助 |
| `/new` `/clear` | 开启全新会话(丢弃上下文) |
| `/stop` | 取消当前运行回合 |
| `/workspace` | 查看/切换工作目录 |
| `/session` | 查看会话绑定与状态 |
| `/menu` | 打开内联键盘菜单(含运维子菜单) |

菜单 / 运维:
| 项 | 说明 |
| --- | --- |
| 🔄 重启 DSH | 重启宿主 dsh 进程。spawn 一个 detached 重启代理,等 3 秒(让确认消息送达)后 kill 宿主 PID 并以原启动命令重建。**仅白名单用户可用** |
| 💻 系统信息 | 显示宿主进程 PID / Node 版本 / 启动命令 / 工作目录 |

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
│   ├── state-store.ts      # per-bot 状态持久化(独立文件 + 跨 Bot 键守卫 + 旧数据迁移)
│   ├── bot-scope.ts        # BotScope:每 Bot 隔离域解析与唯一性校验(fail loud)
│   ├── host.ts            # 宿主进程信息 + 重启调度(spawn detached agent)
│   ├── host-agent.ts      # 脱离宿主的重启代理:kill 宿主→重建(纯入口,不被 import)
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
