/**
 * Host default model: read the deployment's chosen model the same way the GUI
 * persists it — `agent-default-model` in `<DSH_HOME>/settings.yaml`.
 *
 * Why the file and not the `agentDefaultModel` service: during plugin activation
 * the service can still report its built-in default (it had returned
 * `deepseek-official/deepseek-v4-flash` while the configured, working selection
 * was `command-code/...`), which silently pointed every bot at the wrong
 * provider. The settings file is the persisted truth the GUI model picker writes.
 *
 * Reading it is read-only; the plugin never writes the host-global selection.
 *
 * @module core/host-default-model
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Resolve the DSH home directory the same way the rest of the plugin does. */
export function resolveDshHome(fallback) {
    return process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? fallback;
}
/**
 * Read the deployment default model from `<dshHome>/settings.yaml`.
 *
 * @param dshHome - DSH home directory (holds `settings.yaml`).
 * @returns the configured selection, or undefined when absent/unreadable.
 */
export function readHostDefaultModel(dshHome) {
    try {
        return parseAgentDefaultModel(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Strip one layer of matching quotes from a scalar. */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
/**
 * Parse the top-level `agent-default-model:` block for its `provider`/`model`
 * children. Deliberately minimal (no YAML dependency): the block is a flat map
 * of scalars, and the scan stops at the next top-level key.
 *
 * @param text - `settings.yaml` contents.
 * @returns the selection when both fields are present, else undefined.
 */
export function parseAgentDefaultModel(text) {
    let inBlock = false;
    let provider;
    let model;
    for (const line of text.split(/\r?\n/)) {
        if (/^agent-default-model:\s*$/.test(line)) {
            inBlock = true;
            continue;
        }
        if (!inBlock)
            continue;
        // Any non-indented line ends the block (next top-level key or comment).
        if (/^\S/.test(line))
            break;
        const match = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (match === null)
            continue;
        const value = unquote(match[2] ?? '');
        if (value === '')
            continue;
        if (match[1] === 'provider')
            provider = value;
        else if (match[1] === 'model')
            model = value;
    }
    if (provider === undefined || model === undefined)
        return undefined;
    return { provider, model };
}
