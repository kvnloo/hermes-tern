// A returned web extraction can contain failed entries while the owning call is done.
// This is a presentation boundary only; it never changes the gateway outcome.
import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'

import { resultOf } from './detail.js'

export function webExtractNeedsAttention(call: ToolCall): boolean {
  if (call.name !== 'web_extract' || call.outcome.kind !== 'done') return false
  const entries = resultOf(call)?.['results']
  if (!Array.isArray(entries)) return false
  return entries.some(entry => {
    // Match the Fetch parser's record() boundary, including JSON-string entries it accepts.
    const error = record(entry)?.['error']
    return typeof error === 'string' && /\S/.test(error)
  })
}
