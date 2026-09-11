/**
 * Menu module: Telegram inline-keyboard menus for chat controls. A menu button
 * press emits a `callback_query` whose `data` encodes the action; that action
 * either shows a submenu (with a back button) or performs a chat operation.
 *
 * @module telegram/menu
 */
/** Build an inline keyboard from row tuples [text, callbackData]. */
function keyboard(rows) {
    return {
        inline_keyboard: rows.map(row => row.map(([text, data]) => ({ text, callback_data: data }))),
    };
}
const BACK = 'menu:back';
/** Ops callback data (namespaced under `menu:ops:*`). */
const OPS = 'menu:ops';
const OPS_RESTART = 'menu:ops:restart';
const OPS_INFO = 'menu:ops:info';
/** Main menu text: status summary (when ctx is given), no menu-title banner. */
export async function mainMenuText(ctx) {
    if (ctx === undefined)
        return '选择功能:';
    return statusText(ctx);
}
/** Main menu keyboard (rows). */
export function mainMenuKeyboard() {
    return keyboard([
        // 「新建会话」与旧的「清除会话」是同一个动作（都走 sessions.rotate），
        // 已合并为一个按钮，避免两个入口做同一件事。
        [['🆕 新建会话', 'menu:new']],
        [['📂 工作目录', 'menu:workspace'], ['💬 会话', 'menu:sessions']],
        [['🤖 切换模型', 'menu:model'], ['🧭 工作方式', 'menu:preset']],
        [['⚙️ 运维', OPS]],
    ]);
}
/** Build a submenu frame with a Back row appended. */
function withBack(rows) {
    return keyboard([...rows, [['🔙 返回上级', BACK]]]);
}
/** Ops submenu keyboard (system info + restart dsh) with a Back row. */
function opsMenuKeyboard() {
    return withBack([
        [['🔄 重启 DSH', OPS_RESTART]],
        [['💻 系统信息', OPS_INFO]],
    ]);
}
/** Handle one callback `data`. Returns the text + keyboard to send/show. */
export async function handleMenuCallback(data, ctx) {
    switch (data) {
        case 'menu:new':
            return doNew(ctx);
        case 'menu:workspace':
            return doWorkspace(ctx);
        case 'menu:model':
            return doModel(ctx);
        case 'menu:preset':
            return doPreset(ctx);
        case 'menu:sessions':
            return doMenuSessions(ctx);
        case 'menu:sessions-manage':
            return doSessionsManage(ctx);
        case 'smrc':
            return doRenameCancel(ctx);
        case OPS:
            return doOps(ctx);
        case OPS_RESTART:
            return doRestartDsh(ctx);
        case OPS_INFO:
            return doOpsInfo(ctx);
        case BACK:
            return { text: await mainMenuText(ctx), keyboard: mainMenuKeyboard() };
        default:
            // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>
            // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>, session:<id>
            // 会话管理族的前缀更长，必须先判：sma!(执行归档) > sma:(归档确认) > smr:(重命名) > sm:(详情卡) > session:(选择)。
            if (data.startsWith('workspace:'))
                return doWorkspacePick(data, ctx);
            if (data.startsWith('model:'))
                return doModelPick(data, ctx);
            if (data.startsWith('preset:'))
                return doPresetPick(data, ctx);
            if (data.startsWith('sma!:'))
                return doSessionArchive(data.slice('sma!:'.length), ctx);
            if (data.startsWith('sma:'))
                return doSessionArchiveConfirm(data.slice('sma:'.length), ctx);
            if (data.startsWith('smr:'))
                return doSessionRename(data.slice('smr:'.length), ctx);
            if (data.startsWith('sm:'))
                return doSessionManage(data.slice('sm:'.length), ctx);
            if (data.startsWith('session:'))
                return doSessionPick(data, ctx);
            if (data.startsWith('nw:'))
                return handleNewWizard(data, ctx);
            return { text: '未知菜单项', keyboard: mainMenuKeyboard() };
    }
}
/** Shared confirmation for a fresh session (新建/清除 both rotate). */
function rotatedText(title, binding, previousSessionId, extra = []) {
    const lines = [title, `• 新会话: ${binding.sessionId}`, `• 工作目录: ${binding.cwd}`];
    if (previousSessionId !== undefined && previousSessionId !== '' && previousSessionId !== binding.sessionId) {
        lines.push(`• 已丢弃: ${previousSessionId}`);
    }
    lines.push(...extra);
    lines.push('下一条消息即在新会话中进行;可在「📊 状态」核对。');
    return lines.join('\n');
}
/* ------------------------------------------------------------------ 新建会话向导
 * 三步式：1) 选模型 → 2) 选工作方式 → 创建。每步都能「用当前」跳过或取消；
 * 选中的模型/工作方式先记进 draft，最后一步先落盘再 rotate，这样新会话真正
 * 带上这两个选择（create 时读取 per-chat 模型与 agentPreset）。
 */
