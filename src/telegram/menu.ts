/**
 * Menu module: Telegram inline-keyboard menus for chat controls. A menu button
 * press emits a `callback_query` whose `data` encodes the action; that action
 * either shows a submenu (with a back button) or performs a chat operation.
 *
 * @module telegram/menu
 */

import type { Delivery } from './delivery.js'
import type { SessionManager } from '../core/session-manager.js'
import type { StateStore } from '../core/state-store.js'
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
  /** Display name of the current work mode (selected preset, or the default). */
  getCurrentPresetName(): Promise<string>
  /** Current work-mode preset id (per-chat selection, else the default). */
  getCurrentPresetId(): Promise<string>
  listWorkspaces(): Promise<string[]>
  listSessions(): Promise<Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }>>
  /** Switch this chat to an existing DSH session (bind + persist). */
  switchSession(sessionId: string, cwd?: string): Promise<void>
  /** This chat's currently selected working directory (persisted cwd or default). */
  currentCwd(): string
  /** Persist this chat's working directory (merge + flush). */
  setCurrentCwd(cwd: string): void
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
export async function mainMenuText(ctx?: MenuCtx): Promise<string> {
  if (ctx === undefined) return '选择功能:'
  return statusText(ctx)
}

/** Main menu keyboard (rows). */
export function mainMenuKeyboard(): TelegramInlineKeyboard {
  return keyboard([
    [['🆕 新建会话', 'menu:new'], ['🗑 清除会话', 'menu:clear']],
    [['📂 工作目录', 'menu:workspace'], ['💬 会话', 'menu:sessions']],
    [['🤖 切换模型', 'menu:model'], ['🧭 工作方式', 'menu:preset']],
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
    case 'menu:sessions':
      return doMenuSessions(ctx)
    case OPS:
      return doOps(ctx)
    case OPS_RESTART:
      return doRestartDsh(ctx)
    case OPS_INFO:
      return doOpsInfo(ctx)
    case BACK:
      return { text: await mainMenuText(ctx), keyboard: mainMenuKeyboard() }
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

/** Status summary text: session / cwd / work mode / model / binding (menu top). */
async function statusText(ctx: MenuCtx): Promise<string> {
  const own = ctx.sessions.get(ctx.chatId, ctx.botId)
  const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId)
  const model = ctx.getCurrentModel()
  // Show the chat's persisted cwd (user's last workspace pick) so it matches
  // the workspace menu; the live session/bound cwd is a fallback only.
  const cwd = ctx.currentCwd()
  // Resolve the effective work-mode display name (selected preset or the
  // deployment default), so it matches the names listed in the switch menu.
  let workMode = '默认'
  try { workMode = await ctx.getCurrentPresetName() } catch { /* keep fallback */ }
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
  if (roots.length === 0) roots = [ctx.currentCwd()]
  const current = ctx.currentCwd()
  const rows: Array<Array<[string, string]>> = []
  for (const root of roots.slice(0, 15)) {
    const mark = root === current ? '\u2705 ' : ''
    rows.push([[`${mark}🗂 ${root}`, `workspace:${root}`]])
  }
  return {
    text: `📂 选择工作目录(当前 ${current}):`,
    keyboard: withBack(rows),
  }
}

/** Format a Unix-epoch-ms timestamp as a compact local "MM-DD HH:mm". */
function formatTime(ms: number): string {
  if (!(ms > 0)) return '--'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Sessions submenu: list the chat's sessions, scoped to its current working
 * directory, as "time + title" rows; picking one switches this chat to it.
 */
async function doMenuSessions(ctx: MenuCtx): Promise<MenuResult> {
  let list: Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }>
  try {
    list = await ctx.listSessions()
  } catch {
    list = []
  }
  if (list.length === 0) {
    return { text: '💬 暂无会话记录', keyboard: mainMenuKeyboard() }
  }
  const currentCwd = ctx.currentCwd()
  // Scope to the chat's current working directory, newest first.
  const scoped = list
    .filter(s => s.cwd === currentCwd)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const shown = scoped.length > 0 ? scoped.slice(0, 15) : list.slice(0, 15)
  if (shown.length === 0) {
    return { text: `💬 当前工作目录下暂无会话\n(工作目录 ${currentCwd})`, keyboard: mainMenuKeyboard() }
  }
  // Mark the session this chat is currently on (its bound session, else its own
  // session) so re-entering the list shows the active one with a green check.
  const boundSession = ctx.sessions.getBound(ctx.chatId, ctx.botId)
  const ownSession = ctx.sessions.get(ctx.chatId, ctx.botId)
  const activeSessionId = boundSession?.sessionId ?? ownSession?.sessionId
  const rows: Array<Array<[string, string]>> = shown.map(s => {
    const title = s.displayTitle ?? s.title ?? s.id.slice(0, 12)
    const mark = s.id === activeSessionId ? '\u2705 ' : ''
    return [[`${mark}${formatTime(s.updatedAt ?? 0)} · ${title}`, `session:${s.id}`]]
  })
  const scopeNote = scoped.length > 0 ? `当前目录(${currentCwd})` : '全部会话'
  return {
    text: `💬 会话(${scopeNote})\n✅ 为当前会话;点选以切换该会话;时间为更新时间:`,
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
      `${sel ? '\u2705 ' : ''}${m.model}`,
      `model:${m.provider}:${m.model}`,
    ]])
  }
  return {
    text: `🤖 选择模型(当前 ${current.model};仅影响本 Bot 的这个会话):`,
    keyboard: withBack(rows),
  }
}

