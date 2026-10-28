// The file tools' details: read_file's lines, and the change patch or write_file made.

import { optional } from '../core/assert.js'
import { record } from '../wire/json.js'

import { num, type Raw, text } from './fields.js'

/** A `read_file` call, read once. */
export interface ReadDetail {
  tool: 'read_file'
  path: string | undefined
  /** The lines read, each prefixed with its number (`  12|`). */
  content: string | undefined
  /** How many lines the whole file has. */
  totalLines: number | undefined
}

/** Hermes edit companion: one-based UTF-16 locations, independent of syntax lint. */
export type EditDiagnosticSeverity = 'error' | 'warn' | 'info' | 'hint'

export interface EditDiagnostic {
  severity: EditDiagnosticSeverity
  line: number
  col: number
  message: string
  /** Present only if the producer supplied an end position. Never infer one. */
  end?: { line: number; col: number }
  source?: string
}

export interface EditDiagnostics {
  files: { path: string; diagnostics: EditDiagnostic[]; omitted: number }[]
  unavailable: { path: string; message: string }[]
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function severity(value: unknown): EditDiagnosticSeverity | undefined {
  switch (value) {
    case 'error':
    case 'warn':
    case 'info':
    case 'hint':
      return value
    default:
      return undefined
  }
}

/** All-or-nothing companion validation: malformed payloads retain legacy text. */
function diagnosticsOf(value: unknown): EditDiagnostics | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const files = new Map<string, EditDiagnostics['files'][number]>()
  const unavailable: EditDiagnostics['unavailable'] = []

  for (const candidate of value) {
    const file = record(candidate)
    const path = file?.['path']

    if (!file || typeof path !== 'string' || !path) {
      return undefined
    }

    if (file['status'] === 'unavailable' && typeof file['message'] === 'string') {
      unavailable.push({ path, message: file['message'] })
      continue
    }

    if (file['status'] !== 'ok' || !Array.isArray(file['diagnostics'])) {
      return undefined
    }

    const group: EditDiagnostics['files'][number] = files.get(path) ?? { path, diagnostics: [], omitted: 0 }

    for (const candidateRow of file['diagnostics']) {
      const row = record(candidateRow)
      const tone = severity(row?.['severity'])
      const line = row?.['line']
      const col = row?.['col']
      const message = row?.['message']

      if (!tone || !positive(line) || !positive(col) || typeof message !== 'string') {
        return undefined
      }

      const endLine = row?.['end_line']
      const endCol = row?.['end_col']
      const hasEnd = endLine !== undefined || endCol !== undefined

      if (hasEnd && (!positive(endLine) || !positive(endCol) ||
        endLine < line || (endLine === line && endCol < col))) {
        return undefined
      }

      const source = row?.['source']

      group.diagnostics.push({
        col,
        line,
        message,
        severity: tone,
        ...(hasEnd && positive(endLine) && positive(endCol) ? { end: { col: endCol, line: endLine } } : {}),
        ...(typeof source === 'string' && source ? { source } : {})
      })
    }

    const omitted = file['omitted']
    group.omitted += positive(omitted) ? omitted : 0
    files.set(path, group)
  }

  return { files: [...files.values()], unavailable }
}

interface EditFields {
  path: string | undefined
  /** The text write_file wrote. */
  content: string | undefined
  /** The unified diff the result carries. */
  diff: string | undefined
  /** Validated LSP companion; absent for malformed/legacy results. */
  diagnostics?: EditDiagnostics
  /** Original result string used only if the structured companion is missing/invalid. */
  diagnosticsText?: string
  /** A write's explicitly reported syntax/lint error; it does not change the write outcome. */
  lintError?: { output: string; message?: string }
}

/** Only the write producer's own structured error report; patch uses a different shape. */
function writeLintError(result: Raw['result']): EditFields['lintError'] {
  if (!result || !Object.hasOwn(result, 'lint')) return undefined
  const lint = result['lint']
  if (!lint || typeof lint !== 'object' || Array.isArray(lint)) return undefined
  const data = record(lint)
  if (!data || !Object.hasOwn(data, 'status') || data['status'] !== 'error' ||
      !Object.hasOwn(data, 'output') || typeof data['output'] !== 'string' ||
      (Object.hasOwn(data, 'message') && typeof data['message'] !== 'string')) return undefined
  return { output: data['output'], ...optional('message', Object.hasOwn(data, 'message') ? text(data['message']) : undefined) }
}

/** A `patch` or `write_file` call, read once. */
export type EditDetail = (EditFields & { tool: 'patch' }) | (EditFields & { tool: 'write_file' })

export function readDetail({ args, result }: Raw): ReadDetail {
  return {
    content: text(result?.['content']),
    path: text(args['path']),
    tool: 'read_file',
    totalLines: num(result?.['total_lines'])
  }
}

/** The parser of `patch` or `write_file`: the same fields, under either key. */
export function editDetail<T extends EditDetail['tool']>(tool: T): (raw: Raw) => EditFields & { tool: T } {
  return ({ args, result }) => ({
    content: text(args['content']),
    ...optional('diagnostics', diagnosticsOf(result?.['lsp_diagnostics_data'])),
    ...optional('diagnosticsText', text(result?.['lsp_diagnostics'])),
    ...optional('lintError', tool === 'write_file' ? writeLintError(result) : undefined),
    diff: text(result?.['diff']),
    path: text(args['path']),
    tool
  })
}
