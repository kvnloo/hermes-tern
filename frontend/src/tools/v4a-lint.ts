// Retained reports are only a bounded projection of V4A's result map.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function v4aLintNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'patch' || (call.outcome.kind !== 'done' && call.outcome.kind !== 'error')) return false
  try {
    const detail = detailOf(call)
    return detail.tool === 'patch' && detail.v4aLint !== undefined &&
      (detail.v4aLint.failure ? call.outcome.kind === 'error' : call.outcome.kind === 'done')
  } catch {
    return false
  }
}