/** Preset (work mode) submenu: list available presets, marking the current one. */
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
  let currentId: string | undefined
  try { currentId = await ctx.getCurrentPresetId() } catch { currentId = undefined }
  const rows: Array<Array<[string, string]>> = presets.map(p => {
    const sel = currentId !== undefined && p.id === currentId
    return [[`${sel ? '\u2705 ' : ''}${p.name}`, `preset:${p.id}`]]
  })
  return {
    text: '🧭 切换工作方式(预设);当前用 \u2705 标记;将新开会话生效:',
    keyboard: withBack(rows),
  }
}

/** Apply a picked workspace root. */
function doWorkspacePick(data: string, ctx: MenuCtx): MenuResult {
  const target = data.slice('workspace:'.length)
  // Persist the picked cwd for this chat (merge existing fields + flush), so it
  // survives a DSH restart and is used as the cwd for the next fresh session.
  ctx.setCurrentCwd(target)
  return {
    text: `📁 已切换到工作目录:${target}\n新建会话(清除会话)将以该目录开启。`,
    keyboard: mainMenuKeyboard(),
  }
}

/** Apply a picked model: switch this bot's per-chat model selection. */
async function doModelPick(data: string, ctx: MenuCtx): Promise<MenuResult> {
  const rest = data.slice('model:'.length)
  const sep = rest.indexOf(':')
  const provider = sep >= 0 ? rest.slice(0, sep) : ctx.provider
  const model = sep >= 0 ? rest.slice(sep + 1) : rest
  try {
    await ctx.setModel(provider, model)
    return {
      text: `✅ 已切换到模型: ${model}\n(只对本 Bot 的这个 chat 生效;其他 Bot 与 GUI 不受影响)`,
      keyboard: mainMenuKeyboard(),
    }
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

/** A picked session: switch this chat to it (bind + persist). */
async function doSessionPick(data: string, ctx: MenuCtx): Promise<MenuResult> {
  const id = data.slice('session:'.length)
  // Look up the session's cwd (for the binding) from the roster, else default.
  let cwd: string | undefined
  try {
    const list = await ctx.listSessions()
    cwd = list.find(s => s.id === id)?.cwd
  } catch { cwd = undefined }
  try {
    await ctx.switchSession(id, cwd)
    return {
      text: `✅ 已切换到会话: ${id}\n后续消息将进入该会话;工作目录: ${cwd ?? ctx.currentCwd()}`,
      keyboard: mainMenuKeyboard(),
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { text: `❌ 切换会话失败: ${msg}`, keyboard: mainMenuKeyboard() }
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
