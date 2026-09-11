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
  /**
   * Effective model plus its source (`chat` / `session` / `host` / `bot`), so the
   * status panel can show that the model is inherited from the current session.
   */
  getModelInfo?(): { provider: string; model: string; source: 'chat' | 'session' | 'host' | 'bot' }
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

/** Shared confirmation for a fresh session (新建/清除 both rotate). */
function rotatedText(
  title: string,
  binding: { sessionId: string; cwd: string },
  previousSessionId: string | undefined,
): string {
  const lines = [title, `• 新会话: ${binding.sessionId}`, `• 工作目录: ${binding.cwd}`]
  if (previousSessionId !== undefined && previousSessionId !== '' && previousSessionId !== binding.sessionId) {
    lines.push(`• 已丢弃: ${previousSessionId}`)
  }
  lines.push('下一条消息即在新会话中进行;可在「📊 状态」核对。')
  return lines.join('\n')
}

/** New (rotate to a fresh session). */
async function doNew(ctx: MenuCtx): Promise<MenuResult> {
  const previousSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId)
  const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId)
  return {
    text: rotatedText('✅ 已开启新会话', binding, previousSessionId),
    keyboard: mainMenuKeyboard(),
  }
}

/** Clear (rotate a fresh session, same as new for now). */
async function doClear(ctx: MenuCtx): Promise<MenuResult> {
  const previousSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId)
  const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId)
  return {
    text: rotatedText('🧹 已清除会话，开启新会话', binding, previousSessionId),
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
    // No live agent yet. Still report the conversation this chat will resume
    // (a persisted session survives restarts), instead of claiming there is none.
    const active = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId)
    lines.push(active !== undefined
      ? `• session: ${active}(上次会话,首条消息时恢复)`
      : '• 尚未创建会话(发消息即建)')
  }
  lines.push(`• 工作目录: ${cwd}`)
  lines.push(`• 工作方式: ${workMode}`)
  const info = ctx.getModelInfo?.()
  lines.push(`• 模型: ${model.provider}/${model.model}${modelSourceLabel(info?.source)}`)
  return lines.join('\n')
}

/** Chinese label for a model's source, shown next to the model in the status panel. */
function modelSourceLabel(source: 'chat' | 'session' | 'host' | 'bot' | undefined): string {
  switch (source) {
    case 'chat': return '(本会话已选)'
    case 'session': return '(继承当前会话)'
    case 'host': return '(跟随宿主默认)'
    case 'bot': return '(Bot 固定)'
    default: return ''
  }
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
 * Sessions submenu: list the sessions THAT BELONG TO the chat's current working
 * directory, as "time + title" rows; picking one switches this chat to it.
 *
 * The directory is the boundary of this list: a session from another directory is
 * never shown here (an earlier fix pinned the active session unconditionally,
 * which made a conversation from directory A keep appearing — already ticked —
 * after switching to directory B). When the chat's active session lives in
 * another directory the header says so instead of inventing a row for it.
 */
async function doMenuSessions(ctx: MenuCtx): Promise<MenuResult> {
  let list: Array<{ id: string; cwd?: string; title?: string; displayTitle?: string; updatedAt?: number }>
  try {
    list = await ctx.listSessions()
  } catch {
    list = []
  }
  const currentCwd = ctx.currentCwd()
  const activeSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId)
  const { scoped, activeInScope } = scopeSessionsToDir(list, currentCwd, activeSessionId)
  if (scoped.length === 0) {
    return {
      text: `💬 当前目录下暂无会话\n工作目录: ${currentCwd}\n(先用 📂 工作目录 切到目标目录,再从此处选择会话)`,
      keyboard: mainMenuKeyboard(),
    }
  }
  // 与模型菜单同款：上方按时间分组（组名加粗）的唯一序号列表，下方序号按钮。
  const CAP = 30
  const shown = scoped.slice(0, CAP)
  const order = ['今天', '昨天', '最近 7 天', '更早'] as const
  const bucketOf = (ms: number): (typeof order)[number] => {
    if (ms === 0) return '更早'
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const today = startOfDay(new Date())
    const day = startOfDay(new Date(ms))
    if (day >= today) return '今天'
    if (day === today - 86_400_000) return '昨天'
    if (today - day < 7 * 86_400_000) return '最近 7 天'
    return '更早'
  }
  const groups = new Map<string, Array<{ s: typeof shown[number]; n: number }>>()
  shown.forEach((s, i) => {
    const b = bucketOf(s.updatedAt ?? 0)
    const list = groups.get(b) ?? []
    list.push({ s, n: i + 1 })
    groups.set(b, list)
  })

  const awayNote = activeSessionId !== undefined && !activeInScope
    ? '\n(本 chat 已选会话属于其它目录,故此处无 ✅;点 📂 工作目录 回到该目录即可看到)'
    : ''
  const textLines = [`💬 **选择会话**（当前目录 \`${currentCwd}\` · 命中 ${scoped.length} 条）${awayNote}`]
  textLines.push('✅ 为当前会话;点下方序号按钮切换:')
  for (const bucket of order) {
    const items = groups.get(bucket)
    if (items === undefined || items.length === 0) continue
    textLines.push('')
    textLines.push(`**${bucket}**`)
    for (const { s, n } of items) {
      const raw = s.displayTitle ?? s.title ?? s.id.slice(0, 12)
      const title = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw
      const mark = s.id === activeSessionId ? '\u2705 ' : ''
      textLines.push(`　${n}. ${mark}${formatTime(s.updatedAt ?? 0)} · \`${title}\``)
    }
  }
  if (scoped.length > CAP) textLines.push('', `…（共 ${scoped.length} 条，仅显示前 ${CAP}）`)

  // 下方按钮：只放序号（现行会话带 ✅），每行 5 个；callback 仍为 session:<id>。
  const rows: Array<Array<[string, string]>> = []
  let row: Array<[string, string]> = []
  shown.forEach((s, i) => {
    row.push([`${s.id === activeSessionId ? '\u2705 ' : ''}${i + 1}`, `session:${s.id}`])
    if (row.length === 5) {
      rows.push(row)
      row = []
    }
  })
  if (row.length > 0) rows.push(row)
  return { text: textLines.join('\n'), keyboard: withBack(rows) }
}

