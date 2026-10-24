// The browser tool's Tern target comes from Hermes' result, never from a URL,
// transcript title, visible pane or guessed tab. Stored results may be JSON text.
import type { ToolCall } from '../model.js'
import { validBrowserId } from '../wire/browser.js'
import { record } from '../wire/json.js'

import { resultOf } from './detail.js'

export interface TernTarget {
  target_id: string
  title: string
  url: string
  frame?: string
}

/** A trustworthy identity for presentation only; it does not authorize focus or handover. */
export function ternTargetOf(call: Pick<ToolCall, 'name' | 'args' | 'result'>): TernTarget | undefined {
  if (!call.name.startsWith('browser')) {
    return undefined
  }

  const target = record(resultOf(call)?.['tern_target'])
  const id = target?.['target_id']
  const title = target?.['title']
  const url = target?.['url']
  const frame = target?.['frame']

  if (
    target?.['in_tern'] !== true || typeof id !== 'string' || !validBrowserId(id) ||
    typeof title !== 'string' || typeof url !== 'string' ||
    (frame !== undefined && frame !== null && typeof frame !== 'string')
  ) {
    return undefined
  }

  return {
    target_id: id,
    title,
    url,
    ...(typeof frame === 'string' ? { frame } : {})
  }
}
