// A pinned Hermes skill-view dedup stub omits content deliberately; it does not authorize recovery.
import type { ToolCall } from '../model.js'

import { resultOf } from './detail.js'

/** Return the producer's file identity only for a settled, noncontradictory stub. */
export function unchangedSkillFile(call: ToolCall): string | undefined {
  if (call.name !== 'skill_view' || call.outcome.kind !== 'done') return undefined
  const result = resultOf(call)
  if (!result || !['success', 'status', 'dedup', 'content_returned', 'name', 'file'].every(key => Object.hasOwn(result, key))) return undefined
  if (result['success'] !== true || result['status'] !== 'unchanged' || result['dedup'] !== true || result['content_returned'] !== false) return undefined
  if (typeof result['name'] !== 'string' || !result['name'] || typeof result['file'] !== 'string' || !result['file']) return undefined
  const path = call.args['file_path']
  if (path !== undefined && path !== null && typeof path !== 'string') return undefined
  if (result['file'] !== (path || 'SKILL.md')) return undefined
  const empty = (value: unknown) => value === undefined || value === null || value === ''
  if (!empty(result['content']) || !empty(result['error'])) return undefined
  if (result['ok'] !== undefined && result['ok'] !== true) return undefined
  if (result['exit_code'] !== undefined && result['exit_code'] !== 0) return undefined
  if (['failed', 'cancelled', 'is_error', 'partial', 'truncated', 'setup_needed'].some(key => result[key] !== undefined && result[key] !== false)) return undefined
  if (result['readiness_status'] !== undefined) return undefined
  return result['file']
}
