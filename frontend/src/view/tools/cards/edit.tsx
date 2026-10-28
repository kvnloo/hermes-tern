// The patch and write_file tools: omp's edit card (a diff) and write card (a new file, whole).
// Hermes' structured LSP companion is rendered here, without acquiring file-host authority.

import type { JSX } from '@stencil-hq/tern'

import { diffStats, hunks, plainDiff } from '../../../code/diff.js'
import { langOf } from '../../../code/lang.js'
import { optional } from '../../../core/assert.js'
import { plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { EditDetail, EditDiagnosticSeverity } from '../../../tools/files.js'
import { writeLintNeedsAttention } from '../../../tools/write-lint-attention.js'
import { writeRefusalNeedsAttention } from '../../../tools/write-refusal.js'
import { lspFileHref, type LspLinkContext } from '../lsp-links.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { visible } from './lsp.js'

/** The patch tool's view. */
export const patchView: ToolView<'patch'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'edit',
  step: (_call, d) => (d.path ? `Edited ${shortPath(d.path)}` : 'Edited a file')
}

/** The write_file tool's view. */
export const writeView: ToolView<'write_file'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'write',
  step: (call, d) => writeRefusalNeedsAttention(call)
    ? (d.path ? `Write refused: ${shortPath(d.path)}` : 'Write refused')
    : (d.path ? `Wrote ${shortPath(d.path)}` : 'Wrote a file')
}

const DIAGNOSTIC_STYLES = {
  error: { label: 'error', marker: '●', style: 'error' },
  warn: { label: 'warning', marker: '▲', style: 'warning' },
  info: { label: 'info', marker: 'ℹ', style: 'muted' },
  hint: { label: 'hint', marker: '·', style: 'dim' }
} as const satisfies Record<EditDiagnosticSeverity, { label: string; marker: string; style: string }>

const SEVERITIES = ['error', 'warn', 'info', 'hint'] as const

/** Bound untrusted lint text and escape controls without splitting UTF-16 pairs. */
function lintText(text: string): { value: string; clipped: boolean; escaped: boolean } {
  let end = Math.min(text.length, 2000)
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
  const prefix = text.slice(0, end)
  const value = Array.from(prefix, char => {
    const n = char.codePointAt(0) ?? 0
    return ((n < 32 && n !== 9 && n !== 10) || (n >= 0x7f && n <= 0x9f) || n === 0x061c || n === 0x200e || n === 0x200f ||
      (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x206f) || (n >= 0xd800 && n <= 0xdfff))
      ? `\\u${n.toString(16).padStart(4, '0')}` : char
  }).join('')
  return { value, clipped: end < text.length, escaped: value !== prefix }
}

function lintNodes(d: EditDetail, call: ToolCall): JSX.Element[] {
  if (!writeLintNeedsAttention(call) || !d.lintError) return []
  const { output, message } = d.lintError
  const report = output ? lintText(output) : undefined
  const summary = message ? lintText(message) : undefined
  return [
    <text key="lint-title" role="omp.tool.lint" spans={[{ s: 'error', t: 'Lint reported an error' }]} wrap="word" />,
    ...(summary ? [<text key="lint-message" role="omp.tool.lint.message" text={summary.value} wrap="word" />] : []),
    ...(report ? [<text key="lint-output" role="omp.tool.lint.output" text={report.value} wrap="word" />] : []),
    ...(summary?.clipped || report?.clipped ? [<text key="lint-clipped" role="omp.tool.notice" text="Lint report clipped in view" />] : []),
    ...(summary?.escaped || report?.escaped ? [<text key="lint-escaped" role="omp.tool.notice" text="Lint report control characters escaped in view" />] : [])
  ]
}

