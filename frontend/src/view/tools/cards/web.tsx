// The web_search and web_extract tools: omp's web_search card (sources) and fetch card (pages).

import type { JSX } from '@stencil-hq/tern'

import { clip, plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { FetchDetail, WebSearchDetail } from '../../../tools/web.js'
import { compact } from '../../time.js'
import type { Card, ToolView } from '../types.js'
import { errorOf } from './generic.js'

const ERROR_LIMIT = 1000

/** Keep returned error text bounded and inert without splitting UTF-16 pairs. */
function safeError(error: string): { value: string; clipped: boolean; escaped: boolean } {
  let end = Math.min(error.length, ERROR_LIMIT)
  if (end < error.length && end > 0 && /[\uD800-\uDBFF]/.test(error[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(error[end] ?? '')) end--
  const prefix = error.slice(0, end)
  const value = Array.from(prefix, c => {
    const n = c.codePointAt(0) ?? 0
    return ((n < 32 && n !== 9 && n !== 10) || (n >= 0x7f && n <= 0x9f) || n === 0x061c || n === 0x200e || n === 0x200f ||
      (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x206f) || (n >= 0xd800 && n <= 0xdfff))
      ? `\\u${n.toString(16).padStart(4, '0')}` : c
  }).join('')
  return { value, clipped: end < error.length, escaped: value !== prefix }
}

function failure(key: string, reason: string, prefix: string): JSX.Element[] {
  const error = safeError(reason)
  return [
    <text key={key} role="omp.tool.error" spans={[{ s: 'error', t: `${prefix}${error.value}` }]} />,
    ...(error.clipped ? [<text key={`${key}.clip`} role="omp.tool.notice" spans={[{ s: 'muted', t: 'Error text clipped in view' }]} />] : []),
    ...(error.escaped ? [<text key={`${key}.escaped`} role="omp.tool.notice" spans={[{ s: 'muted', t: 'Error control characters escaped in view' }]} />] : [])
  ]
}

/** The web_search tool's view. */
export const webSearchView: ToolView<'web_search'> = {
  action: 'search',
  card: webSearchCard,
  hubIcon: 'web',
  step: (_call, d) => (d.query ? `Searched the web for ${d.query}` : 'Web search')
}

/** The web_extract tool's view: its step names the first page and counts the rest. */
export const fetchView: ToolView<'web_extract'> = {
  action: 'fetch',
  card: fetchCard,
  hubIcon: 'web',
  step: (_call, d) => {
    const first = d.urls[0] ?? d.url

    return first ? `Read ${first}${d.urls.length > 1 ? ` +${d.urls.length - 1} more` : ''}` : 'Read a page'
  }
}

/** A web search as the sources it found, each linked; framed once they are in. */
function webSearchCard(call: ToolCall, d: WebSearchDetail): Card {
  const hits = d.hits

  return {
    body: hits.length
      ? [
          <col key="s" role="omp.tool.sources">
            {hits.map((h, i) => sourceRow(`s${i}`, h.title ?? h.url ?? '', h.url))}
          </col>
        ]
      : [],
    frame: 'inline',
    framedWithBody: true,
    meta: hits.length ? [plural(hits.length, 'source')] : undefined,
    name: 'web_search',
    target: d.query ?? call.context,
    targetKind: 'query',
    title: 'Web search'
  }
}

/** A page fetch: each page as its linked source and its content. */
function fetchCard(call: ToolCall, d: FetchDetail): Card {
  const pages = d.pages
  const urls = d.urls.filter(u => u !== '')
  const body: JSX.Element[] = []
  const hasFailures = pages.some(p => p.error !== undefined)

  for (const [i, p] of pages.entries()) {
    if (p.title || p.url || !p.error) body.push(sourceRow(`s${i}`, p.title ?? p.url ?? '', p.url))
    const content = p.content

    if (content) {
      body.push(<md key={`b${i}`}>{clip(content, { mark: 'line', max: 4000 })}</md>)
    }
    if (p.error) body.push(...failure(`error-${i}`, p.error, 'Extraction failed: '))
  }

  const error = call.outcome.kind === 'error' && body.length ? errorOf(call) : undefined
  if (error && !pages.some(p => p.error === error)) body.push(...failure('call-error', error, ''))

  const chars = pages.reduce((n, p) => n + (p.content?.length ?? 0), 0)

  return {
    body,
    folded: !hasFailures,
    meta: pages.length ? [`${hasFailures ? plural(pages.length, 'entry', 'entries') : plural(pages.length, 'page')} · ${compact(chars)} chars`] : undefined,
    name: 'fetch',
    preview: { lines: 6 },
    target: urls.length > 1 ? `${urls[0]} +${urls.length - 1}` : (urls[0] ?? d.url ?? call.context),
    targetKind: 'path',
    title: 'Fetch'
  }
}

/** One linked source: a domain-initial chip, the linked title, the muted domain. */
function sourceRow(key: string, title: string, url: string | undefined): JSX.Element {
  let host = ''

  try {
    host = url ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }

  return (
    <row key={key} role="omp.tool.source">
      <text key="d" role="omp.tool.chip" spans={[{ t: (host.charAt(0) || '·').toUpperCase() }]} />
      <text key="t" spans={[url ? { href: url, t: title } : { t: title }]} />
      {host ? <text key="m" spans={[{ s: 'muted', t: host }]} /> : null}
    </row>
  )
}
