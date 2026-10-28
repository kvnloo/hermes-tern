// Hermes can explicitly report a successful already-applied patch without writing.
import type { ToolCall } from '../model.js'

import { resultOf } from './detail.js'

/** A no-change signal may be contradictory; its presence alone does not prove a no-op. */
export function patchNoChangeSignal(call: ToolCall): boolean {
  if (call.name !== 'patch') return false
  const result = resultOf(call)
  return result !== undefined && Object.hasOwn(result, 'no_change') && result['no_change'] === true
}

export function patchNoWriteReported(call: ToolCall): boolean {
  if (call.name !== 'patch' || call.outcome.kind !== 'done') return false
  const result = resultOf(call)
  if (!result || !Object.hasOwn(result, 'success') || !Object.hasOwn(result, 'no_change') || result['success'] !== true || result['no_change'] !== true) return false
  const empty = (value: unknown) => value === undefined || value === null || value === ''
  const noChanges = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0)
  return empty(result['error']) && empty(result['diff']) && empty(call.diff) &&
    noChanges(result['files_created']) && noChanges(result['files_deleted']) &&
    result['status'] === undefined && (result['ok'] === undefined || result['ok'] === true) &&
    (result['exit_code'] === undefined || result['exit_code'] === 0) &&
    (result['is_error'] === undefined || result['is_error'] === false) &&
    (result['failed'] === undefined || result['failed'] === false) &&
    (result['cancelled'] === undefined || result['cancelled'] === false) &&
    (result['partial'] === undefined || result['partial'] === false) &&
    (result['truncated'] === undefined || result['truncated'] === false)
}
