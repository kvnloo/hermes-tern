// The search_files tool: omp's glob card (file names) and grep card (matches by file).

import type { JSX } from '@stencil-hq/tern'

import { langOf } from '../../../code/lang.js'
import { optional } from '../../../core/assert.js'
import { plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { SearchDetail } from '../../../tools/search.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'
import { errorOf } from './generic.js'

const DENSE_LIMIT = 4000
const FILE_LIMIT = 200

/** Cut without splitting a UTF-16 surrogate pair. */
function densePrefix(text: string): string {
  let end = Math.min(text.length, DENSE_LIMIT)
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) {
    end--
  }
  return text.slice(0, end)
}

/** Escape controls and invalid surrogates in the bounded display prefix. */
function safeDense(text: string): string {
  return Array.from(text, c => {
    const n = c.codePointAt(0) ?? 0
    return ((n < 32 && n !== 9 && n !== 10) || (n >= 0x7f && n <= 0x9f) ||
      (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) ||
      n === 0x061c || n === 0x200e || n === 0x200f || (n >= 0xd800 && n <= 0xdfff))
      ? `\\u${n.toString(16).padStart(4, '0')}` : c
  }).join('')
}

function count(n: number, lower: boolean, one: string, many?: string): string {
  return `${lower ? 'At least ' : ''}${plural(n, one, many)}`
}

function disclosures(labels: string[]): JSX.Element[] {
  return labels.map((label, i) => <text key={`search-notice-${i}`} role="omp.tool.notice" spans={[{ s: 'muted', t: label }]} />)
}

function errorNotice(call: ToolCall): JSX.Element[] {
  const error = call.outcome.kind === 'error' ? errorOf(call) : undefined
  return error ? [<text key="search-error" role="omp.tool.error" spans={[{ s: 'error', t: safeDense(densePrefix(error)) }]} />] : []
}

/** The search_files tool's view: "Searched pattern in folder". */
export const searchView: ToolView<'search_files'> = {
  action: 'code-search',
  card: searchCard,
  hubIcon: 'search',
  step: (call, d) => {
    const pattern = d.pattern ?? call.context
    const where = d.path && d.path !== '.' ? ` in ${shortPath(d.path)}` : ''

    return d.filesOnly ? `Searched files ${pattern}${where}` : `Searched ${pattern}${where}`
  }
}

/** A file search as the files it found; a content search as its matches, grouped by file. */
function searchCard(call: ToolCall, d: SearchDetail): Card {
  const pattern = d.pattern ?? call.context
  const where = d.path
  const inPath = where && where !== '.' ? ` · in ${where}` : ''
  const files = d.files

  if (files || d.filesOnly) {
    const list = (files ?? []).map(f => f.replace(/^\.\//, ''))
    const total = d.total ?? list.length
    const notices = [
      ...(d.total !== undefined && (d.totalLowerBound || d.truncated) ? [count(total, true, 'file')] : []),
      ...(d.truncated ? ['Search results truncated upstream'] : []),
      ...(list.length > FILE_LIMIT ? [`Showing ${FILE_LIMIT} of ${list.length} retained files`] : [])
    ]

    return {
      body: [...list.slice(0, FILE_LIMIT).map((f, i) => {
        const slash = f.lastIndexOf('/')

        return (
          <row key={`f${i}`} role="omp.tool.file" {...optional('title', slash > 0 ? f.slice(0, slash + 1) : undefined)}>
            <text key="p" spans={[{ s: 'path', t: slash > 0 ? f.slice(slash + 1) : f }]} />
          </row>
        )
      }), ...disclosures(notices), ...(notices.length ? errorNotice(call) : [])],
      folded: list.length > 20,
      frame: 'inline',
      meta: files ? [
        `${d.total === undefined ? `${plural(total, 'retained file')}` : count(total, d.totalLowerBound || d.truncated, 'file')}${inPath}`,
        ...(d.truncated ? ['Search results truncated upstream'] : []),
        ...(list.length > FILE_LIMIT ? [`Showing ${FILE_LIMIT} of ${list.length} retained files`] : [])
      ] : d.truncated ? ['Search results truncated upstream'] : undefined,
      name: 'glob',
      target: pattern,
      targetKind: 'pattern',
      title: 'Glob'
    }
  }

  const matches = d.matches?.length ? d.matches : undefined
  const byFile = new Map<string, { line: number; text: string }[]>()

  for (const m of matches ?? []) {
    const path = m.path.replace(/^\.\//, '')
    const list = byFile.get(path) ?? []
    list.push({ line: m.line, text: m.text })
    byFile.set(path, list)
  }

  const total = d.total ?? matches?.length ?? 0
  const body: JSX.Element[] = []
  let fileIndex = 0

  for (const [path, hits] of byFile) {
    const f = `f${fileIndex++}`
    body.push(
      <row key={f} role="omp.tool.file">
        <text key="p" spans={[{ s: 'path', t: path }]} />
        <text key="n" role="omp.tool.chip" spans={[{ t: String(hits.length) }]} />
      </row>
    )

    // Consecutive lines share one numbered block; gaps show omp's `…` row.
    let run: { line: number; text: string }[] = []
    let runIndex = 0

    const flush = () => {
      const start = run[0]?.line ?? 1

      if (runIndex > 0) {
        body.push(<text key={`${f}.g${runIndex}`} role="omp.tool.context" spans={[{ s: 'muted', t: '…' }]} />)
      }

      body.push(
        <code
          key={`${f}.c${runIndex++}`}
          {...optional('lang', langOf(path))}
          marks={run.map(h => ({ line: h.line, tone: 'accent' }))}
          numbers
          start={start}
          text={run.map(h => h.text).join('\n')}
        />
      )
      run = []
    }

    for (const hit of hits) {
      if (run.length && hit.line !== (run.at(-1)?.line ?? 0) + 1) {
        flush()
      }

      run.push(hit)
    }

    if (run.length) {
      flush()
    }
  }

  // Hermes already formats the dense form; paths and content are not safely separable here.
  // Show a bounded plain-text projection rather than guessing file/line boundaries.
  const dense = !matches ? d.matchesText : undefined
  const prefix = dense ? densePrefix(dense) : undefined
  const safe = prefix ? safeDense(prefix) : undefined
  if (dense) {
    body.push(<code key="dense" lang="text" text={safe ?? ''} />)
  }
  const notices = [
    ...(d.total !== undefined && (d.totalLowerBound || d.truncated) ? [count(total, true, 'match', 'matches')] : []),
    ...(d.truncated ? ['Search results truncated upstream'] : []),
    ...(dense && dense.length > DENSE_LIMIT ? ['Search text clipped in view'] : []),
    ...(prefix !== safe ? ['Control characters escaped in view'] : [])
  ]
  body.push(...disclosures(notices))
  if (dense || notices.length) body.push(...errorNotice(call))

  return {
    body,
    folded: total > 40,
    frame: 'inline',
    meta: [
      ...(matches ? [`${d.total === undefined ? plural(total, 'retained match', 'retained matches') : count(total, d.totalLowerBound || d.truncated, 'match', 'matches')} · ${plural(byFile.size, 'file')} shown${inPath}`]
        : dense && d.total !== undefined ? [`${count(d.total, d.totalLowerBound || d.truncated, 'match', 'matches')}${inPath}`] : []),
      ...notices.filter(n => !n.startsWith('At least '))
    ],
    name: 'grep',
    target: pattern,
    targetKind: 'pattern',
    title: 'Grep'
  }
}
