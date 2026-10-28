import type { ToolCall } from '../model.js'
import { resultOf } from './detail.js'

/** A retained producer warning is historical context, not a patch outcome. */
export function patchContextWarning(call: ToolCall): boolean {
  if (call.name !== 'patch' || (call.outcome.kind !== 'done' && call.outcome.kind !== 'error')) return false
  try {
    const result = resultOf(call)
    if (!result || !Object.hasOwn(result, '_warning')) return false
    const warning = result['_warning']
    return typeof warning === 'string' && warning.trim().length > 0
  } catch {
    // Malformed retained results must not break the completed work view.
    return false
  }
}

export const PATCH_CONTEXT_WARNING = 'Hermes reported a warning about the patch context. Inspect the target and context.'