/**
 * Scope a roster to one working directory (newest first) and report whether the
 * chat's active session is part of that scope.
 *
 * Path comparison is separator/case-insensitive: the roster and the workspace
 * picker do not always spell the same directory the same way.
 */
export function scopeSessionsToDir<T extends { id: string; cwd?: string; updatedAt?: number }>(
  list: readonly T[],
  currentCwd: string,
  activeSessionId: string | undefined,
): { scoped: T[]; activeInScope: boolean } {
  const scoped = list
    .filter(s => samePath(s.cwd, currentCwd))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const activeInScope = activeSessionId !== undefined && scoped.some(s => s.id === activeSessionId)
  return { scoped, activeInScope }
}

/**
 * Compare two workspace paths for equality: separators and case are not
 * significant (the roster and the workspace picker spell them differently).
 */
function samePath(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === '' || b === '') return false
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Model submenu: grouped text list with unique序号 + numbered buttons. */
async function doModel(ctx: MenuCtx): Promise<MenuResult> {
  const current = ctx.getCurrentModel()
  let models: Array<{ provider: string; model: string }>
  try {
    models = await ctx.listModels()
  } catch {
    models = [{ provider: ctx.provider, model: ctx.model }]
  }
  const CAP = 40
  const shown = models.slice(0, CAP)
  const isCurrent = (m: { provider: string; model: string }) =>
    m.provider === current.provider && m.model === current.model
  const CHECK = '\u2705'

  // 全局唯一序号（1..N，按 listModels 返回顺序）；模型名用等宽显示。
  const line: Array<[string, { provider: string; model: string }]> = shown.map((m, i) => [
    `${i + 1}. ${isCurrent(m) ? CHECK + ' ' : ''}\`${m.model}\``,
    m,
  ])

  // 上方文字：按 provider 分组（组名加粗）、组间空行、序号全局唯一。
  const textLines = [`🤖 **选择模型**（当前 \`${current.model}\`；仅影响本 Bot 的这个会话）`]
  const groups = new Map<string, typeof line>()
  for (const [label, m] of line) {
    const list = groups.get(m.provider) ?? []
    list.push([label, m])
    groups.set(m.provider, list)
  }
  for (const [provider, items] of groups) {
    textLines.push('')
    textLines.push(`**${provider || '(未知 Provider)'}**`)
    for (const [label] of items) textLines.push(`　${label}`)
  }
  if (models.length > CAP) textLines.push('', `…（共 ${models.length} 个，仅显示前 ${CAP}）`)

  // 下方按钮：只放序号（现行模型带 ✅），每行 5 个；callback 仍为 model:<provider>:<model>。
  const rows: Array<Array<[string, string]>> = []
  let row: Array<[string, string]> = []
  shown.forEach((m, i) => {
    const btnLabel = `${isCurrent(m) ? CHECK + ' ' : ''}${i + 1}`
    row.push([btnLabel, `model:${m.provider}:${m.model}`])
    if (row.length === 5) {
      rows.push(row)
      row = []
    }
  })
  if (row.length > 0) rows.push(row)

  return {
    text: textLines.join('\n'),
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
    return {
      text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
      keyboard: mainMenuKeyboard(),
    }
  }
  return { text: '⚙️ 运维中心\n选择操作:', keyboard: opsMenuKeyboard() }
}

/** Show a host-process snapshot. */
function doOpsInfo(ctx: MenuCtx): MenuResult {
  if (!ctx.canOperate) {
    return {
      text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
      keyboard: mainMenuKeyboard(),
    }
  }
  return { text: `💻 宿主进程信息:\n${ctx.getHostInfo()}`, keyboard: opsMenuKeyboard() }
}

/** Schedule a host dsh restart (detached agent takes the host down & relaunches). */
function doRestartDsh(ctx: MenuCtx): MenuResult {
  if (!ctx.canOperate) {
    return {
      text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
      keyboard: mainMenuKeyboard(),
    }
  }
  return { text: ctx.restartDsh(), keyboard: mainMenuKeyboard() }
}
