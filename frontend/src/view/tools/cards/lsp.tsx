// Native LSP result card ported from Hermes ui-tsp/src/view/lsp-diagnostics.tsx.
// Tern's typed tree/spans and node roles are from Can Bölük / Stencil's MIT SDK.
// This is presentation only: it does not add a model tool or make an LSP RPC.

import { stripVTControlCharacters } from 'node:util'

import type { JSX, TreeItem } from '@stencil-hq/tern'

import { plural } from '../../../core/text.js'
import type { ToolCall } from '../../../model.js'
import type { LspDetail, LspLocation, LspRange, LspResult, LspSymbol } from '../../../tools/lsp-result.js'
import { lspFileHref, type LspLinkContext } from '../lsp-links.js'
import { shortPath } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { fallbackView } from './generic.js'

/** Presented when the frame cannot prove the file-host identity. */
const LOCAL_LINK_NOTICE = 'File targets are not confirmed host-local; links disabled.'

/** Keep wrapping whitespace, but render terminal controls and bidi overrides as visible escapes. */
function visible(text: string): string {
  // eslint-disable-next-line no-control-regex -- these are control characters intentionally made visible
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}

function rangeText(span: LspRange): string {
  return span.start.line + ':' + span.start.col + '–' + span.end.line + ':' + span.end.col
}

function symbolItem(symbol: LspSymbol, context?: LspLinkContext): TreeItem {
  const href = lspFileHref(symbol.location.path, context, symbol.selection)

  return {
    id: symbol.id,
    label: [
      { s: 'accent', t: visible(symbol.name), ...(href ? { href } : {}) },
      { s: 'muted', t: ' · kind ' + symbol.kind + ' · ' + symbol.selection.start.line + ':' + symbol.selection.start.col }
    ],
    open: true,
    children: symbol.children.map(child => symbolItem(child, context))
  }
}

/** A separate wrapping row retains each symbol's complete source and selection metadata. */
function symbolLocations(symbols: LspSymbol[], context?: LspLinkContext): JSX.Element[] {
  return symbols.flatMap(symbol => [
    <text
      key={'s' + symbol.id}
      href={lspFileHref(symbol.location.path, context, symbol.selection)}
      role="omp.tool.symbol.location"
      text={visible(symbol.name + ' · ' + symbol.location.path + ' · ' + rangeText(symbol.location.range) +
        ' · selection ' + rangeText(symbol.selection))}
      wrap="word"
    />,
    ...symbolLocations(symbol.children, context)
  ])
}

/** File-grouped results, without guessing at file links when a gateway may be remote. */
function references(locations: LspLocation[], context?: LspLinkContext): JSX.Element[] {
  const groups = new Map<string, LspLocation[]>()

  for (const location of locations) {
    const existing = groups.get(location.path) ?? []
    existing.push(location)
    groups.set(location.path, existing)
  }

  return [
    <text
      key="summary"
      role="omp.tool.lsp.summary"
      text={locations.length ? plural(locations.length, 'reference') + ' · ' + plural(groups.size, 'file') : 'No references found (checked)'}
      wrap="word"
    />,
    ...[...groups].map(([path, items], i) => (
      <col key={'f' + i} role="omp.tool.references.file">
        <text key="path" href={lspFileHref(path, context)} role="omp.tool.file" text={visible(path + ' · ' + items.length)} wrap="word" />
        {items.map((item, j) => (
          <text key={'r' + j} href={lspFileHref(path, context, item.range)} role="omp.tool.reference" text={rangeText(item.range)} wrap="word" />
        ))}
      </col>
    ))
  ]
}

function resultBody(result: LspResult, context?: LspLinkContext): JSX.Element[] {
  const body: JSX.Element[] = [
    <text key="path" href={lspFileHref(result.path, context)} role="omp.tool.file" text={visible(result.path)} wrap="word" />,
    <text
      key="server"
      role="omp.tool.context"
      text={'Server: ' + visible(result.server ?? 'unavailable') + ' · UTF-16 positions'}
      wrap="word"
    />
  ]

  switch (result.kind) {
    case 'references':
      body.push(...references(result.locations, context))
      break

    case 'symbols':
      if (result.symbols.length) {
        body.push(
          <col key="symbols">
            <tree key="tree" nodes={result.symbols.map(symbol => symbolItem(symbol, context))} role="omp.tool.symbols" />
            {symbolLocations(result.symbols, context)}
          </col>
        )
      } else {
        body.push(<text key="empty" role="omp.tool.lsp.summary" text="No symbols found (checked)" wrap="word" />)
      }
      break

    case 'hover':
      if (result.range) {
        body.push(
          <text key="range" href={lspFileHref(result.path, context, result.range)} role="omp.tool.hover.range" text={rangeText(result.range)} wrap="word" />
        )
      }

      body.push(...result.contents.map((content, i) => {
        const text = visible(content.text)

        switch (content.format) {
          case 'markdown':
            return <md key={'h' + i} role="omp.tool.hover" text={text} />

          case 'code':
            return <code key={'h' + i} role="omp.tool.hover" text={text} wrap
              {...(content.language ? { lang: content.language } : {})} />

          case 'plaintext':
            return <text key={'h' + i} role="omp.tool.hover" text={text} wrap="word" />
        }
      }))

      if (!result.contents.length) {
        body.push(<text key="empty" role="omp.tool.lsp.summary" text="No hover information (checked)" wrap="word" />)
      }
      break

    case 'error':
    case 'unavailable':
      body.push(
        <text key="failure" role={'omp.tool.lsp.' + result.kind}
          text={visible(result.operation + ': ' + result.message)}
          tone={result.kind === 'error' ? 'error' : 'muted'} wrap="word" />
      )
      break
  }

  if (!context?.hostLocal) {
    body.push(<text key="locality" role="omp.tool.notice" spans={[{ s: 'muted', t: LOCAL_LINK_NOTICE }]} wrap="word" />)
  }

  return body
}

function lspCard(call: ToolCall, d: LspDetail, now: number, context?: LspLinkContext): Card {
  const result = d.result

  if (!result) {
    // Old results and malformed envelopes are never misrepresented as checked-empty.
    return fallbackView(call).card(now)
  }

  const card: Card = { body: resultBody(result, context), folded: false, name: 'lsp', title: 'LSP' }

  if (result.kind === 'error') {
    card.status = 'error'
  }

  return card
}

/** Only the stored tool named lsp is handled; no gateway command or tool is registered. */
export const lspView: ToolView<'lsp'> = {
  action: 'code-search',
  card: lspCard,
  hubIcon: 'search',
  step: (_call, d) => {
    const result = d.result
    const operation = result
      ? result.kind === 'error' || result.kind === 'unavailable' ? result.operation : result.kind
      : d.operation
    const path = result?.path ?? d.path

    return 'LSP' + (operation ? ' ' + operation : '') + (path ? ' ' + shortPath(path) : '')
  }
}
