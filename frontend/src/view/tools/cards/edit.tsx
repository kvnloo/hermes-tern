// The patch and write_file tools: omp's edit card (a diff) and write card (a new file, whole).
// Hermes' structured LSP companion is rendered here, without acquiring file-host authority.

import type { JSX } from '@stencil-hq/tern'

import { diffStats, hunks, plainDiff } from '../../../code/diff.js'
import { langOf } from '../../../code/lang.js'
import { optional } from '../../../core/assert.js'
import { plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { EditDetail, EditDiagnosticSeverity } from '../../../tools/files.js'
import { patchLintNeedsAttention } from '../../../tools/patch-lint-attention.js'
import { patchNoWriteReported, patchNoChangeSignal } from '../../../tools/patch-noop.js'
import { PATCH_CONTEXT_WARNING, patchContextWarning } from '../../../tools/patch-warning.js'
import { writeLintNeedsAttention } from '../../../tools/write-lint-attention.js'
import { v4aLintNeedsAttention } from '../../../tools/v4a-lint.js'
import { writeRefusalNeedsAttention } from '../../../tools/write-refusal.js'
import { v4aValidationFailure, v4aValidationMarker } from '../../../tools/v4a-validation.js'
import { staleWriteMarker, staleWriteRefusal } from '../../../tools/stale-write.js'
import { lspFileHref, type LspLinkContext } from '../lsp-links.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { visible } from './lsp.js'

/** The patch tool's view. */
export const patchView: ToolView<'patch'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'edit',
  step: (call, d) => v4aValidationFailure(call) ? 'Patch validation failed'
    : v4aValidationMarker(call) ? 'Patch failed'
    : patchNoWriteReported(call)
    ? (d.path ? `Patch target appears present in ${shortPath(d.path)}` : 'Patch target appears present')
    : patchNoChangeSignal(call) ? (d.path ? `Patch ${shortPath(d.path)}` : 'Patch')
    : (d.path ? `Edited ${shortPath(d.path)}` : 'Edited a file')
}

