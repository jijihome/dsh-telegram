/**
 * Menu module: Telegram inline-keyboard menus for chat controls. A menu button
 * press emits a `callback_query` whose `data` encodes the action; that action
 * either shows a submenu (with a back button) or performs a chat operation.
 *
 * @module telegram/menu
 */

import type { Delivery } from './delivery.js'
import type { SessionManager } from '../core/session-manager.js'
import type { StateStore, ChatState } from '../core/state-store.js'
import type { TelegramInlineKeyboard } from './api.js'

/** Capabilities a menu action needs (injected from the plugin entry point). */
export interface MenuCtx {
  chatId: number
  botId: string
  delivery: Delivery
  sessions: SessionManager
  store: StateStore
  workspaceRoots: string[]
  defaultCwd: string
  provider: string
  model: string
  /** The Telegram user id pressing the button (for ops authorization). */
  userId: number
  /** Whether the current user is allowed to run ops (restart dsh). */
  canOperate: boolean
  getCurrentModel(): { provider: string; model: string }
  listModels(): Promise<Array<{ provider: string; model: string }>>
  setModel(provider: string, model: string): Promise<void>
  listPresets(): Promise<Array<{ id: string; name: string }>>
  setPreset(id: string): Promise<void>
  listWorkspaces(): Promise<string[]>
  listSessions(): Promise<Array<{ id: string; cwd?: string; title?: string }>>
  /** Return a host-process snapshot for the ops info panel. */
  getHostInfo(): string
  /** Schedule a host dsh restart; returns a user-facing confirmation text. */
  restartDsh(): string
}

/** Result of handling one menu callback: text + optional follow-up keyboard. */
export interface MenuResult {
  text: string
  keyboard?: TelegramInlineKeyboard
}

/** Build an inline keyboard from row tuples [text, callbackData]. */
function keyboard(rows: Array<Array<[string, string]>>): TelegramInlineKeyboard {
  return {
    inline_keyboard: rows.map(row => row.map(([text, data]) => ({ text, callback_data: data }))),
  }
}

const BACK = 'menu:back'

/** Ops callback data (namespaced under `menu:ops:*`). */
const OPS = 'menu:ops'
const OPS_RESTART = 'menu:ops:restart'
const OPS_INFO = 'menu:ops:info'

/** Main menu text: status summary (when ctx is given), no menu-title banner. */
export function mainMenuText(ctx?: MenuCtx): string {
  if (ctx === undefined) return '选择功能:'
  return statusText(ctx)
}

/** Main menu keyboard (rows). */
export function mainMenuKeyboard(): TelegramInlineKeyboard {
  return keyboard([
    [['🆕 新建会话', 'menu:new'], ['🗑 清除会话', 'menu:clear']],
    [['📂 工作目录', 'menu:workspace'], ['🔗 绑定会话', 'menu:bind']],
    [['🤖 切换模型', 'menu:model'], ['🧭 工作方式', 'menu:preset']],
    [['🗒 会话记录', 'menu:history']],
    [['⚙️ 运维', OPS]],
  ])
}

/** Build a submenu frame with a Back row appended. */
function withBack(rows: Array<Array<[string, string]>>): TelegramInlineKeyboard {
  return keyboard([...rows, [['🔙 返回上级', BACK]]])
}

/** Ops submenu keyboard (system info + restart dsh) with a Back row. */
function opsMenuKeyboard(): TelegramInlineKeyboard {
  return withBack([
    [['🔄 重启 DSH', OPS_RESTART]],
    [['💻 系统信息', OPS_INFO]],
  ])
}

/** Handle one callback `data`. Returns the text + keyboard to send/show. */
export async function handleMenuCallback(data: string, ctx: MenuCtx): Promise<MenuResult> {
  switch (data) {
    case 'menu:new':
      return doNew(ctx)
    case 'menu:clear':
      return doClear(ctx)
    case 'menu:workspace':
      return doWorkspace(ctx)
    case 'menu:model':
      return doModel(ctx)
    case 'menu:preset':
      return doPreset(ctx)
    case 'menu:bind':
      return doBind(ctx)
    case 'menu:history':
      return doHistory(ctx)
    case OPS:
      return doOps(ctx)
    case OPS_RESTART:
      return doRestartDsh(ctx)
    case OPS_INFO:
      return doOpsInfo(ctx)
    case BACK:
      return { text: mainMenuText(ctx), keyboard: mainMenuKeyboard() }
    default:
      // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>
      // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>, session:<id>
      if (data.startsWith('workspace:')) return doWorkspacePick(data, ctx)
      if (data.startsWith('model:')) return doModelPick(data, ctx)
      if (data.startsWith('preset:')) return doPresetPick(data, ctx)
      if (data.startsWith('session:')) return doSessionPick(data, ctx)
      return { text: '未知菜单项', keyboard: mainMenuKeyboard() }
  }
}

