// Delegation ownership at the gateway event boundary. Exact IDs win; missing IDs do not
// permit a newest-call guess when several calls could own an event.

import type { SubagentEventPayload } from '@hermes/shared/gateway-events'

import type { Subagent, ToolCall } from '../model.js'
import { record } from '../wire/json.js'

import { foldEvent, type SubagentEventType } from './rows.js'

/** A delegate_task result's authoritative delegation id, when it names one. */
function resultId(call: ToolCall): string | undefined {
  const value = record(call.result)?.['delegation_id']

  return typeof value === 'string' && value ? value : undefined
}

/** The calls already containing an exact child or parent id, without relying on task order. */
function agentsWith(calls: readonly ToolCall[], id: string | null | undefined): ToolCall[] {
  return id ? calls.filter(call => call.subagents?.some(agent => agent.id === id)) : []
}

/**
 * An explicit delegation id must name a result or an already attached (including resumed)
 * child of exactly one call. With no delegation id, a unique child/parent id may prove the
 * owner; otherwise only a transcript with exactly one delegation is unambiguous. The gateway's
 * session envelope is routed by the lifecycle before this payload reaches the store.
 */
export function eventOwner(calls: readonly ToolCall[], event: SubagentEventPayload): ToolCall | undefined {
  const child = agentsWith(calls, event.subagent_id)
  const parent = agentsWith(calls, event.parent_id)

  if (child.length > 1 || parent.length > 1 || (child[0] && parent[0] && child[0] !== parent[0])) {
    return undefined
  }

  const known = child[0] ?? parent[0]
  const id = event.delegation_id

  if (id !== null && id !== undefined) {
    // An empty but explicitly supplied id is invalid, not an id-less legacy event.
    if (!id) {
      return undefined
    }

    const matching = calls.filter(call =>
      resultId(call) === id || call.subagents?.some(agent => agent.delegationId === id)
    )

    if (matching.length !== 1 || (known && matching[0] !== known)) {
      return undefined
    }

    const owner = matching[0]
    const agent = owner?.subagents?.find(a => a.id === event.subagent_id)

    // One child id cannot be silently rebound from a different nested delegation.
    return agent?.delegationId && agent.delegationId !== id ? undefined : owner
  }

  // A truly id-less legacy event: an exact child/parent identity wins, even across old turns.
  // With no such proof, never guess a newest call among overlapping delegations.
  return known ?? (calls.length === 1 ? calls[0] : undefined)
}

/** A parent link is valid only if following its ancestors does not reach this child or loop. */
function cyclicParent(agents: readonly Subagent[], childId: string, parentId: string): boolean {
  const seen = new Set([childId])
  let next: string | undefined = parentId

  while (next) {
    if (seen.has(next)) {
      return true
    }

    seen.add(next)
    next = agents.find(agent => agent.id === next)?.parentId
  }

  return false
}

/**
 * Fold a routed event and keep the identity fields that the existing row reducer does not
 * populate. Nested children stay on the owner's call; cyclic parent edges are flattened.
 */
export function foldOwnedEvent(call: ToolCall, type: SubagentEventType, event: SubagentEventPayload, at: number) {
  foldEvent(call, { at, event, type })

  const agentId = event.subagent_id ?? 'task-' + event.task_index
  const agent = call.subagents?.find(a => a.id === agentId)

  if (!agent) {
    return
  }

  const delegation = event.delegation_id || resultId(call)

  if (delegation) {
    agent.delegationId = delegation
  }

  const parentId = event.parent_id

  if (parentId) {
    if (cyclicParent(call.subagents ?? [], agent.id, parentId)) {
      delete agent.parentId
      agent.depth = 0
    } else {
      agent.parentId = parentId
      const parent = call.subagents?.find(a => a.id === parentId)
      const reported = event.depth
      agent.depth = parent
        ? (parent.depth ?? 0) + 1
        : typeof reported === 'number' && Number.isSafeInteger(reported) && reported > 0 ? reported : 1
    }
  } else if (typeof event.depth === 'number' && Number.isSafeInteger(event.depth) && event.depth >= 0) {
    agent.depth = event.depth
  }
}
