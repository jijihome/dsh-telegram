/**
 * Bot UI registration: the Telegram "command menu" (`setMyCommands`) and the
 * input-field menu button (`setChatMenuButton`) for one bot.
 *
 * Kept as a standalone module (no Cordis dependency) so it can be unit-tested
 * against a fake client and reused by every bot in a multi-bot deployment.
 * A registration failure is deliberately non-fatal: the bot still works via
 * `/menu` and typed commands, so we log and continue rather than abort startup.
 *
 * @module telegram/bot-commands
 */
/**
 * The command list advertised to the bot's own menu (`/` in the input field),
 * plus `/menu`/`/start`. Shared by every telegram agent this plugin drives.
 */
export const BOT_COMMANDS = [
    { command: 'start', description: '开始 / 显示主菜单' },
    { command: 'menu', description: '打开操作菜单' },
    { command: 'new', description: '开启全新会话(丢弃当前上下文)' },
    { command: 'stop', description: '取消正在运行的回合' },
    { command: 'workspace', description: '查看/切换工作目录' },
    { command: 'session', description: '查看会话绑定与状态' },
    { command: 'help', description: '命令帮助' },
];
/** Default menu-button type. Telegram only supports a command list or web_app. */
export const DEFAULT_MENU_BUTTON = { type: 'commands' };
/**
 * Register a bot's Telegram command menu (`setMyCommands`).
 * @param client - the bot's Telegram API client.
 * @param commands - commands to advertise; defaults to {@link BOT_COMMANDS}.
 */
export async function registerBotCommands(client, commands = BOT_COMMANDS) {
    const scope = { type: 'default' };
    await client.setMyCommands(commands.map(({ command, description }) => ({ command, description })), scope);
}
/**
 * Set the bot's input-field menu button (`setChatMenuButton`) to a command
 * list toggle, so Telegram shows a button beside the input field. This is the
 * closest Telegram offers to an always-visible menu entry (a real inline
 * keyboard can only be attached to a message).
 * @param client - the bot's Telegram API client.
 * @param button - the button config; defaults to `{ type: 'commands' }`.
 */
export async function registerMenuButton(client, button = DEFAULT_MENU_BUTTON) {
    // Telegram's payload shape is a flat object, not nested button + scope.
    await client.setChatMenuButton(button);
}
/**
 * Apply BOTH registrations for one bot: command menu then menu button. Runs
 * once per bot after `getMe` succeeds. Throws propagate to the caller, which
 * should log-and-continue (never abort bot startup on a UI-registration hiccup).
 * @param client - the bot's Telegram API client.
 */
export async function registerBotUi(client) {
    await registerBotCommands(client);
    await registerMenuButton(client);
}