/** New (rotate to a fresh session). */
async function doNew(ctx: MenuCtx): Promise<MenuResult> {
  const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId)
  return {
    text: `✅ 已开启新会话\n• session: ${binding.sessionId}`,
    keyboard: mainMenuKeyboard(),
  }
}

/** Clear (rotate a fresh session, same as new for now). */
async function doClear(ctx: MenuCtx): Promise<MenuResult> {
  const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId)
  return {
    text: `🧹 已清除会话，开启新会话\n• session: ${binding.sessionId}`,
    keyboard: mainMenuKeyboard(),
  }
}

/** Status summary text: session / cwd / model / binding (shown at menu top). */
function statusText(ctx: MenuCtx): string {
  const own = ctx.sessions.get(ctx.chatId, ctx.botId)
  const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId)
  const model = ctx.getCurrentModel()
  // Selected work mode (preset) is persisted on the chat state by setPreset.
  const persisted = ctx.store.getChat(`${ctx.botId}:${ctx.chatId}`) as
    (ChatState & { agentPreset?: string }) | undefined
  const cwd = own?.cwd ?? bound?.cwd ?? persisted?.cwd ?? ctx.defaultCwd
  const workMode = persisted?.agentPreset ?? '默认'
  const lines = [
    '📊 当前状态:',
  ]
  if (bound !== undefined) {
    lines.push(`• 🔗 绑定会话: ${bound.sessionId}`)
    lines.push(`• 绑定方式: ${bound.botId === '' ? '任意 bot' : `bot ${bound.botId}`}`)
  } else if (own !== undefined) {
    lines.push(`• session: ${own.sessionId}`)
  } else {
    lines.push('• 尚未创建会话(发消息即建)')
  }
  lines.push(`• 工作目录: ${cwd}`)
  lines.push(`• 工作方式: ${workMode}`)
  lines.push(`• 模型: ${model.provider}/${model.model}`)
  return lines.join('\n')
}

/** Workspace submenu: list all known working directories. */
async function doWorkspace(ctx: MenuCtx): Promise<MenuResult> {
  let roots: string[]
  try {
    roots = await ctx.listWorkspaces()
  } catch {
    roots = ctx.workspaceRoots
  }
  if (roots.length === 0) roots = [ctx.defaultCwd]
  const rows: Array<Array<[string, string]>> = []
  for (const root of roots.slice(0, 15)) {
    const label = root === ctx.defaultCwd ? `${root} (当前)` : root
    rows.push([[`🗂 ${label}`, `workspace:${label}`]])
  }
  return {
    text: `📂 选择工作目录(当前 ${ctx.defaultCwd}):`,
    keyboard: withBack(rows),
  }
}

/** Session history submenu: list sessions (optionally switch by picking). */
async function doHistory(ctx: MenuCtx): Promise<MenuResult> {
  let list: Array<{ id: string; cwd?: string; title?: string }>
  try {
    list = await ctx.listSessions()
  } catch {
    list = []
  }
  if (list.length === 0) {
    return { text: '🗒 暂无会话记录', keyboard: mainMenuKeyboard() }
  }
  const rows: Array<Array<[string, string]>> = list.slice(0, 15).map(s => {
    const label = s.title || s.id.slice(0, 12)
    return [[`💬 ${label}`, `session:${s.id}`]]
  })
  return {
    text: `🗒 会话记录(${list.length} 个;点选以该会话继续):`,
    keyboard: withBack(rows),
  }
}

/** Model submenu: dynamic list of available models. */
async function doModel(ctx: MenuCtx): Promise<MenuResult> {
  const current = ctx.getCurrentModel()
  let models: Array<{ provider: string; model: string }>
  try {
    models = await ctx.listModels()
  } catch {
    models = [{ provider: ctx.provider, model: ctx.model }]
  }
  const rows: Array<Array<[string, string]>> = []
  for (const m of models.slice(0, 15)) {
    const sel = m.provider === current.provider && m.model === current.model
    rows.push([[
      `${sel ? '✔ ' : ''}${m.model}`,
      `model:${m.provider}:${m.model}`,
    ]])
  }
  return {
    text: `🤖 选择模型(当前 ${current.model}):`,
    keyboard: withBack(rows),
  }
}

