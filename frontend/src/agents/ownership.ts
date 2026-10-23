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

/** One exact child identity in a particular delegate_task call. */
interface OwnedRow {
  call: ToolCall
  agent: Subagent
}

/** Count rows, not just calls: duplicate child or parent ids are ambiguous even within a card. */
function agentsWith(calls: readonly ToolCall[], id: string | null | undefined): OwnedRow[] {
  return id
    ? calls.flatMap(call => (call.subagents ?? []).filter(agent => agent.id === id).map(agent => ({ call, agent })))
    : []
}

/**
 * A new nested batch can only inherit an already verified parent's call. Walk the exact
 * ancestry to a dispatched top-level group or an attached resumed root. Orphans, cycles,
 * ambiguous ancestors and rows whose reported depths disagree cannot establish authority.
 */
function trustedParentChain(calls: readonly ToolCall[], owner: ToolCall, parent: Subagent): boolean {
  const seen = new Set<string>()
  let current = parent

  while (true) {
    if (!current.id || !current.delegationId || seen.has(current.id)) {
      return false
    }

    seen.add(current.id)

    if (!current.parentId) {
      if (current.depth !== undefined && current.depth !== 0) {
        return false
      }

      const dispatch = resultId(owner)

      if (dispatch ? dispatch !== current.delegationId : owner.result !== undefined) {
        return false
      }

      // A root whose batch also belongs to another call cannot authorize descendants.
      return calls.filter(call =>
        resultId(call) === current.delegationId ||
        call.subagents?.some(agent => agent.delegationId === current.delegationId)
      ).length === 1
    }

    const ancestors = agentsWith(calls, current.parentId)
    const ancestorRow = ancestors[0]

    if (ancestors.length !== 1 || !ancestorRow || ancestorRow.call !== owner) {
      return false
    }

    const ancestor = ancestorRow.agent

    if (current.depth !== undefined && ancestor.depth !== undefined && current.depth !== ancestor.depth + 1) {
      return false
    }

    current = ancestor
  }
}

/**
 * A known explicit delegation id must have exactly one result/attached-row owner.
 * A previously unseen id may establish a NESTED batch for a fresh child (or one
 * id-less child already anchored to that exact parent) with a trustworthy chain.
 * The first accepted explicit batch event records that id
 * for independent routing of every subsequent event, even with no parent hint.
 * Truly id-less legacy events keep their prior unique-identity/sole-call fallback.
 */
export function eventOwner(calls: readonly ToolCall[], event: SubagentEventPayload): ToolCall | undefined {
  const child = agentsWith(calls, event.subagent_id)
  const parent = agentsWith(calls, event.parent_id)

  if (
    child.length > 1 || parent.length > 1 ||
    (child[0] && parent[0] && child[0].call !== parent[0].call) ||
    // A supplied foreign parent is never a hint. Self-parent events retain the
    // reducer's existing cycle-flattening behavior for an otherwise known batch.
    (event.parent_id && !parent.length && event.parent_id !== event.subagent_id)
  ) {
    return undefined
  }

  const known = child[0]?.call ?? parent[0]?.call
  const id = event.delegation_id

  if (id !== null && id !== undefined) {
    if (typeof id !== 'string' || !id) {
      return undefined
    }

    const matching = calls.filter(call =>
      resultId(call) === id || call.subagents?.some(agent => agent.delegationId === id)
    )

    if (matching.length === 1) {
      const owner = matching[0]

      if (!owner || (known && owner !== known) ||
        (child[0]?.agent.delegationId && child[0].agent.delegationId !== id)) {
        return undefined
      }

      // A nested delegation belongs to one parent agent, even if the enclosing
      // card hosts multiple nested batches. Reusing its id with another parent
      // cannot silently claim a different child or branch.
      if (id !== resultId(owner)) {
        const parents = new Set(
          (owner.subagents ?? []).filter(agent => agent.delegationId === id && agent.parentId)
            .map(agent => agent.parentId)
        )

        if (parents.size > 1 || (event.parent_id && parents.size > 0 && !parents.has(event.parent_id)) ||
          (child[0]?.agent.parentId && parents.size > 0 && !parents.has(child[0].agent.parentId)) ||
          (child[0]?.agent.parentId && event.parent_id && child[0].agent.parentId !== event.parent_id)) {
          return undefined
        }
      }

      return owner
    }

    // A genuinely new child can bind here. So can an id-less event's existing
    // nested row, but only if it has NO delegation yet and the SAME exact parent.
    // An already bound child can never be stolen by an unknown group id.
    const parentRow = parent[0]
    const childId = event.subagent_id
    const existing = child[0]?.agent
    const expectedDepth = (parentRow?.agent.depth ?? 0) + 1

    if (matching.length !== 0 || !parentRow || !childId ||
      (existing && (existing.delegationId !== undefined ||
        existing.parentId !== event.parent_id ||
        (existing.depth !== undefined && existing.depth !== expectedDepth))) ||
      childId === event.parent_id ||
      !Number.isSafeInteger(event.task_index) || event.task_index < 0 ||
      !Number.isSafeInteger(event.task_count) || event.task_count <= event.task_index ||
      (event.depth !== undefined && event.depth !== expectedDepth) ||
      !trustedParentChain(calls, parentRow.call, parentRow.agent)) {
      return undefined
    }

    return parentRow.call
  }

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

  // Before a nested child's own batch id is known, do not label it with its
  // parent's dispatch id: the subsequent explicit nested batch must be bindable.
  const delegation = event.delegation_id || agent.delegationId || (
    !event.parent_id && !agent.parentId ? resultId(call) : undefined
  )

  if (delegation) {
    agent.delegationId = delegation
  }

  // An id-less follow-up keeps the nested row's group and ancestry. A later
  // sibling with an exact known nested group may inherit its recorded parent.
  const parentId = event.parent_id || agent.parentId || (
    delegation && delegation !== resultId(call)
      ? call.subagents?.find(a => a.id !== agent.id && a.delegationId === delegation && a.parentId)?.parentId
      : undefined
  )

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
