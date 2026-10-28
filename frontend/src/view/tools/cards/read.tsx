// The read_file tool: omp's read card, the numbered lines it got.

import { langOf } from '../../../code/lang.js'
import { optional } from '../../../core/assert.js'
import type { ToolCall } from '../../../model.js'
import type { ReadDetail } from '../../../tools/files.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'
import { errorOf } from './generic.js'

/** A bounded display-only projection for errors accompanying retained output. */
function safeError(error: string): { text: string; clipped: boolean; escaped: boolean } {
  let end = Math.min(error.length, 2000)
  if (end < error.length && end > 0 && /[\uD800-\uDBFF]/.test(error[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(error[end] ?? '')) end--
  const prefix = error.slice(0, end)
  const text = Array.from(prefix, c => {
    const n = c.codePointAt(0) ?? 0
    return ((n < 32 && n !== 9 && n !== 10) || (n >= 0x7f && n <= 0x9f) || n === 0x061c || n === 0x200e || n === 0x200f ||
      (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x206f) || (n >= 0xd800 && n <= 0xdfff))
      ? `\\u${n.toString(16).padStart(4, '0')}` : c
  }).join('')
  return { text, clipped: end < error.length, escaped: text !== prefix }
}

/** The read_file tool's view. */
export const readView: ToolView<'read_file'> = {
  action: 'read',
  card: readCard,
  hubIcon: 'read',
  step: (_call, d) => (d.path ? `Read ${shortPath(d.path)}` : 'Read file')
}

/** The file's lines as read, numbered from where the read began; the range (or the whole count) as meta. */
function readCard(call: ToolCall, d: ReadDetail): Card {
  const path = d.path ?? call.context
  const content = d.content
  const total = d.totalLines
  const numbered = content ? [...content.matchAll(/^ *(\d+)\|/gm)] : []
  const first = numbered.length ? Number(numbered[0]?.[1]) : undefined
  const last = numbered.length ? Number(numbered.at(-1)?.[1]) : undefined
  const whole = first === 1 && last !== undefined && last === total
  const meta = first !== undefined && last !== undefined ? [whole ? `${total} lines` : `:${first}-${last}`] : []
  const notices = [
    ...(d.unchanged && call.outcome.kind === 'done' ? ['Unchanged; Hermes did not return file content'] : []),
    ...(d.truncated ? ['Hermes marked this read as truncated'] : []),
    ...(d.truncatedLines ? ['Some lines were clipped; their missing text may not be recoverable by offset'] : []),
    ...(d.nextOffset !== undefined ? [`Hermes continuation offset: ${d.nextOffset}`] : [])
  ]
  const error = call.outcome.kind === 'error' && (content || notices.length) ? errorOf(call) : undefined
  const failure = error ? safeError(error) : undefined

  return {
    body: [
      ...(content ? [<code key="code" {...optional('lang', langOf(path))} numbers {...optional('start', first)} text={content.replace(/^ *\d+\|/gm, '')} />] : []),
      ...notices.map((notice, i) => <text key={`read-notice-${i}`} role="omp.tool.notice" spans={[{ s: 'muted', t: notice }]} />),
      ...(failure ? [<text key="read-error" role="omp.tool.error" spans={[{ s: 'error', t: failure.text }]} />] : []),
      ...(failure?.clipped ? [<text key="read-error-clipped" role="omp.tool.notice" spans={[{ s: 'muted', t: 'Read error text clipped in view' }]} />] : []),
      ...(failure?.escaped ? [<text key="read-error-controls" role="omp.tool.notice" spans={[{ s: 'muted', t: 'Read error control characters escaped in view' }]} />] : [])
    ],
    folded: true,
    frame: 'inline',
    meta: [...meta, ...notices],
    name: 'read',
    target: path,
    targetKind: 'path',
    title: 'Read'
  }
}
