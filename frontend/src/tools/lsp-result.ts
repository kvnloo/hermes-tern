// Semantic LSP result boundary adapted from Hermes ui-tsp/src/lsp-result.ts
// (kvnloo/hermes-agent, preview/tern-frontend). The structured payload belongs to
// Hermes; no LSP protocol replies are inferred from free-form model/tool prose.

import { record } from '../wire/json.js'

import type { Raw } from './fields.js'

export interface LspPosition {
  line: number
  col: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  path: string
  range: LspRange
}

export interface LspSymbol {
  id: string
  name: string
  kind: number
  location: LspLocation
  selection: LspRange
  children: LspSymbol[]
}

export interface LspHoverContent {
  format: 'code' | 'markdown' | 'plaintext'
  text: string
  language: string | null
}

export type LspOperation = 'references' | 'symbols' | 'hover'

interface LspBase {
  path: string
  server: string | null
  position_encoding: 'utf-16'
}

export type LspResult =
  | (LspBase & { kind: 'references'; locations: LspLocation[] })
  | (LspBase & { kind: 'symbols'; symbols: LspSymbol[] })
  | (LspBase & { kind: 'hover'; contents: LspHoverContent[]; range: LspRange | null })
  | (LspBase & { kind: 'error' | 'unavailable'; operation: LspOperation; message: string })

export interface LspDetail {
  tool: 'lsp'
  result: LspResult | undefined
  operation: LspOperation | undefined
  path: string | undefined
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function operation(value: unknown): value is LspOperation {
  return value === 'references' || value === 'symbols' || value === 'hover'
}

function range(value: unknown): LspRange | undefined {
  const row = record(value)
  const start = record(row?.['start'])
  const end = record(row?.['end'])

  if (!start || !end || !positive(start['line']) || !positive(start['col']) ||
      !positive(end['line']) || !positive(end['col']) ||
      end['line'] < start['line'] ||
      (end['line'] === start['line'] && end['col'] < start['col'])) {
    return undefined
  }

  return {
    start: { line: start['line'], col: start['col'] },
    end: { line: end['line'], col: end['col'] }
  }
}

function location(value: unknown): LspLocation | undefined {
  const row = record(value)
  const span = range(row?.['range'])
  const path = row?.['path']

  return typeof path === 'string' && span ? { path, range: span } : undefined
}

function parsedArray<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const out: T[] = []

  for (const item of value) {
    const parsed = parse(item)

    if (parsed === undefined) {
      return undefined
    }

    out.push(parsed)
  }

  return out
}

function symbols(value: unknown, seen: Set<string>, depth = 0): LspSymbol[] | undefined {
  if (depth > 128 || !Array.isArray(value)) {
    return undefined
  }

  const out: LspSymbol[] = []

  for (const item of value) {
    const row = record(item)
    const id = row?.['id']
    const name = row?.['name']
    const kind = row?.['kind']
    const target = location(row?.['location'])
    const selection = range(row?.['selection'])

    if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string' ||
        !positive(kind) || kind > 26 || !target || !selection) {
      return undefined
    }

    seen.add(id)
    const children = symbols(row?.['children'], seen, depth + 1)

    if (!children) {
      return undefined
    }

    out.push({ id, name, kind, location: target, selection, children })
  }

  return out
}

function hoverContent(value: unknown): LspHoverContent | undefined {
  const row = record(value)
  const format = row?.['format']
  const text = row?.['text']
  const language = row?.['language']

  if ((format !== 'markdown' && format !== 'plaintext' && format !== 'code') ||
      typeof text !== 'string' ||
      (language !== null && language !== undefined && typeof language !== 'string')) {
    return undefined
  }

  return { format, text, language: language ?? null }
}

/** Return undefined for any malformed/legacy result; a generic card retains its literal data. */
export function parseLspResult(value: unknown): LspResult | undefined {
  const row = record(value)
  const path = row?.['path']
  const server = row?.['server']

  if (!row || typeof path !== 'string' || (server !== null && typeof server !== 'string') ||
      row['position_encoding'] !== 'utf-16') {
    return undefined
  }

  const base = { path, server, position_encoding: 'utf-16' as const }

  switch (row['kind']) {
    case 'references': {
      const locations = parsedArray(row['locations'], location)

      return locations ? { ...base, kind: 'references', locations } : undefined
    }

    case 'symbols': {
      const result = symbols(row['symbols'], new Set())

      return result ? { ...base, kind: 'symbols', symbols: result } : undefined
    }

    case 'hover': {
      const contents = parsedArray(row['contents'], hoverContent)
      const span = row['range'] === null ? null : range(row['range'])

      return contents && span !== undefined ? { ...base, kind: 'hover', contents, range: span } : undefined
    }

    case 'error':
    case 'unavailable': {
      const requested = row['operation']
      const message = row['message']

      return operation(requested) && typeof message === 'string'
        ? { ...base, kind: row['kind'], operation: requested, message }
        : undefined
    }

    default:
      return undefined
  }
}

/** One parse per call, via tools/detail.ts. Stored JSON text and live objects follow this path. */
export function lspDetail({ args, result }: Raw): LspDetail {
  const requested = args['operation']
  const path = args['path']

  return {
    tool: 'lsp',
    result: parseLspResult(result?.['lsp_result']),
    operation: operation(requested) ? requested : undefined,
    path: typeof path === 'string' ? path : undefined
  }
}
