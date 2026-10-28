// A retained write can report a lint error independently of the write outcome.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function writeLintNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'write_file' || call.outcome.kind === 'running') return false
  try {
    const detail = detailOf(call)
    return detail.tool === 'write_file' && detail.lintError !== undefined
  } catch {
    // An invalid result must not break unrelated transcript folds.
    return false
  }
}
