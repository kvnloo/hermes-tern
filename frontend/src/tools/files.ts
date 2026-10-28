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
  /** Only the exact no-content dedup stub, never inferred from a title or message. */
  unchanged?: true
  truncated?: true
  truncatedLines?: true
  nextOffset?: number
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
  /** A retained syntax/lint error; it does not change the tool outcome. */
  lintError?: { output: string; message?: string }
}

/** A producer's own structured error report. V4A's per-path map is not this shape. */
function lintError(result: Raw['result']): EditFields['lintError'] {
  if (!result || !Object.hasOwn(result, 'lint')) return undefined
  const lint = result['lint']
  if (!lint || typeof lint !== 'object' || Array.isArray(lint)) return undefined
  const data = record(lint)
  if (!data || !Object.hasOwn(data, 'status') || data['status'] !== 'error' ||
      !Object.hasOwn(data, 'output') || typeof data['output'] !== 'string' ||
      (Object.hasOwn(data, 'message') && typeof data['message'] !== 'string')) return undefined
  return { output: data['output'], ...optional('message', Object.hasOwn(data, 'message') ? text(data['message']) : undefined) }
}

/** Only a proven replace-mode success, never a no-op, partial result or V4A map. */
function replaceLintError({ args, result }: Raw): EditFields['lintError'] {
  if (!Object.hasOwn(args, 'path') || typeof args['path'] !== 'string' || !args['path'] ||
      !Object.hasOwn(args, 'old_string') || typeof args['old_string'] !== 'string' ||
      !Object.hasOwn(args, 'new_string') || typeof args['new_string'] !== 'string' ||
      Object.hasOwn(args, 'patch') || (Object.hasOwn(args, 'mode') && args['mode'] !== 'replace')) return undefined
  if (!result || !Object.hasOwn(result, 'success') || result['success'] !== true ||
      (Object.hasOwn(result, 'no_change') && result['no_change'] !== false) ||
      (result['error'] !== undefined && result['error'] !== null && result['error'] !== '') ||
      result['status'] !== undefined || (result['ok'] !== undefined && result['ok'] !== true) ||
      (result['exit_code'] !== undefined && result['exit_code'] !== 0) ||
      ['is_error', 'failed', 'cancelled', 'partial', 'truncated'].some(key => result[key] !== undefined && result[key] !== false) ||
      ['files_created', 'files_deleted'].some(key => result[key] !== undefined && (!Array.isArray(result[key]) || result[key].length !== 0))) return undefined
  return lintError(result)
}

/** A `patch` or `write_file` call, read once. */
export type EditDetail = (EditFields & { tool: 'patch' }) | (EditFields & { tool: 'write_file' })

export function readDetail({ args, result }: Raw): ReadDetail {
  const clearFlags = ['truncated', 'truncated_lines', 'is_binary', 'is_image', 'not_found']
    .every(key => result?.[key] === undefined || result[key] === false)
  const noPayload = ['content', 'error', 'truncated_by', 'next_offset', 'base64_content', 'mime_type', 'dimensions']
    .every(key => result !== undefined && !Object.hasOwn(result, key))
  const unchanged = result?.['status'] === 'unchanged' && result['dedup'] === true && result['content_returned'] === false &&
    clearFlags && noPayload
  const truncated = result?.['truncated'] === true
  const next = result?.['next_offset']
  const nextOffset = truncated && result?.['truncated_by'] === 'bytes' && typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : undefined
  return {
    content: text(result?.['content']),
    ...optional('nextOffset', nextOffset),
    path: text(args['path']),
    tool: 'read_file',
    totalLines: num(result?.['total_lines']),
    ...optional('truncated', truncated ? true : undefined),
    ...optional('truncatedLines', result?.['truncated_lines'] === true ? true : undefined),
    ...optional('unchanged', unchanged ? true : undefined)
  }
}

/** The parser of `patch` or `write_file`: the same fields, under either key. */
export function editDetail<T extends EditDetail['tool']>(tool: T): (raw: Raw) => EditFields & { tool: T } {
  return ({ args, result }) => ({
    content: text(args['content']),
    ...optional('diagnostics', diagnosticsOf(result?.['lsp_diagnostics_data'])),
    ...optional('diagnosticsText', text(result?.['lsp_diagnostics'])),
    ...optional('lintError', tool === 'write_file' ? lintError(result) : replaceLintError({ args, result })),
    diff: text(result?.['diff']),
    path: text(args['path']),
    tool
  })
}
