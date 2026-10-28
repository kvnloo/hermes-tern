import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { plain } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { Subagent, ToolCall } from '../model.js'
import { Transcript } from '../transcript/store.js'
import { parseJson, record } from '../wire/json.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const NOTICE = 'At least one delegated task reached its iteration limit; its report may be incomplete.'

/** Use the locked Hermes producer for the final entry, with no model or gateway. */
function producerEntry(): Record<string, unknown> {
  const code = `from types import SimpleNamespace
from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
import json
entry = _build_result_entry(SimpleNamespace(), {'final_response':'partial analysis','completed':False}, 0, 1.0, _SchemaOutcome(None,None,[],0))
print(json.dumps({k:v for k,v in entry.items() if not k.startswith('_')}))`
  const parsed = record(parseJson(execFileSync('python3', ['-c', code], { cwd: resolve('.hermes-src'), encoding: 'utf8' })))
  if (!parsed) throw new Error('Hermes did not produce an entry')
  return parsed
}

function rendered(c: ToolCall): string {
  return plain(stub({ main: [toolNode(c, 5000)] }), 160)
}

function liveAgent(status: Subagent['status'] = 'done'): Subagent {
  return stub({ calls: 0, goal: 'live goal', id: 'sa-live', index: 0, key: 'live', startedAt: 0, status, tokens: 0, toolCount: 0 })
}

describe('delegate iteration-limit disclosure', () => {
  it('shows the actual producer result at the call level and in grouped detail', () => {
    const entry = producerEntry()
    expect(entry).toMatchObject({ exit_reason: 'max_iterations', status: 'completed', summary: 'partial analysis', truncated: true })
    const c = call('delegate_task', { goal: 'audit' }, { result: { results: [entry] } })
    const node = tree(toolNode(c, 5000))
    expect(node.k).toBe('tool')
    expect(node.p?.['status']).toBe('done')
    expect(node.p?.['collapsed']).toBe(false)
    expect(rendered(c)).toContain(NOTICE)
    expect(JSON.stringify(toolDetail(c, 5000).map(tree))).toContain(NOTICE)
    expect(rendered(c)).toContain('partial analysis')
  })

  it('reports retained batch results without counting or attributing them to live rows', () => {
    const entry = producerEntry()
    const c = call('delegate_task', { tasks: [{ goal: 'one' }, { goal: 'two' }] }, {
      result: { results: [entry, { ...entry }, { status: 'failed', error: 'offline' }] },
      subagents: [liveAgent(), { ...liveAgent(), id: 'second', key: stub('second') }]
    })
    const node = tree(toolNode(c, 5000))
    const text = rendered(c)
    expect(text).toContain(NOTICE)
    expect(text).toContain('live goal')
    expect(JSON.stringify(node)).not.toContain('sa-live reached')
    expect(rendered(call('delegate_task', {}, { result: { results: [entry] }, subagents: [liveAgent('running')] }))).toContain(NOTICE)
  })

  it('does not infer a limit from an event, a running call, a dispatch, or missing result', () => {
    const entry = producerEntry()
    const examples = [
      call('delegate_task', { goal: 'a' }, { subagents: [liveAgent()] }),
      call('delegate_task', {}, { outcome: { kind: 'running' }, result: { results: [entry] } }),
      call('delegate_task', {}, { result: { results: [entry], status: 'dispatched' } }),
      call('delegate_task', {}, { result: { results: [entry], status: 'running' } }),
      call('delegate_task', {}, { result: { results: [entry], status: 'error' } }),
      call('delegate_task', {}, { result: { results: [entry], mode: 'background' } }),
      call('delegate_task', {}, { result: { results: [entry], success: false } }),
      call('delegate_task', {}, { result: { error: 'dispatch failed', results: [entry] } }),
      call('delegate_task', {}, { outcome: { duration: 1, kind: 'cancelled' }, result: { results: [entry] } }),
      call('delegate_task', {}, { outcome: { duration: 1, kind: 'error' }, result: { results: [entry] } })
    ]
    for (const c of examples) expect(rendered(c)).not.toContain('iteration limit')
  })

  it('rejects malformed or contradictory evidence and distinguishes clipped summaries', () => {
    const entry = producerEntry()
    const variants = [
      { ...entry, truncated: false }, { ...entry, truncated: 'true' }, { ...entry, exit_reason: 'completed' },
      { ...entry, status: 'failed' }, { ...entry, summary: '' }, { ...entry, summary: '(empty)' },
      { ...entry, error: 'failed' }, { status: 'completed', summary: 'clipped', summary_truncated: true },
      JSON.stringify(entry), Object.create(entry), null, 'broken'
    ]
    for (const result of variants) {
      const c = call('delegate_task', {}, { result: { results: [result] } })
      expect(rendered(c)).not.toContain('iteration limit')
    }
    const both = call('delegate_task', {}, { result: { results: [{ ...entry, summary_truncated: true }] } })
    expect(rendered(both)).toContain(NOTICE)
    const inheritedResults = call('delegate_task', {}, { result: Object.create({ results: [entry] }) })
    expect(rendered(inheritedResults)).not.toContain('iteration limit')
  })

  it('updates from a real live transcript result and only from retained replay content', () => {
    const entry = producerEntry()
    const t = new Transcript()
    t.toolStart({ name: 'delegate_task', args: { goal: 'audit' }, tool_id: 'c1' }, 1)
    const before = t.delegations()[0]
    if (!before) throw new Error('missing started call')
    expect(rendered(before)).not.toContain('iteration limit')
    t.toolComplete({ name: 'delegate_task', tool_id: 'c1', result: { results: [entry] } }, 2)
    const after = t.delegations()[0]
    if (!after) throw new Error('missing settled call')
    expect(rendered(after)).toContain(NOTICE)

    const replay = new Transcript()
    replay.load([{ role: 'tool', name: 'delegate_task', tool_call_id: 'c1', args: { goal: 'audit' }, content: JSON.stringify({ results: [entry] }) }])
    const kept = replay.delegations()[0]
    if (!kept) throw new Error('missing replayed call')
    expect(rendered(kept)).toContain(NOTICE)
    replay.load([{ role: 'tool', name: 'delegate_task', tool_call_id: 'c1', args: { goal: 'audit' } }])
    const absent = replay.delegations()[0]
    if (!absent) throw new Error('missing result-less replayed call')
    expect(rendered(absent)).not.toContain('iteration limit')
  })
})