/** The write_file tool's view. */
export const writeView: ToolView<'write_file'> = {
  action: 'edit',
  card: editCard,
  hubIcon: 'write',
  step: (call, d) => writeRefusalNeedsAttention(call)
    ? (d.path ? `Write refused: ${shortPath(d.path)}` : 'Write refused')
    : staleWriteMarker(call) ? 'Write failed'
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
function lintText(text: string, limit = 2000, singleLine = false): { value: string; clipped: boolean; escaped: boolean } {
  let end = Math.min(text.length, limit)
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
  const prefix = text.slice(0, end)
  const value = Array.from(prefix, char => {
    const n = char.codePointAt(0) ?? 0
    return ((n < 32 && (singleLine || (n !== 9 && n !== 10))) || (n >= 0x7f && n <= 0x9f) || n === 0x061c || n === 0x200e || n === 0x200f ||
      (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x206f) || (n >= 0xd800 && n <= 0xdfff))
      ? `\\u${n.toString(16).padStart(4, '0')}` : char
  }).join('')
  return { value, clipped: end < text.length, escaped: value !== prefix }
}

/** V4A map keys are labels only: no link or inferred locality. */
function v4aLintNodes(d: EditDetail, call: ToolCall): JSX.Element[] {
  if (!v4aLintNeedsAttention(call) || !d.v4aLint) return []
  const rows: JSX.Element[] = []
  if (d.v4aLint.failure) {
    // A warned result may contain backend-only paths in its error. Keep the
    // producer's partial-apply qualification without exposing its raw detail.
    const failure = lintText(patchContextWarning(call)
      ? 'Apply phase failed (state may be inconsistent — run `git diff` to assess).'
      : d.v4aLint.failure)
    rows.push(<text key="v4a-failure" role="omp.tool.error" spans={[{ s: 'error', t: failure.value }]} wrap="word" />)
    if (failure.clipped) rows.push(<text key="v4a-failure-clipped" role="omp.tool.notice" text="Patch error clipped in view" />)
    if (failure.escaped) rows.push(<text key="v4a-failure-escaped" role="omp.tool.notice" text="Patch error control characters escaped in view" />)
  }
  d.v4aLint.errors.forEach(({ path, output, message }, i) => {
    const name = lintText(path, 256, true)
    const report = output ? lintText(output, 1000) : undefined
    const summary = message ? lintText(message, 1000) : undefined
    rows.push(<text key={`v4a-title-${i}`} role="omp.tool.lint" text={`Lint reported an error for ${name.value}`} wrap="word" />)
    if (summary) rows.push(<text key={`v4a-message-${i}`} role="omp.tool.lint.message" text={summary.value} wrap="word" />)
    if (report) rows.push(<text key={`v4a-output-${i}`} role="omp.tool.lint.output" text={report.value} wrap="word" />)
    if (name.clipped || summary?.clipped || report?.clipped) rows.push(<text key={`v4a-clipped-${i}`} role="omp.tool.notice" text="Lint report clipped in view" />)
    if (name.escaped || summary?.escaped || report?.escaped) rows.push(<text key={`v4a-escaped-${i}`} role="omp.tool.notice" text="Lint report control characters escaped in view" />)
  })
  if (d.v4aLint.uninspected) rows.push(<text key="v4a-uninspected" role="omp.tool.notice" text="Additional lint entries were not inspected" />)
  return rows
}

function lintNodes(d: EditDetail, call: ToolCall): JSX.Element[] {
  if ((!writeLintNeedsAttention(call) && !patchLintNeedsAttention(call)) || !d.lintError) return []
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
  const patchWarning = patchContextWarning(call)
  const path = d.path ?? (patchWarning ? undefined : call.context)
  const lang = langOf(path)
  const content = d.content
  const write = d.tool === 'write_file'
  const diagnostics = diagnosticNodes(d, context)
  const singleLint = lintNodes(d, call)
  const multiLint = v4aLintNodes(d, call)
  const lint = [...singleLint, ...multiLint]
  const lintMeta = [
    ...(multiLint.length && d.v4aLint?.failure ? ['Patch reported an error'] : []),
    ...(singleLint.length || (multiLint.length && d.v4aLint?.errors.length) ? ['Lint reported an error'] : []),
    ...(multiLint.length && d.v4aLint?.uninspected ? ['Additional lint entries were not inspected'] : [])
  ]
  const warning = patchWarning ? [<text key="patch-context-warning" role="omp.tool.notice" spans={[{ s: 'warning', t: PATCH_CONTEXT_WARNING }]} wrap="word" />] : []
  const stale = staleWriteRefusal(call)
  const refusalText = stale ? 'Hermes refused this overwrite. This write did not modify the file. Read the current contents before merging the change or use a targeted patch.' : d.writeRefusal
  const refusal = writeRefusalNeedsAttention(call) && refusalText ? lintText(refusalText) : undefined
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

  const validation = v4aValidationFailure(call)
  if (validation) {
    const reason = lintText(patchWarning ? 'Patch validation failed (no files were modified).' : validation)
    return {
      ...head,
      body: [
        <text key="validation" role="omp.tool.error" spans={[{ s: 'error', t: reason.value }]} wrap="word" />,
        ...(reason.clipped ? [<text key="validation-clipped" role="omp.tool.notice" text="Patch error clipped in view" />] : []),
        ...(reason.escaped ? [<text key="validation-escaped" role="omp.tool.notice" text="Patch error control characters escaped in view" />] : []),
        ...warning
      ],
      folded: false,
      meta: ['Patch validation failed', ...(warning.length ? ['Patch context warning'] : [])]
    }
  }

  if (patchNoWriteReported(call)) {
    const notice = 'Target text appears present; no write performed'
    return {
      ...head,
      body: [<text key="no-change" role="omp.tool.notice" spans={[{ s: 'muted', t: notice }]} />, ...warning, ...diagnostics],
      ...(warning.length ? { folded: false } : {}),
      meta: [notice, ...(warning.length ? ['Patch context warning'] : [])]
    }
  }

  // A new file is all additions: omp shows it as the file, numbered, with a badge.
  if (write && content && (!diff || diff.startsWith('@@ -0,0 '))) {
    const text = content.replace(/\n$/, '')
    const lines = text.split('\n').length

    return {
      ...head,
      badges: diff ? [{ text: 'new file', tone: 'success' }] : undefined,
      body: [...refusalNodes, ...lint, ...(refusal ? [<text key="candidate" role="omp.tool.notice" text="Candidate content; write refused" />] : []), <code key="code" lang={lang ?? 'text'} numbers text={text} />, ...diagnostics],
      folded: lint.length || refusal ? false : true,
      meta: [plural(lines, 'line'), ...(refusal ? ['Write refused'] : []), ...lintMeta],
      preview: { lines: 8 }
    }
  }

  if (!diff) {
    // The shell would otherwise show this failure as a note when the card was empty.
    // A warning row makes the card nonempty, so retain that existing error here.
    const reason = patchWarning && call.outcome.kind === 'error' && !refusalNodes.length && !lint.length && !diagnostics.length
      ? lintText('Patch failed. Inspect the target and context.') : undefined
    const failure = reason ? [
      <text key="patch-error" role="omp.tool.error" spans={[{ s: 'error', t: reason.value }]} wrap="word" />,
      ...(reason.clipped ? [<text key="patch-error-clipped" role="omp.tool.notice" text="Patch error clipped in view" />] : []),
      ...(reason.escaped ? [<text key="patch-error-escaped" role="omp.tool.notice" text="Patch error control characters escaped in view" />] : [])
    ] : []
    return { ...head, body: [...refusalNodes, ...failure, ...warning, ...lint, ...diagnostics], ...(refusal || lint.length || warning.length ? { folded: false, meta: [...(refusal ? ['Write refused'] : []), ...(warning.length ? ['Patch context warning'] : []), ...lintMeta] } : {}) }
  }

  const { added, removed } = diffStats(diff)

  return {
    ...head,
    body: [...refusalNodes, ...warning, ...lint, <diff key="diff" {...optional('lang', lang)} text={diff} />, ...diagnostics],
    ...(lint.length || refusal || warning.length ? { folded: false } : {}),
    meta: [`+${added} −${removed}`, ...(refusal ? ['Write refused'] : []), ...(warning.length ? ['Patch context warning'] : []), ...lintMeta]
  }
}
