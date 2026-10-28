import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const label = 'Environment recreated; state may be lost'
const notice = 'Hermes reports the execution environment was recreated; background processes and unpersisted files may be lost.'
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { tip: '', version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('terminal', { command: 'true' }, { result, ...more })

function producer(): { flagged: Record<string, unknown>; clean: Record<string, unknown> } {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-recreated-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected producer results')
  const flagged = record(data[0])
  const clean = record(data[1])
  if (!flagged || !clean) throw new Error('expected terminal objects')
  return { flagged, clean }
}

describe('retained terminal recreation attention', () => {
  it('shows the real finalizer warning on an unfolded card before the answer without changing the result', () => {
    const { flagged } = producer()
    const warned = tool('warned', make(flagged))
    const t = turn([tool('before', make({ output: 'before', exit_code: 0, error: null })), warned, tool('after', make({ output: 'after', exit_code: 0, error: null })), text('answer')])
    expect(foldOf(t)?.hidden.has(warned.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:warned', 'fold:after', 'shown:answer'])
    expect(pieces([warned], t.blocks)).toEqual([{ kind: 'block', block: warned }])
    const cards = nodes(tree(entryNode(t, 'main.terminal', cx))).filter(n => n.k === 'tool' && n.p?.['name'] === 'bash')
    const card = cards.find(n => Array.isArray(n.p?.['meta']) && n.p['meta'].includes(label))
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false, meta: [label] })
    expect(JSON.stringify(card)).toContain(notice)
    expect(warned.call.result).toBe(flagged)
    expect(warned.call.outcome.kind).toBe('done')
  })

  it('preserves web, eval, delegate, error and running attention and their order', () => {
    const { flagged } = producer()
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const evalBlock = tool('eval', call('execute_code', { code: 'print(1)' }, { result: { stdout_truncated: true, output: 'partial' } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const warned = tool('warned', make(flagged))
    const failed = tool('failed', call('terminal', {}, { outcome: { kind: 'error', duration: 1 } }))
    const running = tool('running', call('terminal', {}, { outcome: { kind: 'running' } }))
    const t = turn([tool('before', make({})), web, evalBlock, task, warned, failed, text('answer'), running])
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'web', 'eval', 'task', 'warned', 'failed', 'answer', 'running'])
    expect([web, evalBlock, task, warned, failed, running].map(b => foldOf(t)?.hidden.has(b.id))).toEqual([false, false, false, false, false, false])
    const root = tree(entryNode(t, 'main.combined', cx))
    expect(nodes(root).some(node => node.k === 'tool' && node.p?.['name'] === 'fetch')).toBe(true)
    for (const value of ['Hermes reports stdout was truncated', 'At least one delegated task reached its iteration limit', notice]) expect(JSON.stringify(root)).toContain(value)
  })

  it('keeps settled error and cancellation statuses while showing their warning', () => {
    const { flagged } = producer()
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const warned = tool('warned', make(flagged, { outcome }))
      const t = turn([tool('before', make({})), warned, text('answer')])
      expect(foldOf(t)?.hidden.has(warned.id)).toBe(false)
      expect(pieces([warned])).toEqual([{ kind: 'block', block: warned }])
      const card = nodes(tree(entryNode(t, 'main.settled', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'bash' && Array.isArray(n.p?.['meta']))
      expect(card?.p).toMatchObject({ status: outcome.kind, collapsed: false, meta: [label] })
      expect(JSON.stringify(card)).toContain(notice)
      expect(warned.call.outcome).toEqual(outcome)
    }
  })

  it('does not promote clean, malformed, running, or background results', () => {
    const { flagged, clean } = producer()
    const cases = [clean, { ...flagged, environment_recreated: true }, { ...flagged, environment_recreated: 'arbitrary' },
      { ...flagged, exit_code: '0' }, { ...flagged, output: null }, { ...flagged, error: 'error' },
      Object.assign(Object.create({ environment_recreated: flagged['environment_recreated'] }), { output: 'shown', exit_code: 0, error: null })]
    for (const result of cases) {
      const c = tool('ordinary', make(result))
      expect(foldOf(turn([c, text('answer')]))?.hidden.has(c.id)).toBe(true)
      expect(pieces([c])).toEqual([{ kind: 'work', items: [c] }])
    }
    const running = tool('running', make(flagged, { outcome: { kind: 'running' } }))
    expect(pieces([running])).toEqual([{ kind: 'work', items: [running] }])
    const background = tool('background', call('terminal', { command: 'true', background: true }, { result: flagged }))
    const session = tool('session', make({ ...flagged, session_id: 'pid' }))
    for (const b of [background, session]) {
      expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
      const root = tree(entryNode(turn([b, text('answer')]), 'main.background', cx))
      expect(JSON.stringify(root)).not.toContain(notice)
      expect(JSON.stringify(root)).not.toContain(label)
    }
  })

  it('shows retained replay signals and leaves missing replay data folded', () => {
    const { flagged } = producer()
    const replay = (content?: string) => history({ kept: [], compactions: [], id: entryId, messages: [
      { role: 'tool', name: 'terminal', tool_call_id: 'term', args: { command: 'true' }, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify(flagged))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const kept = retained.blocks.find(b => b.kind === 'tool')
    const lost = absent.blocks.find(b => b.kind === 'tool')
    expect(kept && foldOf(retained)?.hidden.has(kept.id)).not.toBe(true)
    expect(lost && foldOf(absent)?.hidden.has(lost.id)).toBe(true)
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(notice)
  })
})
