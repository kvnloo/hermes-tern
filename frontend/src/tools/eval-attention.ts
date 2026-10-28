// Present the retained, validated stdout disclosure without changing the tool outcome.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function evalNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'execute_code' || call.outcome.kind === 'running') return false
  const detail = detailOf(call)
  return detail.tool === 'execute_code' && detail.stdoutTruncated
}
