// A retained historical report, not evidence of a currently pending or applied write.
import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'

const STAGED_KEYS = new Set(['success', 'staged', 'pending_id', 'message', 'proposal_staged'])

export function memoryStagingReported(call: ToolCall): boolean {
  if (call.name !== 'memory' || call.outcome.kind !== 'done') return false
  try {
    const result = record(call.result)
    if (!result || Object.keys(result).some(key => !STAGED_KEYS.has(key))) return false
    return Object.hasOwn(result, 'success') && result['success'] === true &&
      Object.hasOwn(result, 'staged') && result['staged'] === true &&
      Object.hasOwn(result, 'pending_id') && typeof result['pending_id'] === 'string' && /^[0-9a-f]{8}$/.test(result['pending_id']) &&
      Object.hasOwn(result, 'message') && typeof result['message'] === 'string' &&
      (!Object.hasOwn(result, 'proposal_staged') || result['proposal_staged'] === true)
  } catch {
    return false
  }
}
