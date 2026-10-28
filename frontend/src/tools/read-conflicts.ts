import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'

/** Hermes counts possible marker pairs in returned content, not verified conflicts. */
export function readConflictCount(call: ToolCall): number | undefined {
  if (call.name !== 'read_file' || call.outcome.kind !== 'done') return undefined
  try {
    const result = record(call.result)
    if (!result || !Object.hasOwn(result, 'conflict_blocks') || !Object.hasOwn(result, 'content')) return undefined
    const count = result['conflict_blocks']
    const content = result['content']
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0 || typeof content !== 'string' || !content) return undefined
    if (result['error'] || result['success'] === false || result['status'] === 'unchanged' || result['content_returned'] === false) return undefined
    if (['is_binary', 'is_image', 'not_found'].some(key => result[key] !== undefined && result[key] !== false)) return undefined
    return count
  } catch {
    return undefined
  }
}

export function readConflictNotice(count: number): string {
  return `Hermes reported ${count} possible conflict marker ${count === 1 ? 'pair' : 'pairs'} in returned content`
}