/** 向导入口：清空草稿并进入第 1 步（选模型）。 */
async function doNew(ctx) {
    ctx.draft.reset();
    return newModelStep(ctx);
}
/** 向导第 1 步：选模型。 */
async function newModelStep(ctx) {
    const current = ctx.getCurrentModel();
    let models;
    try {
        models = await ctx.listModels();
    }
    catch {
        models = [{ provider: ctx.provider, model: ctx.model }];
    }
    const CAP = 40;
    const shown = models.slice(0, CAP);
    const isCurrent = (m) => m.provider === current.provider && m.model === current.model;
    const CHECK = '\u2705';
    const items = shown.map((m, i) => ({
        provider: m.provider,
        model: m.model,
        n: i + 1,
        label: `${i + 1}. ${isCurrent(m) ? CHECK + ' ' : ''}\`${m.model}\``,
    }));
    const groups = new Map();
    for (const item of items) {
        const list = groups.get(item.provider) ?? [];
        list.push(item);
        groups.set(item.provider, list);
    }
    const textLines = [
        `🆕 **新建会话** · 第 1/2 步:选择模型`,
        `（当前 \`${current.model}\`;点序号选择,或选「用当前模型」跳过）`,
    ];
    for (const [provider, group] of groups) {
        textLines.push('');
        textLines.push(`**${provider}**`);
        for (const item of group)
            textLines.push(`　${item.label}`);
    }
    if (models.length > CAP)
        textLines.push('', `…（共 ${models.length} 个，仅显示前 ${CAP}）`);
    const rows = [];
    let row = [];
    items.forEach((item) => {
        row.push([`${isCurrent(item) ? CHECK + ' ' : ''}${item.n}`, `nw:m:${item.n - 1}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    rows.push([['⏭ 用当前模型', 'nw:skip:m'], ['❌ 取消', 'nw:cancel']]);
    return { text: textLines.join('\n'), keyboard: withBack(rows) };
}
/** 向导第 2 步：选工作方式（无预设时直接创建）。 */
async function newPresetStep(ctx) {
    let presets = [];
    try {
        presets = await ctx.listPresets();
    }
    catch {
        presets = [];
    }
    if (presets.length === 0)
        return finishNewSession(ctx);
    let currentId = '';
    try {
        currentId = await ctx.getCurrentPresetId();
    }
    catch {
        currentId = '';
    }
    const draft = ctx.draft.read();
    const chosenModel = draft.model !== undefined
        ? `（已选模型 \`${draft.model}\`）`
        : '（沿用当前模型）';
    const textLines = [
        '🆕 **新建会话** · 第 2/2 步:选择工作方式',
        chosenModel,
    ];
    const rows = [];
    let row = [];
    presets.slice(0, 30).forEach((preset, i) => {
        const isCurrent = currentId !== '' && preset.id === currentId;
        textLines.push(`　${i + 1}. ${isCurrent ? '\u2705 ' : ''}\`${preset.name}\``);
        row.push([`${isCurrent ? '\u2705 ' : ''}${i + 1}`, `nw:p:${i}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    rows.push([['⏭ 用当前工作方式', 'nw:skip:p'], ['❌ 取消', 'nw:cancel']]);
    return { text: textLines.join('\n'), keyboard: withBack(rows) };
}
/** 向导最后一步：落盘选择并创建全新会话。 */
async function finishNewSession(ctx) {
    const draft = ctx.draft.read();
    // 先落 per-chat 模型与 agentPreset，再 rotate —— create 时读取这两项。
    if (draft.provider !== undefined && draft.model !== undefined) {
        try {
            await ctx.setModel(draft.provider, draft.model);
        }
        catch { /* 非致命:按原模型创建 */ }
    }
    if (draft.presetId !== undefined) {
        try {
            await ctx.setPreset(draft.presetId);
        }
        catch { /* 非致命:按原工作方式创建 */ }
    }
    const previousSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId);
    let binding;
    try {
        binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId);
    }
    catch (error) {
        ctx.draft.reset();
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `❌ 新建会话失败: ${msg}`, keyboard: mainMenuKeyboard() };
    }
    ctx.draft.reset();
    let workMode = '默认';
    try {
        workMode = await ctx.getCurrentPresetName();
    }
    catch { /* keep fallback */ }
    const model = ctx.getCurrentModel();
    return {
        text: rotatedText('✅ 已开启新会话(已丢弃当前上下文)', binding, previousSessionId, [
            `• 模型: ${model.provider}/${model.model}`,
            `• 工作方式: ${workMode}`,
        ]),
        keyboard: mainMenuKeyboard(),
    };
}
/** 向导回调分发：nw:m:<i> 选模型 / nw:p:<i> 选工作方式 / nw:skip:* / nw:cancel。 */
async function handleNewWizard(data, ctx) {
    if (data === 'nw:cancel') {
        ctx.draft.reset();
        return { text: '已取消新建会话。', keyboard: mainMenuKeyboard() };
    }
    if (data === 'nw:skip:m')
        return newPresetStep(ctx);
    if (data === 'nw:skip:p')
        return finishNewSession(ctx);
    const modelPick = /^nw:m:(\d+)$/.exec(data);
    if (modelPick !== null) {
        let models = [];
        try {
            models = await ctx.listModels();
        }
        catch {
            models = [];
        }
        const hit = models[Number(modelPick[1])];
        if (hit === undefined)
            return { text: '❌ 该模型已不可用,请重新选择。', keyboard: mainMenuKeyboard() };
        ctx.draft.patch({ provider: hit.provider, model: hit.model });
        return newPresetStep(ctx);
    }
    const presetPick = /^nw:p:(\d+)$/.exec(data);
    if (presetPick !== null) {
        let presets = [];
        try {
            presets = await ctx.listPresets();
        }
        catch {
            presets = [];
        }
        const hit = presets[Number(presetPick[1])];
        if (hit === undefined)
            return { text: '❌ 该工作方式已不可用,请重新选择。', keyboard: mainMenuKeyboard() };
        ctx.draft.patch({ presetId: hit.id });
        return finishNewSession(ctx);
    }
    return { text: '未知菜单项', keyboard: mainMenuKeyboard() };
}
/** Status summary text: session / cwd / work mode / model / binding (menu top). */
async function statusText(ctx) {
    const own = ctx.sessions.get(ctx.chatId, ctx.botId);
    const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId);
    const model = ctx.getCurrentModel();
    // Show the chat's persisted cwd (user's last workspace pick) so it matches
    // the workspace menu; the live session/bound cwd is a fallback only.
    const cwd = ctx.currentCwd();
    // Resolve the effective work-mode display name (selected preset or the
    // deployment default), so it matches the names listed in the switch menu.
    let workMode = '默认';
    try {
        workMode = await ctx.getCurrentPresetName();
    }
    catch { /* keep fallback */ }
    // 会话一栏显示**标题 + 时间**（与「💬 会话」菜单同一份数据），而不是裸 session id。
    let roster = [];
    try {
        roster = await ctx.listSessions();
    }
    catch {
        roster = [];
    }
    const label = (sessionId) => {
        const hit = roster.find(s => s.id === sessionId);
        if (hit === undefined)
            return sessionId;
        const title = hit.displayTitle ?? hit.title ?? sessionId;
        const time = formatTime(hit.updatedAt ?? 0);
        return time === '--' ? title : `${title} · ${time}`;
    };
    const lines = [
        '📊 当前状态:',
    ];
    if (bound !== undefined) {
        lines.push(`• 🔗 绑定会话: ${label(bound.sessionId)}`);
        lines.push(`• 绑定方式: ${bound.botId === '' ? '任意 bot' : `bot ${bound.botId}`}`);
    }
    else if (own !== undefined) {
        lines.push(`• 会话: ${label(own.sessionId)}`);
    }
    else {
        // No live agent yet. Still report the conversation this chat will resume
        // (a persisted session survives restarts), instead of claiming there is none.
        const active = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId);
        lines.push(active !== undefined
            ? `• 会话: ${label(active)}（上次会话,首条消息时恢复）`
            : '• 尚未选择会话(发消息将弹出会话选择列表)');
    }
    lines.push(`• 工作目录: ${cwd}`);
    lines.push(`• 工作方式: ${workMode}`);
    const info = ctx.getModelInfo?.();
    lines.push(`• 模型: ${model.provider}/${model.model}${modelSourceLabel(info?.source)}`);
    return lines.join('\n');
}
/** Chinese label for a model's source, shown next to the model in the status panel. */
function modelSourceLabel(source) {
    switch (source) {
        case 'chat': return '(本会话已选)';
        case 'session': return '(继承当前会话)';
        case 'host': return '(跟随宿主默认)';
        case 'bot': return '(Bot 固定)';
        default: return '';
    }
}
/** Workspace submenu: grouped text list with unique序号 + numbered buttons. */
async function doWorkspace(ctx) {
    let roots;
    try {
        roots = await ctx.listWorkspaces();
    }
    catch {
        roots = ctx.workspaceRoots;
    }
    if (roots.length === 0)
        roots = [ctx.currentCwd()];
    const current = ctx.currentCwd();
    const CAP = 30;
    const shown = roots.slice(0, CAP);
    const isCurrent = (p) => samePath(p, current);
    // 按盘符分组（与模型/会话菜单同款的「分组文字 + 唯一序号 + 序号按钮」）。
    const withMeta = shown.map((p, i) => {
        const match = /^([A-Za-z]:[\\/])/.exec(p);
        return {
            path: p,
            n: i + 1,
            drive: match !== null ? match[1] : '其它',
            relative: match !== null ? p.slice(match[1].length).replace(/^[\\/]+/, '') : p,
        };
    });
    const groups = new Map();
    for (const item of withMeta) {
        const list = groups.get(item.drive) ?? [];
        list.push(item);
        groups.set(item.drive, list);
    }
    const textLines = [`📂 **选择工作目录**（当前 \`${current}\`）`, '✅ 为当前目录;点下方序号按钮切换:'];
    for (const [drive, items] of groups) {
        textLines.push('');
        textLines.push(`**${drive}**`);
        for (const item of items) {
            const mark = isCurrent(item.path) ? '\u2705 ' : '';
            textLines.push(`　${item.n}. ${mark}\`${item.relative}\``);
        }
    }
    if (roots.length > CAP)
        textLines.push('', `…（共 ${roots.length} 个，仅显示前 ${CAP}）`);
    // 下方按钮：只放序号（当前目录带 ✅），每行 5 个；callback 仍为 workspace:<path>。
    const rows = [];
    let row = [];
    shown.forEach((p, i) => {
        row.push([`${isCurrent(p) ? '\u2705 ' : ''}${i + 1}`, `workspace:${p}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    return { text: textLines.join('\n'), keyboard: withBack(rows) };
}
/** Format a Unix-epoch-ms timestamp as a compact local "MM-DD HH:mm". */
function formatTime(ms) {
    if (!(ms > 0))
        return '--';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
async function doMenuSessions(ctx) {
    return sessionChoiceMenu(ctx);
}
/**
 * Build the session-selection menu for a chat: the sessions THAT BELONG TO the
 * chat's current working directory (time + title rows), scoped to that
 * directory, PLUS an always-visible 「🆕 新建会话」 button.
 *
 * This is what an ordinary message triggers when the chat has no active
 * session (e.g. right after a workspace switch): ask the user to create a new
 * session or pick an existing one in the current directory rather than
 * silently auto-creating or resuming.
 *
 * The directory is the boundary of the list: a session from another directory
 * is never shown here. When the chat's active session lives in another
 * directory the header says so instead of inventing a row for it.
 */
export async function sessionChoiceMenu(ctx) {
    let list;
    try {
        list = await ctx.listSessions();
    }
    catch {
        list = [];
    }
    const currentCwd = ctx.currentCwd();
    const activeSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId);
    const { scoped, activeInScope } = scopeSessionsToDir(list, currentCwd, activeSessionId);
    // The keyboard always carries 「🆕 新建会话」even when the directory has no
    // sessions, so the user is never left without a path forward.
    const newButton = ['🆕 新建会话', 'menu:new'];
    if (scoped.length === 0) {
        return {
            text: `💬 当前目录 \`${currentCwd}\` 下暂无会话\n(先点「🆕 新建会话」在该目录开新会话,或用 📂 工作目录 切换目录)`,
            keyboard: keyboard([[newButton], [['🔙 返回上级', BACK]]]),
        };
    }
    // 与模型菜单同款：上方按时间分组（组名加粗）的唯一序号列表，下方序号按钮。
    const CAP = 30;
    const shown = scoped.slice(0, CAP);
    const order = ['今天', '昨天', '最近 7 天', '更早'];
    const bucketOf = (ms) => {
        if (ms === 0)
            return '更早';
        const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const today = startOfDay(new Date());
        const day = startOfDay(new Date(ms));
        if (day >= today)
            return '今天';
        if (day === today - 86_400_000)
            return '昨天';
        if (today - day < 7 * 86_400_000)
            return '最近 7 天';
        return '更早';
    };
    const groups = new Map();
    shown.forEach((s, i) => {
        const b = bucketOf(s.updatedAt ?? 0);
        const list = groups.get(b) ?? [];
        list.push({ s, n: i + 1 });
        groups.set(b, list);
    });
    const awayNote = activeSessionId !== undefined && !activeInScope
        ? '\n(会话属于其它目录,故此处无 ✅;点 📂 工作目录 回到该目录即可看到)'
        : '';
    const textLines = [`💬 **选择会话**（当前目录 \`${currentCwd}\` · 命中 ${scoped.length} 条）${awayNote}`];
    textLines.push('点序号切换,或新建会话:');
    for (const bucket of order) {
        const items = groups.get(bucket);
        if (items === undefined || items.length === 0)
            continue;
        textLines.push('');
        textLines.push(`**${bucket}**`);
        for (const { s, n } of items) {
            const raw = s.displayTitle ?? s.title ?? s.id.slice(0, 12);
            const title = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
            const mark = s.id === activeSessionId ? '\u2705 ' : '';
            textLines.push(`　${n}. ${mark}${formatTime(s.updatedAt ?? 0)} · \`${title}\``);
        }
    }
    if (scoped.length > CAP)
        textLines.push('', `…（共 ${scoped.length} 条，仅显示前 ${CAP}）`);
    // 下方按钮：只放序号（现行会话带 ✅），每行 5 个；callback 仍为 session:<id>。
    const rows = [];
    let row = [];
    shown.forEach((s, i) => {
        row.push([`${s.id === activeSessionId ? '\u2705 ' : ''}${i + 1}`, `session:${s.id}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    rows.push([newButton], [['🛠 管理会话', 'menu:sessions-manage']]);
    return { text: textLines.join('\n'), keyboard: withBack(rows) };
}
/* ------------------------------------------------------------------ 会话管理
 * 「🛠 管理会话」入口：管理列表（同目录、只读展示）→ 详情卡 → 重命名 / 归档。
 * 重命名走两步：菜单登记目标会话，用户的下一条普通文本即新标题（Telegram 无法
 * 弹输入框），/cancel 或菜单取消按钮中止，超时自动失效。
 * 归档调宿主的注册表全局归档集（不可逆，会话日志与工作区记账保留）。
 */
/** 管理列表：与选择列表同一批会话，按钮进入详情卡而非直接切换。 */
async function doSessionsManage(ctx) {
    let list;
    try {
        list = await ctx.listSessions();
    }
    catch {
        list = [];
    }
    const currentCwd = ctx.currentCwd();
    const activeSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId);
    const { scoped } = scopeSessionsToDir(list, currentCwd, activeSessionId);
    if (scoped.length === 0) {
        return {
            text: `🛠 当前目录 \`${currentCwd}\` 下暂无可管理的会话`,
            keyboard: keyboard([[['🔙 返回会话列表', 'menu:sessions']], [['🔙 返回上级', BACK]]]),
        };
    }
    const CAP = 30;
    const shown = scoped.slice(0, CAP);
    const lines = [`🛠 **管理会话**（当前目录 \`${currentCwd}\` · 命中 ${scoped.length} 条）`, '点序号进入会话管理:'];
    shown.forEach((s, i) => {
        const raw = s.displayTitle ?? s.title ?? s.id.slice(0, 12);
        const title = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
        const mark = s.id === activeSessionId ? '\u2705 ' : '';
        lines.push(`　${i + 1}. ${mark}${formatTime(s.updatedAt ?? 0)} · \`${title}\``);
    });
    if (scoped.length > CAP)
        lines.push('', `…（共 ${scoped.length} 条，仅显示前 ${CAP}）`);
    const rows = [];
    let row = [];
    shown.forEach((s, i) => {
        row.push([`${s.id === activeSessionId ? '\u2705 ' : ''}${i + 1}`, `sm:${s.id}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    rows.push([['🔙 返回会话列表', 'menu:sessions']]);
    return { text: lines.join('\n'), keyboard: withBack(rows) };
}
/** 会话详情卡：标题/时间/目录/是否当前会话 + 重命名、归档入口。 */
async function doSessionManage(sessionId, ctx) {
    const found = await findSession(sessionId, ctx);
    const activeSessionId = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId);
    const isActive = activeSessionId === sessionId;
    const title = found?.displayTitle ?? found?.title ?? sessionId;
    const time = formatTime(found?.updatedAt ?? 0);
    const lines = [
        '🛠 **会话管理**',
        `• 标题: \`${title}\``,
        `• 目录: ${found?.cwd ?? ctx.currentCwd()}`,
        `• 时间: ${time}`,
        `• 会话: \`${sessionId}\``,
        isActive ? '• ✅ 这是本 chat 当前会话(归档会同时释放绑定)' : '• 非当前会话',
    ];
    const rows = [
        [['✏️ 重命名', `smr:${sessionId}`], ['🗄 归档', `sma:${sessionId}`]],
        [['🔙 返回管理列表', 'menu:sessions-manage']],
    ];
    return { text: lines.join('\n'), keyboard: keyboard(rows) };
}
/** 重命名第 1 步：登记目标会话，等下一条文本消息作为新标题。 */
async function doSessionRename(sessionId, ctx) {
    const found = await findSession(sessionId, ctx);
    const title = found?.displayTitle ?? found?.title ?? sessionId;
    ctx.beginRename(sessionId);
    return {
        text: [
            '✏️ **重命名会话**',
            `目标: \`${title}\``,
            '',
            '请直接发送新的会话标题(下一条消息即标题,不会发给 agent)。',
            '发送 /cancel 或点下方按钮可取消;120 秒内未发送则自动失效。',
        ].join('\n'),
        keyboard: keyboard([[['❌ 取消重命名', 'smrc']]]),
    };
}
/** 重命名取消：清掉登记态。 */
function doRenameCancel(ctx) {
    ctx.cancelRename();
    return { text: '已取消重命名。', keyboard: mainMenuKeyboard() };
}
/** 归档第 1 步：二次确认（宿主归档不可逆）。 */
async function doSessionArchiveConfirm(sessionId, ctx) {
    const found = await findSession(sessionId, ctx);
    const title = found?.displayTitle ?? found?.title ?? sessionId;
    const isActive = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId) === sessionId;
    const lines = [
        '🗄 **确认归档会话**',
        `标题: \`${title}\``,
        '',
        '归档后该会话将从所有列表隐藏(含 GUI),会话日志仍保留;',
        '宿主不提供取消归档,请确认后再执行。',
    ];
    if (isActive)
        lines.push('', '⚠️ 这是本 chat 当前会话,归档会同时释放绑定,下一条消息将弹出会话选择列表。');
    return {
        text: lines.join('\n'),
        keyboard: keyboard([
            [['🗄 确认归档', `sma!:${sessionId}`]],
            [['🔙 返回', `sm:${sessionId}`]],
        ]),
    };
}
/** 归档第 2 步：执行（宿主注册表归档集）。 */
async function doSessionArchive(sessionId, ctx) {
    const found = await findSession(sessionId, ctx);
    const title = found?.displayTitle ?? found?.title ?? sessionId;
    const wasActive = ctx.sessions.activeSessionId(ctx.chatId, ctx.botId) === sessionId;
    try {
        await ctx.archiveSession(sessionId);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `❌ 归档失败: ${msg}`, keyboard: keyboard([[['🔙 返回', `sm:${sessionId}`]]]) };
    }
    const lines = [`✅ 已归档: \`${title}\``, '该会话已从所有列表隐藏(会话日志保留)。'];
    if (wasActive)
        lines.push('当前会话已释放,下一条消息将弹出会话选择列表。');
    return {
        text: lines.join('\n'),
        keyboard: keyboard([[['🔙 返回会话列表', 'menu:sessions']], [['🔙 返回上级', BACK]]]),
    };
}
/** 从同一份名单里查一条会话（标题/时间/目录），查不到返回 undefined。 */
async function findSession(sessionId, ctx) {
    try {
        const list = await ctx.listSessions();
        return list.find(s => s.id === sessionId);
    }
    catch {
        return undefined;
    }
}
/**
 * Scope a roster to one working directory (newest first) and report whether the
 * chat's active session is part of that scope.
 *
 * Path comparison is separator/case-insensitive: the roster and the workspace
 * picker do not always spell the same directory the same way.
 */
export function scopeSessionsToDir(list, currentCwd, activeSessionId) {
    const scoped = list
        .filter(s => samePath(s.cwd, currentCwd))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const activeInScope = activeSessionId !== undefined && scoped.some(s => s.id === activeSessionId);
    return { scoped, activeInScope };
}
/**
 * Compare two workspace paths for equality: separators and case are not
 * significant (the roster and the workspace picker spell them differently).
 */
function samePath(a, b) {
    if (a === undefined || b === undefined || a === '' || b === '')
        return false;
    const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}
/** Model submenu: grouped text list with unique序号 + numbered buttons. */
async function doModel(ctx) {
    const current = ctx.getCurrentModel();
    let models;
    try {
        models = await ctx.listModels();
    }
    catch {
        models = [{ provider: ctx.provider, model: ctx.model }];
    }
    const CAP = 40;
    const shown = models.slice(0, CAP);
    const isCurrent = (m) => m.provider === current.provider && m.model === current.model;
    const CHECK = '\u2705';
    // 全局唯一序号（1..N，按 listModels 返回顺序）；模型名用等宽显示。
    const line = shown.map((m, i) => [
        `${i + 1}. ${isCurrent(m) ? CHECK + ' ' : ''}\`${m.model}\``,
        m,
    ]);
    // 上方文字：按 provider 分组（组名加粗）、组间空行、序号全局唯一。
    const textLines = [`🤖 **选择模型**（当前 \`${current.model}\`；仅影响本 Bot 的这个会话）`];
    const groups = new Map();
    for (const [label, m] of line) {
        const list = groups.get(m.provider) ?? [];
        list.push([label, m]);
        groups.set(m.provider, list);
    }
    for (const [provider, items] of groups) {
        textLines.push('');
        textLines.push(`**${provider || '(未知 Provider)'}**`);
        for (const [label] of items)
            textLines.push(`　${label}`);
    }
    if (models.length > CAP)
        textLines.push('', `…（共 ${models.length} 个，仅显示前 ${CAP}）`);
    // 下方按钮：只放序号（现行模型带 ✅），每行 5 个；callback 仍为 model:<provider>:<model>。
    const rows = [];
    let row = [];
    shown.forEach((m, i) => {
        const btnLabel = `${isCurrent(m) ? CHECK + ' ' : ''}${i + 1}`;
        row.push([btnLabel, `model:${m.provider}:${m.model}`]);
        if (row.length === 5) {
            rows.push(row);
            row = [];
        }
    });
    if (row.length > 0)
        rows.push(row);
    return {
        text: textLines.join('\n'),
        keyboard: withBack(rows),
    };
}
/** Preset (work mode) submenu: list available presets, marking the current one. */
async function doPreset(ctx) {
    let presets;
    try {
        presets = await ctx.listPresets();
    }
    catch {
        presets = [];
    }
    if (presets.length === 0) {
        return { text: '🧭 暂无预设列表', keyboard: mainMenuKeyboard() };
    }
    let currentId;
    try {
        currentId = await ctx.getCurrentPresetId();
    }
    catch {
        currentId = undefined;
    }
    const rows = presets.map(p => {
        const sel = currentId !== undefined && p.id === currentId;
        return [[`${sel ? '\u2705 ' : ''}${p.name}`, `preset:${p.id}`]];
    });
    return {
        text: '🧭 切换工作方式(预设);当前用 \u2705 标记;将新开会话生效:',
        keyboard: withBack(rows),
    };
}
/** Apply a picked workspace root. */
async function doWorkspacePick(data, ctx) {
    const target = data.slice('workspace:'.length);
    // Switching to a DIFFERENT directory detaches the current session: the user
    // wants to start fresh there. Picking the same directory keeps the session.
    const detached = await ctx.switchCwd(target);
    if (detached) {
        // Show the session-selection list right away (it carries the 🆕 新建会话
        // button): the next step after picking a directory is picking or starting
        // the conversation in it, so the user never has to send a stray message
        // just to summon this list.
        const choice = await sessionChoiceMenu(ctx);
        return {
            text: `📁 已切换到工作目录:${target}\n已释放原会话,请选择或新建会话:\n\n${choice.text}`,
            keyboard: choice.keyboard,
        };
    }
    return {
        text: `📁 已切换到工作目录:${target}\n新建会话(清除会话)将以该目录开启。`,
        keyboard: mainMenuKeyboard(),
    };
}
/** Apply a picked model: switch this bot's per-chat model selection. */
async function doModelPick(data, ctx) {
    const rest = data.slice('model:'.length);
    const sep = rest.indexOf(':');
    const provider = sep >= 0 ? rest.slice(0, sep) : ctx.provider;
    const model = sep >= 0 ? rest.slice(sep + 1) : rest;
    try {
        await ctx.setModel(provider, model);
        return {
            text: `✅ 已切换到模型: ${model}\n(只对本 Bot 的这个 chat 生效;其他 Bot 与 GUI 不受影响)`,
            keyboard: mainMenuKeyboard(),
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `❌ 切换模型失败: ${msg}`, keyboard: mainMenuKeyboard() };
    }
}
/** Apply a picked preset (work mode): note that a fresh session is needed. */
async function doPresetPick(data, ctx) {
    const id = data.slice('preset:'.length);
    try {
        await ctx.setPreset(id);
        return { text: `✅ 已切换工作方式: ${id}\n新建会话(清除会话)后生效。`, keyboard: mainMenuKeyboard() };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `❌ 切换工作方式失败: ${msg}`, keyboard: mainMenuKeyboard() };
    }
}
/** A picked session: switch this chat to it (bind + persist). */
async function doSessionPick(data, ctx) {
    const id = data.slice('session:'.length);
    // Look up the session's cwd (for the binding) AND its display title/time from
    // the same roster the picker renders, so the confirmation names the
    // conversation instead of echoing a raw session id.
    let cwd;
    let label = id;
    try {
        const list = await ctx.listSessions();
        const hit = list.find(s => s.id === id);
        cwd = hit?.cwd;
        const title = hit?.displayTitle ?? hit?.title;
        if (title !== undefined && title !== '' && title !== id) {
            const time = formatTime(hit?.updatedAt ?? 0);
            label = time === '--' ? title : `${title} · ${time}`;
        }
    }
    catch {
        cwd = undefined;
    }
    try {
        await ctx.switchSession(id, cwd);
        return {
            text: `✅ 已切换到会话: ${label}\n后续消息将进入该会话;工作目录: ${cwd ?? ctx.currentCwd()}`,
            keyboard: mainMenuKeyboard(),
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `❌ 切换会话失败: ${msg}`, keyboard: mainMenuKeyboard() };
    }
}
/** Ops submenu: system info + restart dsh. Authorized users only. */
function doOps(ctx) {
    if (!ctx.canOperate) {
        return {
            text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
            keyboard: mainMenuKeyboard(),
        };
    }
    return { text: '⚙️ 运维中心\n选择操作:', keyboard: opsMenuKeyboard() };
}
/** Show a host-process snapshot. */
function doOpsInfo(ctx) {
    if (!ctx.canOperate) {
        return {
            text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
            keyboard: mainMenuKeyboard(),
        };
    }
    return { text: `💻 宿主进程信息:\n${ctx.getHostInfo()}`, keyboard: opsMenuKeyboard() };
}
/** Schedule a host dsh restart (detached agent takes the host down & relaunches). */
function doRestartDsh(ctx) {
    if (!ctx.canOperate) {
        return {
            text: `⛔ 无权限使用运维功能\n你的 Telegram user id: ${ctx.userId}\n(把该 id 加入 allowedUserIds 白名单即可)`,
            keyboard: mainMenuKeyboard(),
        };
    }
    return { text: ctx.restartDsh(), keyboard: mainMenuKeyboard() };
}
