/**
 * Telegram message formatting helpers: HTML escaping, a conservative
 * Markdown→HTML subset, and the 4096-character split Telegram enforces.
 *
 * Copied from @loserfox/telegram's format.ts (BSD-3-Clause).
 * @module core/format
 */
/**
 * Escape the characters Telegram's HTML parse mode treats specially.
 * @param text - the raw text to escape.
 * @returns the HTML-escaped text.
 */
export declare function escapeHtml(text: string): string;
/**
 * Convert a conservative Markdown subset to Telegram HTML: fenced code blocks
 * to `<pre>`, inline code to `<code>`, `**bold**` to `<b>`; everything else is
 * HTML-escaped. Unbalanced fences stay literal because a dangling `<pre>`
 * would make Telegram reject the message.
 * @param text - the markdown text to convert.
 * @returns Telegram-HTML text.
 */
export declare function markdownToHtml(text: string): string;
/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export declare function splitMessage(text: string, maxLength: number): string[];
