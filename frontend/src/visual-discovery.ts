// Discovery consumes successful terminal-result JSON, never prose, arguments,
// summaries, running/error results, or a filesystem scan. A notice is only a locator.
import { isAbsolute } from 'node:path'

import type { Entry, ToolCall } from './model.js'
import { parseJson, record } from './wire/json.js'

export const VISUAL_DISCOVERY_LIMITS = Object.freeze({
  entries: 128,
  blocks: 512,
  candidates: 12,
  outputChars: 8192,
  parseChars: 65536
})

export interface VisualCandidate {
  readonly id: string
  readonly path: string
  readonly scope: string
  readonly callId: string
}

/** One complete machine-readable `prepare --json` result. */
export function parseVisualCandidate(output: string, scope: string, callId: string): VisualCandidate | undefined {
  if (output.length > VISUAL_DISCOVERY_LIMITS.outputChars) {
    return undefined
  }

  const value = record(parseJson(output))

  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'id,kind,path,scope,version' ||
    value['kind'] !== 'hermes.visual.candidate' ||
    value['version'] !== 1 ||
    typeof value['id'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['id']) ||
    typeof value['scope'] !== 'string' ||
    !scope ||
    scope.length > 256 ||
    value['scope'] !== scope ||
    typeof value['path'] !== 'string' ||
    value['path'].length > 4096 ||
    !isAbsolute(value['path']) ||
    !value['path'].endsWith('.hvisual.json') ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value['path'])
  ) {
    return undefined
  }

  return Object.freeze({ id: value['id'], path: value['path'], scope, callId })
}

/** Account for both the serialized envelope and the selected output. */
function completedOutput(call: ToolCall, budget: { chars: number }): string | undefined {
  if (call.name !== 'terminal' || call.outcome.kind !== 'done') {
    return undefined
  }

  let raw: unknown = call.result

  if (typeof raw === 'string') {
    if (raw.length > VISUAL_DISCOVERY_LIMITS.outputChars || raw.length > budget.chars) {
      return undefined
    }

    budget.chars -= raw.length
    raw = parseJson(raw)
  }

  const result = record(raw)

  if (
    !result ||
    result['exit_code'] !== 0 ||
    result['error'] ||
    result['isError'] ||
    typeof result['output'] !== 'string'
  ) {
    return undefined
  }

  const output = result['output']

  if (output.length > VISUAL_DISCOVERY_LIMITS.outputChars || output.length > budget.chars) {
    return undefined
  }

  budget.chars -= output.length

  return output
}

/** Snapshot only on /visual; bounded newest-first and deduplicated. */
export function recentVisualCandidates(entries: readonly Entry[], scope: string): readonly VisualCandidate[] {
  const found: VisualCandidate[] = []
  const seen = new Set<string>()
  const budget = { chars: VISUAL_DISCOVERY_LIMITS.parseChars }
  let blocks = 0
  const first = Math.max(0, entries.length - VISUAL_DISCOVERY_LIMITS.entries)

  for (let i = entries.length - 1; i >= first; i--) {
    const entry = entries[i]

    if (entry?.kind !== 'turn') {
      continue
    }

    for (let j = entry.blocks.length - 1; j >= 0; j--) {
      if (++blocks > VISUAL_DISCOVERY_LIMITS.blocks) {
        return Object.freeze(found)
      }

      const block = entry.blocks[j]

      if (block?.kind !== 'tool') {
        continue
      }

      const output = completedOutput(block.call, budget)

      if (output === undefined) {
        continue
      }

      const candidate = parseVisualCandidate(output, scope, block.call.id)

      if (!candidate) {
        continue
      }

      const key = JSON.stringify([candidate.id, candidate.path])

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      found.push(candidate)

      if (found.length === VISUAL_DISCOVERY_LIMITS.candidates) {
        return Object.freeze(found)
      }
    }
  }

  return Object.freeze(found)
}
