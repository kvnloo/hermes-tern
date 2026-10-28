import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { taskNeedsAttention } from '../tools/task-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const limited = { status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }
const notice = 'At least one delegated task reached its iteration limit; its report may be incomplete.'
const delegate = (result: unknown, more: Partial<ToolCall> = {}) => call('delegate_task', { goal: 'audit' }, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { tip: '', version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

describe('retained delegate iteration limits in work folds', () => {
  it('keeps the card and its disclosure in place between folded work and the answer', () => {
    const task = tool('task', delegate({ results: [limited] }))
    const t = turn([tool('before', call('terminal')), task, tool('after', call('terminal')), text('answer')])
    expect(foldOf(t)?.hidden.has(task.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:task', 'fold:after', 'shown:answer'])
    expect(pieces([task], t.blocks)).toEqual([{ kind: 'block', block: task }])
    const root = tree(entryNode(t, 'main.test', cx))
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'task')
    expect(card?.p?.['status']).toBe('done')
    expect(card?.p?.['collapsed']).toBe(false)
    expect(JSON.stringify(card)).toContain(notice)
  })

  it('retains prior web and failed-call attention and keeps ordering after the answer', () => {
    const task = tool('task', delegate({ results: [limited] }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const failed = tool('failed', call('terminal', {}, { outcome: { duration: 1, kind: 'error' } }))
    const t = turn([tool('before', call('terminal')), web, text('answer'), task, failed])
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'web', 'answer', 'task', 'failed'])
    expect([web, task, failed].map(b => foldOf(t)?.hidden.has(b.id))).toEqual([false, false, false])
  })

  it('keeps ordinary, malformed, and missing results folded', () => {
    const examples = [undefined, { results: [{ status: 'completed', summary: 'done' }] },
      { results: [JSON.stringify(limited)] }, { status: 'dispatched', results: [limited] }]
    for (const result of examples) {
      const task = tool('task', delegate(result))
      const t = turn([task, text('answer')])
      expect(taskNeedsAttention(task.call)).toBe(false)
      expect(foldOf(t)?.hidden.has(task.id)).toBe(true)
    }
  })

  it('only reveals a replayed result if the result itself is retained', () => {
    const replay = (content?: string) => history({ kept: [], compactions: [], id: entryId, messages: [
      { role: 'tool', name: 'delegate_task', tool_call_id: 'd', args: { goal: 'audit' }, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify({ results: [limited] }))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(retained, 'main.test', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.test', cx)))).not.toContain(notice)
    const retainedTool = retained.blocks.find(b => b.kind === 'tool')
    const absentTool = absent.blocks.find(b => b.kind === 'tool')
    expect(retainedTool && foldOf(retained)?.hidden.has(retainedTool.id)).not.toBe(true)
    expect(absentTool && foldOf(absent)?.hidden.has(absentTool.id)).toBe(true)
  })
})
