// A retained replace-mode patch may report syntax lint independently of its outcome.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function patchLintNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'patch' || call.outcome.kind === 'running') return false
  try {
    const detail = detailOf(call)
    return detail.tool === 'patch' && detail.lintError !== undefined
  } catch {
    // Malformed details must not interrupt unrelated transcript folds.
    return false
  }
}
