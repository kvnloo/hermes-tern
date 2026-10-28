// A producer-reported fail-closed write is not a completed write.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'
import { staleWriteRefusal } from './stale-write.js'

/** Shared by the card and any visibility policy; neither changes the outcome. */
export function writeRefusalNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'write_file' || call.outcome.kind !== 'error') return false
  if (staleWriteRefusal(call)) return true
  try {
    const detail = detailOf(call)
    return detail.tool === 'write_file' && detail.writeRefusal !== undefined
  } catch {
    return false
  }
}
