/**
 * Command system: slash commands handled locally (never sent to the model).
 * Mirrors @loserfox/telegram's command set, extended with /stop (cancel the
 * running turn), /workspace (browse & switch working directories), and
 * /session (inspect the chat↔session binding).
 *
 * @module commands
 */

import { basename, join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import type { Delivery } from '../telegram/delivery.js'
import type { SessionManager } from '../core/session-manager.js'
import type { StateStore } from '../core/state-store.js'

export interface CommandContext {
  chatId: number
  botId: string
  /** Telegram user id of the sender (for per-user workspace roots later). */
  userId: number
  delivery: Delivery
  sessions: SessionManager
  store: StateStore
  workspaceRoots: string[]
  defaultCwd: string
}

export interface CommandResult {
  handled: boolean
  /** Command-specific reply text when the command is handled. */
  reply?: string
}

const COMMANDS = '/start /help /new /clear /stop /workspace /session'.split(' ')

/** Detect a command at the start of a message; returns the bare command name. */
export function isCommand(text: string): string | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s|$)/.exec(text)
  return match?.[1]
}

/**
 * Handle a slash command. Returns `{ handled: false }` when `text` is not a
 * command (or an unknown command, whose unknownness is reported in reply).
 */
export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const name = isCommand(text)
  if (name === undefined) return { handled: false }
  switch (name) {
    case 'start':
      return commandStart(ctx)
    case 'help':
      return commandHelp(ctx)
    case 'new':
      return commandNew(ctx)
    case 'clear':
      return commandClear(ctx)
    case 'stop':
      return commandStop(ctx)
    case 'workspace':
      return commandWorkspace(text, ctx)
    case 'session':
      return commandSession(ctx)
    default:
      return { handled: true, reply: `未知命令 /${name};支持:${COMMANDS.join(' ')}` }
  }
}

function commandStart(ctx: CommandContext): CommandResult {
  return {
    handled: true,
    reply: `🤖 dsh-telegram 已就绪。\n\n支持命令:${COMMANDS.join(' ')}\n直接发消息即可让 agent 处理。`,
  }
}

function commandHelp(ctx: CommandContext): CommandResult {
  return {
    handled: true,
    reply: [
      '📖 命令说明:',
      '/start — 显示欢迎信息',
      '/help — 本帮助',
      '/new — 开启全新会话(丢弃当前上下文)',
      '/clear — 同 /new',
      '/stop — 取消当前正在运行的回合',
      '/workspace — 查看/切换工作目录',
      '/session — 查看会话绑定状态',
      '',
      '直接发送文字消息即进入 agent 会话。',
    ].join('\n'),
  }
}

async function commandNew(ctx: CommandContext): Promise<CommandResult> {
  try {
    const hadBind = ctx.sessions.getBound(ctx.chatId, ctx.botId) !== undefined
    const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId)
    return {
      handled: true,
      reply: `✅ 已开启新会话(session=${binding.sessionId})`
        + (hadBind ? '\n(已解除本 chat 的会话绑定,后续消息进入这个全新会话)' : ''),
    }
  } catch (error) {
    return { handled: true, reply: `❌ 新建会话失败:${String(error)}` }
  }
}

const commandClear = commandNew

function commandStop(ctx: CommandContext): CommandResult {
  const cancelled = ctx.sessions.cancel(ctx.chatId, ctx.botId)
  ctx.delivery.discardLive(ctx.chatId)
  return { handled: true, reply: cancelled ? '⛔ 已发送取消请求' : 'ℹ️ 当前没有运行中的回合' }
}

async function commandWorkspace(text: string, ctx: CommandContext): Promise<CommandResult> {
  const args = text.trim().split(/\s+/).slice(1).join(' ')
  const binding = ctx.sessions.get(ctx.chatId, ctx.botId)
  const current = binding?.cwd ?? ctx.defaultCwd

  // `arg` = target path; empty lists the roots.
  const arg = args.trim()
  if (arg === '') {
    const lines: string[] = [`📁 当前工作目录:${current}`, '', '可选根目录:']
    for (const root of ctx.workspaceRoots) {
      lines.push(`• ${root}`)
    }
    lines.push('', '用法:/workspace <路径> 切换;路径可用绝对路径或相对根目录的子目录。')
    return { handled: true, reply: lines.join('\n') }
  }

  // Resolve the target against the workspace roots, then against the current
  // directory, falling back to the raw path.
  let target: string | undefined
  for (const root of ctx.workspaceRoots) {
    const candidate = join(root, arg)
    if (candidate === root || isDirectory(candidate)) {
      target = candidate
      break
    }
  }
  if (target === undefined) {
    const candidate = resolve(current, arg)
    if (isDirectory(candidate)) target = candidate
  }
  if (target === undefined) target = resolve(arg)

  if (!isDirectory(target)) {
    return { handled: true, reply: `❌ 不是有效目录:${target}` }
  }

  // Record the choice in this bot's own store. With a live session the running
  // agent keeps its cwd until /new; with no session yet, the first message (or a
  // later /new) starts in the requested directory instead of the process cwd.
  ctx.sessions.setCwd(ctx.chatId, ctx.botId, target)
  return { handled: true, reply: `📁 已记录工作目录:${target}\n使用 /new 以新目录开启会话。` }
}

function commandSession(ctx: CommandContext): CommandResult {
  // A config-bound chat shows its bound session first, then the own-session.
  const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId)
  if (bound !== undefined) {
    const live = ctx.sessions.get(ctx.chatId, ctx.botId)
    return {
      handled: true,
      reply: [
        '🔗 已绑定现有会话:',
        `• 绑定 session: ${bound.sessionId}`,
        `• 绑定方式: ${bound.botId === '' ? '任意 bot(chatId)' : `bot ${bound.botId}`}`,
        `• cwd: ${bound.cwd}`,
        `• 独立会话: ${live !== undefined ? `有(${live.sessionId})` : '无(消息直入绑定会话)'}`,
      ].join('\n'),
    }
  }
  const binding = ctx.sessions.get(ctx.chatId, ctx.botId)
  if (binding === undefined) {
    return { handled: true, reply: 'ℹ️ 尚无会话;发送消息会自动创建。' }
  }
  const persisted = ctx.store.getChat(`${ctx.botId}:${ctx.chatId}`)
  return {
    handled: true,
    reply: [
      '📄 会话状态:',
      `• session: ${binding.sessionId}`,
      `• cwd: ${binding.cwd}`,
      `• generation: ${binding.generation}`,
      `• 持久化: ${persisted !== undefined ? '是' : '否'}`,
      `• agent 状态: ${'running' /* not exposed by dsh-agent types; placeholder */}`,
    ].join('\n'),
  }
}

/** True when `path` exists and is a directory. */
function isDirectory(path: string): boolean {
  try {
    const stats = readdirSync(path, { withFileTypes: true })
    void stats
    return true
  } catch {
    return false
  }
}

/** Display name of a workspace root for listing. */
export function displayRoot(root: string): string {
  return basename(root) || root
}