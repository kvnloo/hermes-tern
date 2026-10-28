import type { ToolCall } from '../model.js'
import { resultOf } from './detail.js'

/** A retained producer warning is historical context, not a write outcome. */
function contextWarning(call: ToolCall, name: 'patch' | 'write_file'): boolean {
  if (call.name !== name || (call.outcome.kind !== 'done' && call.outcome.kind !== 'error')) return false
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

export function patchContextWarning(call: ToolCall): boolean {
  return contextWarning(call, 'patch')
}

export function writeContextWarning(call: ToolCall): boolean {
  return contextWarning(call, 'write_file')
}

export const PATCH_CONTEXT_WARNING = 'Hermes reported a warning about the patch context. Inspect the target and context.'
export const WRITE_CONTEXT_WARNING = 'Hermes reported a warning about the write context. Inspect the target and context.'
