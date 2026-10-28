// Retained reports are only a bounded projection of V4A's successful result map.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function v4aLintNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'patch' || call.outcome.kind !== 'done') return false
  try {
    const detail = detailOf(call)
    return detail.tool === 'patch' && detail.v4aLint !== undefined
  } catch {
    return false
  }
}
