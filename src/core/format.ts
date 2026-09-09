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
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Convert inline Markdown (inline code, **bold**) to Telegram HTML.
 * Fenced blocks are handled by {@link markdownToHtml}; this function only
 * runs on non-fence segments.
 */
function inlineToHtml(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  return html
}

/**
 * Convert a conservative Markdown subset to Telegram HTML: fenced code blocks
 * to `<pre>`, inline code to `<code>`, `**bold**` to `<b>`; everything else is
 * HTML-escaped. Unbalanced fences stay literal because a dangling `<pre>`
 * would make Telegram reject the message.
 * @param text - the markdown text to convert.
 * @returns Telegram-HTML text.
 */
export function markdownToHtml(text: string): string {
  const parts = text.split(/```[\w-]*/)
  // An even part count means an odd number of fences: unbalanced, keep literal.
  if (parts.length % 2 === 0) return inlineToHtml(text)
  let html = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = (parts[i] as string).replace(/^\n/, '').replace(/\n$/, '')
      html += `<pre>${escapeHtml(code)}</pre>`
    } else {
      html += inlineToHtml(parts[i] as string)
    }
  }
  return html
}

/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength)
    const newline = window.lastIndexOf('\n')
    const ideographic = window.lastIndexOf('。')
    const sentence = window.lastIndexOf('. ')
    const breakAt = Math.max(newline, ideographic, sentence)
    // A period-space break keeps its space; newline and ideographic breaks
    // cut right after the break character. Break at position zero or a full
    // window falls back to the hard limit.
    const cut = breakAt > 0 ? (breakAt === sentence ? breakAt + 2 : breakAt + 1) : maxLength
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  // The loop leaves a non-empty remainder of at most maxLength characters.
  chunks.push(rest)
  return chunks
}