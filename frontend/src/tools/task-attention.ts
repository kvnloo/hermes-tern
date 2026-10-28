// A retained foreground result can disclose a partial report without attributing it to a live agent.
import type { ToolCall } from '../model.js'
import { detailOf } from './detail.js'

export function taskNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'delegate_task' || call.outcome.kind !== 'done') return false
  const detail = detailOf(call)
  return detail.tool === 'delegate_task' && !detail.dispatched && !detail.failed &&
    detail.results.some(result => result?.iterationLimit)
}
