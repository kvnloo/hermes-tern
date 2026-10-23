import type { SubagentEventPayload } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import { attachRow, ownersOf } from '../agents/rows.js'
import { Agents } from '../agents/store.js'
import { liveSessionId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { routeEvent } from '../session/flow.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, must } from './fakes.js'

/** The real transcript reducer supplies both calls and their dispatch results. */
function dispatched(transcript: Transcript, tool: string, delegation: string, at: number): ToolCall {
  transcript.messageStart(at)
  transcript.toolStart({ args: { tasks: [{ goal: tool }] }, name: 'delegate_task', tool_id: tool }, at + 1)
  transcript.toolComplete({
    name: 'delegate_task',
    result: { delegation_id: delegation, mode: 'background', status: 'dispatched' },
    tool_id: tool
  }, at + 2)
  transcript.complete({ status: 'complete' }, at + 3)

  return must(transcript.delegations().find(call => call.id === tool))
}

function payload(subagentId: string, delegationId?: string): SubagentEventPayload {
  return {
    goal: subagentId,
    subagent_id: subagentId,
    task_count: 1,
    task_index: 0,
    ...(delegationId === undefined ? {} : { delegation_id: delegationId })
  }
}

function rig() {
  const transcript = new Transcript()
  const ended = vi.fn()
  const changed = vi.fn()
  let session = liveSessionId('session-a')
  const agents = new Agents({
    agentEnded: ended,
    changed,
    gw: new FakeGateway().client,
    get sid() {
      return session
    },
    transcript
  })

  return {
    agents,
    changed,
    ended,
    setSession(id: string) {
      session = liveSessionId(id)
      agents.adopt(session)
    },
    transcript
  }
}

describe('delegation ownership (gateway events → Agents → transcript)', () => {
  it('isolates overlapping A/B delegations even when B starts first', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)

    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 20)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 21)
    h.agents.apply('subagent.tool', { ...payload('worker-a', 'group-a'), tool_name: 'terminal' }, 22)

    expect(a.subagents).toMatchObject([{ delegationId: 'group-a', id: 'worker-a', status: 'running', tool: 'terminal' }])
    expect(b.subagents).toMatchObject([{ delegationId: 'group-b', id: 'worker-b', status: 'running' }])
    h.agents.dispose()
  })

  it('rejects a foreign explicit id without mutating either call or triggering attention', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)
    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.complete', { ...payload('foreign', 'group-foreign'), status: 'completed' }, 22)
    h.agents.apply('subagent.start', payload('worker-b', 'group-foreign'), 23)

    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    expect(h.ended).not.toHaveBeenCalled()
    expect(h.changed).not.toHaveBeenCalled()
    h.agents.dispose()
  })

  it('treats a supplied empty delegation id as invalid, not legacy id-less traffic', () => {
    const h = rig()
    const call = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', payload('foreign', ''), 10)

    expect(call.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('accepts a genuinely id-less event only with a single possible delegate call', () => {
    const h = rig()
    const call = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', payload('legacy-child'), 5)
    h.agents.apply('subagent.complete', { ...payload('legacy-child'), status: 'completed' }, 6)

    expect(call.subagents).toMatchObject([{ delegationId: 'group-a', id: 'legacy-child', status: 'done' }])
    h.agents.dispose()
  })

  it('routes id-less late progress by an existing child id, not the newest task', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.tool', { ...payload('worker-a'), tool_name: 'read_file' }, 30)

    expect(a.subagents?.[0]).toMatchObject({ id: 'worker-a', tool: 'read_file' })
    expect(b.subagents?.[0]).toMatchObject({ id: 'worker-b', tool: undefined })
    h.agents.dispose()
  })

  it('drops id-less unknown children when two completed calls could own them', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)

    h.agents.apply('subagent.start', payload('unknown'), 20)

    expect(a.subagents).toBeUndefined()
    expect(b.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('does not cross-bind conflicting child and parent identity hints', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.tool', { ...payload('worker-a'), parent_id: 'worker-b', tool_name: 'terminal' }, 22)

    expect(a.subagents?.[0]?.tool).toBeUndefined()
    expect(b.subagents?.[0]?.tool).toBeUndefined()
    h.agents.dispose()
  })

  it('rejects reused child ids when their explicit delegation ids disagree', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)

    h.agents.apply('subagent.complete', { ...payload('worker-a', 'group-b'), status: 'completed' }, 21)

    expect(a.subagents?.[0]?.status).toBe('running')
    expect(b.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('keeps a late completion on A after B opens a new turn', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.complete', { ...payload('worker-a', 'group-a'), status: 'completed', summary: 'A finished' }, 30)

    expect(a.subagents?.[0]).toMatchObject({ status: 'done', summary: 'A finished' })
    expect(b.subagents?.[0]).toMatchObject({ status: 'running' })
    h.agents.dispose()
  })

  it('keeps explicit parent links and flattens a later cyclic parent edge', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    h.agents.apply('subagent.start', payload('root', 'group-a'), 10)
    h.agents.apply('subagent.start', { ...payload('child', 'group-a'), parent_id: 'root', depth: 1 }, 11)

    expect(a.subagents?.find(x => x.id === 'child')).toMatchObject({
      delegationId: 'group-a', depth: 1, parentId: 'root'
    })

    h.agents.apply('subagent.progress', { ...payload('root', 'group-a'), parent_id: 'child' }, 12)

    expect(a.subagents?.find(x => x.id === 'root')).toMatchObject({ depth: 0 })
    expect(a.subagents?.find(x => x.id === 'root')?.parentId).toBeUndefined()
    expect(a.subagents?.find(x => x.id === 'child')?.parentId).toBe('root')
    h.agents.dispose()
  })

  it('does not create a self-parented or already cyclic agent', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', { ...payload('same', 'group-a'), parent_id: 'same', depth: 1 }, 10)

    expect(a.subagents?.[0]).toMatchObject({ depth: 0 })
    expect(a.subagents?.[0]?.parentId).toBeUndefined()
    h.agents.dispose()
  })

  it('finds a resumed owner from the registry-attached row without a tool result', () => {
    const h = rig()
    h.transcript.load([
      { role: 'user', text: 'resume' },
      { args: { tasks: [{ goal: 'resume goal' }] }, name: 'delegate_task', role: 'tool', tool_call_id: 'resumed' }
    ])
    const call = must(h.transcript.delegations()[0])
    const row = attachRow(ownersOf(h.transcript.delegations()), call, 0, {
      delegation_id: 'resumed-group', depth: 0, goal: 'resume goal', subagent_id: 'sa-0-resumed'
    }, undefined)

    h.agents.apply('subagent.complete', { ...payload('sa-0-resumed', 'resumed-group'), status: 'completed' }, 20)

    expect(row).toMatchObject({ delegationId: 'resumed-group', status: 'done' })
    expect(call.subagents).toHaveLength(1)
    h.agents.dispose()
  })

  it('does not attach a prior-session event after adoption of a different session', () => {
    const h = rig()
    dispatched(h.transcript, 'old', 'old-group', 0)
    h.setSession('session-b')
    h.transcript.reset({ session: 'other', usage: undefined })
    const current = dispatched(h.transcript, 'current', 'new-group', 20)
    const event = payload('stale', 'old-group')

    // This is the real gateway envelope guard; the payload alone has no session id.
    expect(routeEvent(liveSessionId('session-b'), false, {
      session_id: 'session-a', type: 'subagent.complete'
    })).toBe('drop')
    h.agents.apply('subagent.complete', { ...event, status: 'completed' }, 30)

    expect(current.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('settles only the matching delegation, never the other batch at the same task index', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.settle('[ASYNC DELEGATION COMPLETE — group-a]\n\nStatus: completed')

    expect(a.subagents?.[0]?.status).toBe('done')
    expect(b.subagents?.[0]?.status).toBe('running')

    h.agents.settle('[ASYNC DELEGATION COMPLETE — foreign-group]\n\nStatus: failed')
    expect(b.subagents?.[0]?.status).toBe('running')
    h.agents.dispose()
  })
})