/** Preset (work mode) submenu: list available presets. */
async function doPreset(ctx: MenuCtx): Promise<MenuResult> {
  let presets: Array<{ id: string; name: string }>
  try {
    presets = await ctx.listPresets()
  } catch {
    presets = []
  }
  if (presets.length === 0) {
    return { text: '🧭 暂无预设列表', keyboard: mainMenuKeyboard() }
  }
  const rows: Array<Array<[string, string]>> = presets.map(p => [[p.name, `preset:${p.id}`]])
  return {
    text: '🧭 切换工作方式(预设);将新开会话生效:',
    keyboard: withBack(rows),
  }
}

/** Bind session submenu (placeholder for now; a fuller picker comes later). */
function doBind(ctx: MenuCtx): MenuResult {
  const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId)
  const text = bound !== undefined
    ? `🔗 当前绑定: ${bound.sessionId}`
    : '🔗 未绑定会话(由配置 bindings 决定;更完整的绑定选择器后续加入)'
  return { text, keyboard: mainMenuKeyboard() }
}

/** Apply a picked workspace root. */
function doWorkspacePick(data: string, ctx: MenuCtx): MenuResult {
  const target = data.slice('workspace:'.length)
  // Record the picked cwd for the next /new; the live session keeps its own cwd.
  ctx.store.setChat(`${ctx.botId}:${ctx.chatId}`, { cwd: target } as never)
  return {
    text: `📁 已记录工作目录:${target}\n使用"新建会话"以新目录开启。`,
    keyboard: mainMenuKeyboard(),
  }
}

/** Apply a picked model: switch the default model selection. */
async function doModelPick(data: string, ctx: MenuCtx): Promise<MenuResult> {
  const rest = data.slice('model:'.length)
  const sep = rest.indexOf(':')
  const provider = sep >= 0 ? rest.slice(0, sep) : ctx.provider
  const model = sep >= 0 ? rest.slice(sep + 1) : rest
  try {
    await ctx.setModel(provider, model)
    return { text: `✅ 已切换到模型: ${model}`, keyboard: mainMenuKeyboard() }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { text: `❌ 切换模型失败: ${msg}`, keyboard: mainMenuKeyboard() }
  }
}

/** Apply a picked preset (work mode): note that a fresh session is needed. */
async function doPresetPick(data: string, ctx: MenuCtx): Promise<MenuResult> {
  const id = data.slice('preset:'.length)
  try {
    await ctx.setPreset(id)
    return { text: `✅ 已切换工作方式: ${id}\n新建会话(清除会话)后生效。`, keyboard: mainMenuKeyboard() }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { text: `❌ 切换工作方式失败: ${msg}`, keyboard: mainMenuKeyboard() }
  }
}

/** A picked session from the history list: show how to engage it. */
function doSessionPick(data: string, ctx: MenuCtx): MenuResult {
  const id = data.slice('session:'.length)
  return {
    text: `🗒 选中会话: ${id}\n直接下发节消息即可进入该会话;绑定切换用「绑定会话」。`,
    keyboard: mainMenuKeyboard(),
  }
}

/** Ops submenu: system info + restart dsh. Authorized users only. */
function doOps(ctx: MenuCtx): MenuResult {
  if (!ctx.canOperate) {
    return { text: '⛔ 无权限使用运维功能(需在 allowedUserIds 白名单内)', keyboard: mainMenuKeyboard() }
  }
  return { text: '⚙️ 运维中心\n选择操作:', keyboard: opsMenuKeyboard() }
}

/** Show a host-process snapshot. */
function doOpsInfo(ctx: MenuCtx): MenuResult {
  if (!ctx.canOperate) {
    return { text: '⛔ 无权限使用运维功能(需在 allowedUserIds 白名单内)', keyboard: mainMenuKeyboard() }
  }
  return { text: `💻 宿主进程信息:\n${ctx.getHostInfo()}`, keyboard: opsMenuKeyboard() }
}

/** Schedule a host dsh restart (detached agent takes the host down & relaunches). */
function doRestartDsh(ctx: MenuCtx): MenuResult {
  if (!ctx.canOperate) {
    return { text: '⛔ 无权限使用运维功能(需在 allowedUserIds 白名单内)', keyboard: mainMenuKeyboard() }
  }
  return { text: ctx.restartDsh(), keyboard: mainMenuKeyboard() }
}
