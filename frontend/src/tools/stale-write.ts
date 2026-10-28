// Recognize the pinned stale-overwrite guard without displaying backend paths.
import type { ToolCall } from '../model.js'
import { resultOf } from './detail.js'

/** A conflicting report still cannot establish that this write succeeded. */
export function staleWriteMarker(call: ToolCall): boolean {
  if (call.name !== 'write_file' || call.outcome.kind !== 'error') return false
  try {
    const r = resultOf(call)
    return Boolean(r && Object.hasOwn(r, 'stale_write_blocked') && r['stale_write_blocked'] === true)
  } catch {
    return false
  }
}

export function staleWriteRefusal(call: ToolCall): boolean {
  if (!staleWriteMarker(call)) return false
  try {
    const a = call.args
    const r = resultOf(call)
    if (!r || !Object.hasOwn(a, 'path') || typeof a['path'] !== 'string' || !a['path'] ||
        !Object.hasOwn(a, 'content') || typeof a['content'] !== 'string' ||
        !Object.hasOwn(r, 'path') || r['path'] !== a['path'] ||
        !Object.hasOwn(r, 'stale_write_blocked') || r['stale_write_blocked'] !== true ||
        !Object.hasOwn(r, 'error') || typeof r['error'] !== 'string') return false
    const prefix = `Refusing to overwrite ${a['path']}: `
    const suffix = ' The file was NOT modified. Reload the current contents with read_file (every page, for a file that needs offset/limit), merge the requested change, then call write_file again. For small edits, prefer patch so existing unrelated changes are preserved.'
    if (!r['error'].startsWith(prefix) || !r['error'].endsWith(suffix) ||
        !r['error'].slice(prefix.length, -suffix.length).trim()) return false
    if (Object.hasOwn(r, 'resolved_path') && typeof r['resolved_path'] !== 'string') return false
    return !['verified', 'diff', 'status', 'success', 'no_change', 'bytes_written', 'dirs_created',
      'files_modified', 'files_created', 'files_deleted', 'lint', 'lsp_diagnostics', 'lsp_diagnostics_data',
      'partial', 'truncated', 'is_error', 'failed', 'cancelled'].some(key => r[key] !== undefined)
  } catch {
    return false
  }
}
