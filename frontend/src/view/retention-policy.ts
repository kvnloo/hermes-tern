/** Cold-row settlement and history boundaries; pure policy over Hermes entries.
 * Adapted from kvnloo/hermes-agent/ui-tsp and retained in the hermes-tern view layer.
 */
import type { Entry } from '../model.js'

export const RETAIN_TURNS = 20

/** A turn is cold only when it has no consequential unresolved or failed work. */
export function safeToSettle(entry: Entry): boolean {
  if (entry.kind === 'welcome') {
    return false
  }

  if (entry.kind === 'notice') {
    return entry.tone !== 'error' && entry.tone !== 'warning'
  }

  if (entry.kind === 'compaction') {
    return entry.compaction.state.status === 'done'
  }

  if (entry.kind !== 'turn') {
    return true
  }

  return entry.end.status === 'done' && !entry.warning && entry.blocks.every(block => {
    if (block.kind === 'compaction') {
      return block.compaction.state.status === 'done'
    }

    if (block.kind !== 'tool') {
      return true
    }

    return (block.call.outcome.kind === 'done' || block.call.outcome.kind === 'cancelled') &&
      (block.call.subagents ?? []).every(agent => agent.status === 'done' || agent.status === 'cancelled')
  })
}

/** A prompt stays resident until its following assistant turn safely completes. */
export function safePrompt(index: number, entries: readonly Entry[]): boolean {
  if (entries[index]?.kind !== 'user') {
    return true
  }

  for (let i = index + 1; i < entries.length; i++) {
    const next = entries[i]

    if (next?.kind === 'user') {
      return true
    }

    if (next?.kind === 'turn') {
      return safeToSettle(next)
    }
  }

  return false
}

/** Return the first entry before the newest 20 completed assistant turns. */
export function retentionBoundary(entries: readonly Entry[]): number {
  let completed = 0

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]

    if (entry?.kind === 'turn' && entry.end.status !== 'live' && ++completed === RETAIN_TURNS) {
      return entries[i - 1]?.kind === 'user' ? i - 1 : i
    }
  }

  return 0
}

