// A read-only projection of the composer for OSC 52 copying.
// No editor mutation, submission or implicit clipboard success acknowledgement.

/** Full draft, or its current line at the UTF-16 caret (including empty lines). */
export function clipboardDraft(text: string, caret: number, currentLine = false): string {
  if (!currentLine) {
    return text
  }

  const cursor = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0))
  const start = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) + 1 : 0
  const end = text.indexOf('\n', cursor)

  return text.slice(start, end < 0 ? undefined : end)
}
