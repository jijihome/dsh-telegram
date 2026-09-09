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
/** Main menu keyboard. */
export function mainMenuText() {
    return '🛠 dsh-telegram 菜单\n选择功能:';
}
/** Main menu keyboard (rows). */
export function mainMenuKeyboard() {
    return keyboard([
        [['🆕 新建会话', 'menu:new'], ['🗑 清除会话', 'menu:clear']],
        [['📂 工作目录', 'menu:workspace'], ['🔗 绑定会话', 'menu:bind']],
        [['🤖 切换模型', 'menu:model'], ['🧭 工作方式', 'menu:preset']],
        [['📊 查询状态', 'menu:session'], ['🗒 会话记录', 'menu:history']],
    ]);
}
/** Build a submenu frame with a Back row appended. */
function withBack(rows) {
    return keyboard([...rows, [['🔙 返回上级', BACK]]]);
}
/** Handle one callback `data`. Returns the text + keyboard to send/show. */
export async function handleMenuCallback(data, ctx) {
    switch (data) {
        case 'menu:new':
            return doNew(ctx);
        case 'menu:clear':
            return doClear(ctx);
        case 'menu:session':
            return doStatus(ctx);
        case 'menu:workspace':
            return doWorkspace(ctx);
        case 'menu:model':
            return doModel(ctx);
        case 'menu:preset':
            return doPreset(ctx);
        case 'menu:bind':
            return doBind(ctx);
        case 'menu:history':
            return doHistory(ctx);
        case BACK:
            return { text: mainMenuText(), keyboard: mainMenuKeyboard() };
        default:
            // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>
            // Namespaced sub-actions: workspace:<path>, model:<provider>:<model>, preset:<id>, session:<id>
            if (data.startsWith('workspace:'))
                return doWorkspacePick(data, ctx);
            if (data.startsWith('model:'))
                return doModelPick(data, ctx);
            if (data.startsWith('preset:'))
                return doPresetPick(data, ctx);
            if (data.startsWith('session:'))
                return doSessionPick(data, ctx);
            return { text: '未知菜单项', keyboard: mainMenuKeyboard() };
    }
}
/** New (rotate to a fresh session). */
async function doNew(ctx) {
    const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId);
    return {
        text: `✅ 已开启新会话\n• session: ${binding.sessionId}`,
        keyboard: mainMenuKeyboard(),
    };
}
/** Clear (rotate a fresh session, same as new for now). */
async function doClear(ctx) {
    const binding = await ctx.sessions.rotate(ctx.chatId, ctx.botId);
    return {
        text: `🧹 已清除会话，开启新会话\n• session: ${binding.sessionId}`,
        keyboard: mainMenuKeyboard(),
    };
}
/** Query status: session / cwd / model / binding. */
function doStatus(ctx) {
    const own = ctx.sessions.get(ctx.chatId, ctx.botId);
    const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId);
    const model = ctx.getCurrentModel();
    const lines = [
        '📊 会话状态:',
    ];
    if (bound !== undefined) {
        lines.push(`• 🔗 绑定会话: ${bound.sessionId}`);
        lines.push(`• 绑定方式: ${bound.botId === '' ? '任意 bot' : `bot ${bound.botId}`}`);
    }
    else if (own !== undefined) {
        lines.push(`• session: ${own.sessionId}`);
        lines.push(`• cwd: ${own.cwd}`);
    }
    else {
        lines.push('• 尚未创建会话(发消息即建)');
    }
    lines.push(`• 模型: ${model.provider}/${model.model}`);
    return { text: lines.join('\n'), keyboard: mainMenuKeyboard() };
}
/** Workspace submenu: list all known working directories. */
async function doWorkspace(ctx) {
    let roots;
    try {
        roots = await ctx.listWorkspaces();
    }
    catch {
        roots = ctx.workspaceRoots;
    }
    if (roots.length === 0)
        roots = [ctx.defaultCwd];
    const rows = [];
    for (const root of roots.slice(0, 15)) {
        const label = root === ctx.defaultCwd ? `${root} (当前)` : root;
        rows.push([[`🗂 ${label}`, `workspace:${label}`]]);
    }
    return {
        text: `📂 选择工作目录(当前 ${ctx.defaultCwd}):`,
        keyboard: withBack(rows),
    };
}
/** Session history submenu: list sessions (optionally switch by picking). */
async function doHistory(ctx) {
    let list;
    try {
        list = await ctx.listSessions();
    }
    catch {
        list = [];
    }
    if (list.length === 0) {
        return { text: '🗒 暂无会话记录', keyboard: mainMenuKeyboard() };
    }
    const rows = list.slice(0, 15).map(s => {
        const label = s.title || s.id.slice(0, 12);
        return [[`💬 ${label}`, `session:${s.id}`]];
    });
    return {
        text: `🗒 会话记录(${list.length} 个;点选以该会话继续):`,
        keyboard: withBack(rows),
    };
}
/** Model submenu: dynamic list of available models. */
async function doModel(ctx) {
    const current = ctx.getCurrentModel();
    let models;
    try {
        models = await ctx.listModels();
    }
    catch {
        models = [{ provider: ctx.provider, model: ctx.model }];
    }
    const rows = [];
    for (const m of models.slice(0, 15)) {
        const sel = m.provider === current.provider && m.model === current.model;
        rows.push([[
                `${sel ? '✔ ' : ''}${m.model}`,
                `model:${m.provider}:${m.model}`,
            ]]);
    }
    return {
        text: `🤖 选择模型(当前 ${current.model}):`,
        keyboard: withBack(rows),
    };
}
/** Preset (work mode) submenu: list available presets. */
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
    const rows = presets.map(p => [[p.name, `preset:${p.id}`]]);
    return {
        text: '🧭 切换工作方式(预设);将新开会话生效:',
        keyboard: withBack(rows),
    };
}
/** Bind session submenu (placeholder for now; a fuller picker comes later). */
function doBind(ctx) {
    const bound = ctx.sessions.getBound(ctx.chatId, ctx.botId);
    const text = bound !== undefined
        ? `🔗 当前绑定: ${bound.sessionId}`
        : '🔗 未绑定会话(由配置 bindings 决定;更完整的绑定选择器后续加入)';
    return { text, keyboard: mainMenuKeyboard() };
}
/** Apply a picked workspace root. */
function doWorkspacePick(data, ctx) {
    const target = data.slice('workspace:'.length);
    // Record the picked cwd for the next /new; the live session keeps its own cwd.
    ctx.store.setChat(`${ctx.botId}:${ctx.chatId}`, { cwd: target });
    return {
        text: `📁 已记录工作目录:${target}\n使用"新建会话"以新目录开启。`,
        keyboard: mainMenuKeyboard(),
    };
}
/** Apply a picked model: switch the default model selection. */
async function doModelPick(data, ctx) {
    const rest = data.slice('model:'.length);
    const sep = rest.indexOf(':');
    const provider = sep >= 0 ? rest.slice(0, sep) : ctx.provider;
    const model = sep >= 0 ? rest.slice(sep + 1) : rest;
    try {
        await ctx.setModel(provider, model);
        return { text: `✅ 已切换到模型: ${model}`, keyboard: mainMenuKeyboard() };
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
/** A picked session from the history list: show how to engage it. */
function doSessionPick(data, ctx) {
    const id = data.slice('session:'.length);
    return {
        text: `🗒 选中会话: ${id}\n直接下发节消息即可进入该会话;绑定切换用「绑定会话」。`,
        keyboard: mainMenuKeyboard(),
    };
}
