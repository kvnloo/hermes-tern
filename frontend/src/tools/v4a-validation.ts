// A pinned V4A preflight refusal is not an edit and carries its own reason.
import type { ToolCall } from '../model.js'
import { resultOf } from './detail.js'

const PREFIX = 'Patch validation failed (no files were modified):\n'

/** Even a contradictory result with this marker is a failed patch, not proof of an edit. */
export function v4aValidationMarker(call: ToolCall): boolean {
  if (call.name !== 'patch' || call.outcome.kind !== 'error') return false
  try {
    const r = resultOf(call)
    return Boolean(r && Object.hasOwn(r, 'error') && typeof r['error'] === 'string' && r['error'].startsWith(PREFIX))
  } catch {
    return false
  }
}

/** Recognize only an uncontradicted pinned producer result for the failed call. */
export function v4aValidationFailure(call: ToolCall): string | undefined {
  if (!v4aValidationMarker(call) || call.diff) return undefined
  try {
    const args = call.args
    if (!Object.hasOwn(args, 'mode') || args['mode'] !== 'patch' || !Object.hasOwn(args, 'patch') ||
        typeof args['patch'] !== 'string' || !args['patch']) return undefined
    const r = resultOf(call)
    if (!r || !Object.hasOwn(r, 'success') || r['success'] !== false || !Object.hasOwn(r, 'error') ||
        typeof r['error'] !== 'string' || !r['error'].startsWith(PREFIX) || !r['error'].slice(PREFIX.length).trim()) return undefined
    const empty = (value: unknown) => value === undefined || value === null || value === ''
    const noChanges = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0)
    if (!empty(r['diff']) || !noChanges(r['files_modified']) || !noChanges(r['files_created']) || !noChanges(r['files_deleted']) ||
        (Object.hasOwn(r, 'no_change') && r['no_change'] !== false) ||
        !empty(r['lint']) || !empty(r['lsp_diagnostics']) || !empty(r['lsp_diagnostics_data']) ||
        ['status', 'ok', 'exit_code', 'is_error', 'failed', 'cancelled', 'partial', 'truncated'].some(key => r[key] !== undefined)) return undefined
    return r['error']
  } catch {
    // The attention probe must not break the surrounding transcript.
    return undefined
  }
}