/** The native diagnostic rows are added to every edit presentation (even without a diff). */
function diagnosticNodes(d: EditDetail, context?: LspLinkContext): JSX.Element[] {
  const data = d.diagnostics

  if (!data) {
    return d.diagnosticsText
      ? [<text key="lsp-legacy" role="omp.tool.notice" spans={[{ s: 'muted', t: visible(d.diagnosticsText) }]} wrap="word" />]
      : []
  }

  const counts: Record<EditDiagnosticSeverity, number> = { error: 0, warn: 0, info: 0, hint: 0 }
  let total = 0

  for (const file of data.files) {
    for (const diagnostic of file.diagnostics) {
      counts[diagnostic.severity]++
      total++
    }
  }

  const body: JSX.Element[] = []
  const summary = SEVERITIES.filter(severity => counts[severity] > 0)
    .map(severity => counts[severity] + ' ' + DIAGNOSTIC_STYLES[severity].label +
      (counts[severity] === 1 ? '' : 's')).join(' · ')

  if (total || data.files.some(file => file.omitted > 0)) {
    body.push(
      <section key="lsp" role="omp.tool.diagnostics" head={[{ s: 'chip', t: summary || 'LSP diagnostics' }]}
        collapsed={total > 8} collapsible>
        {data.files.filter(file => file.diagnostics.length > 0 || file.omitted > 0).map((file, i) => (
          <col key={'f' + i} role="omp.tool.diagnostics.file">
            <row key="head" role="omp.tool.file">
              <text key="path" {...optional('href', lspFileHref(file.path, context))}
                spans={[{ s: 'path', t: visible(file.path) }]} />
              <text key="count" role="omp.tool.chip" text={String(file.diagnostics.length)} />
            </row>
            {file.diagnostics.map((diagnostic, j) => {
              const style = DIAGNOSTIC_STYLES[diagnostic.severity]
              const start = { col: diagnostic.col, line: diagnostic.line }
              const range = { start, end: diagnostic.end ?? start }
              const href = lspFileHref(file.path, context, range)
              const position = diagnostic.line + ':' + diagnostic.col + (diagnostic.end
                ? '–' + diagnostic.end.line + ':' + diagnostic.end.col : '')
              const message = diagnostic.message + (diagnostic.source ? ' (' + diagnostic.source + ')' : '')

              return (
                <row key={'d' + j} role="omp.tool.diagnostic" {...optional('href', href)}>
                  <text key="severity" role={'omp.tool.diagnostic.' + diagnostic.severity}
                    spans={[{ s: style.style, t: style.marker }]} title={style.label} />
                  <text key="location" {...optional('href', href)} spans={[{ s: 'muted mono', t: position }]} />
                  <text key="message" text={visible(message)} wrap="word" />
                </row>
              )
            })}
            {file.omitted > 0
              ? <text key="omitted" role="omp.tool.notice"
                  spans={[{ s: 'muted', t: file.omitted + ' additional diagnostics omitted' }]} />
              : null}
          </col>
        ))}
      </section>
    )
  }

  body.push(...data.unavailable.map((item, i) => (
    <text key={'lsp-unavailable-' + i} role="omp.tool.diagnostics.unavailable"
      spans={[{ s: 'muted', t: visible(item.path + ': ' + item.message) }]} wrap="word" />
  )))

  if (total && !context?.hostLocal) {
    body.push(<text key="lsp-locality" role="omp.tool.notice"
      spans={[{ s: 'muted', t: 'File targets are not confirmed host-local; links disabled.' }]} wrap="word" />)
  }

  return body
}

/** An edit's diff with its +/− counts; a new file as the file itself, numbered. */
function editCard(call: ToolCall, d: EditDetail, _now: number, context?: LspLinkContext): Card {
  const path = d.path ?? call.context
  const lang = langOf(path)
  const content = d.content
  const write = d.tool === 'write_file'
  const diagnostics = diagnosticNodes(d, context)
  const lint = lintNodes(d, call)
  const refusal = writeRefusalNeedsAttention(call) && d.writeRefusal ? lintText(d.writeRefusal) : undefined
  const diff = refusal ? undefined : (hunks(d.diff) ?? (call.diff ? plainDiff(call.diff) : undefined))
  const refusalNodes = refusal ? [
    <text key="write-refusal" role="omp.tool.error" spans={[{ s: 'error', t: refusal.value }]} wrap="word" />,
    ...(refusal.clipped ? [<text key="write-refusal-clipped" role="omp.tool.notice" text="Write error clipped in view" />] : []),
    ...(refusal.escaped ? [<text key="write-refusal-escaped" role="omp.tool.notice" text="Write error control characters escaped in view" />] : [])
  ] : []

  const head = {
    name: write ? 'write' : 'edit',
    target: path,
    targetKind: 'path',
    title: write ? 'Write' : 'Edit'
  } satisfies Partial<Card>

  // A new file is all additions: omp shows it as the file, numbered, with a badge.
  if (write && content && (!diff || diff.startsWith('@@ -0,0 '))) {
    const text = content.replace(/\n$/, '')
    const lines = text.split('\n').length

    return {
      ...head,
      badges: diff ? [{ text: 'new file', tone: 'success' }] : undefined,
      body: [...refusalNodes, ...lint, ...(refusal ? [<text key="candidate" role="omp.tool.notice" text="Candidate content; write refused" />] : []), <code key="code" lang={lang ?? 'text'} numbers text={text} />, ...diagnostics],
      folded: lint.length || refusal ? false : true,
      meta: [plural(lines, 'line'), ...(refusal ? ['Write refused'] : []), ...(lint.length ? ['Lint reported an error'] : [])],
      preview: { lines: 8 }
    }
  }

  if (!diff) {
    return { ...head, body: [...refusalNodes, ...lint, ...diagnostics], ...(refusal || lint.length ? { folded: false, meta: [...(refusal ? ['Write refused'] : []), ...(lint.length ? ['Lint reported an error'] : [])] } : {}) }
  }

  const { added, removed } = diffStats(diff)

  return {
    ...head,
    body: [...refusalNodes, ...lint, <diff key="diff" {...optional('lang', lang)} text={diff} />, ...diagnostics],
    ...(lint.length || refusal ? { folded: false } : {}),
    meta: [`+${added} −${removed}`, ...(refusal ? ['Write refused'] : []), ...(lint.length ? ['Lint reported an error'] : [])]
  }
}
