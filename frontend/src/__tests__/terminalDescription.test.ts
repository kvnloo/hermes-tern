import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]

function assertBash(card: NodeJson, command: string, output: string) {
  expect(card.p).toMatchObject({ name: 'bash', target: command, targetKind: 'command' })
  expect(nodes(card).filter(node => node.k === 'ansi').map(node => node.p?.['text'])).toEqual([output])
}

describe('terminal card command descriptions', () => {
  it.each(['curl http://', 'curl https://[', 'constructor', '__proto__', 'git constructor'])
  ('retains failed terminal status, command, exit and ANSI output for %s', command => {
    const failure = call('terminal', { command }, {
      outcome: { duration: 1, kind: 'error' }, result: { exit_code: 2, output: 'failure output' }
    })
    const card = tree(toolNode(failure, 0))
    assertBash(card, command, 'failure output')
    expect(card.p).toMatchObject({ status: 'error', exit: 2, collapsed: false })
    expect(toolDetail(failure, 0).map(tree).flatMap(nodes).filter(node => node.k === 'ansi')
      .map(node => node.p?.['text'])).toEqual(['failure output'])
  })

  it('keeps a background process card and its process identity', () => {
    const command = 'curl http://'
    const c = call('terminal', { background: true, command }, {
      result: { output: 'Background process started', session_id: 'proc_123' }
    })
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ name: 'bash', target: command, status: 'done' })
    expect(card.p?.['badges']).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'background' })]))
    expect(nodes(card).some(node => node.p?.['role'] === 'omp.tool.process')).toBe(true)
    expect(JSON.stringify(card)).toContain('proc_123')
  })

  it('retains the terminal view for a replayed tool result', () => {
    const command = 'curl http://'
    const transcript = new Transcript()
    transcript.load([
      { role: 'user', text: 'check it' },
      { role: 'tool', name: 'terminal', tool_call_id: 'terminal-1', args: { command },
        content: JSON.stringify({ exit_code: 2, output: 'replayed output' }) }
    ])
    const calls = transcript.entries.flatMap(entry => entry.kind === 'turn'
      ? entry.blocks.flatMap(block => block.kind === 'tool' ? [block.call] : []) : [])
    expect(calls).toHaveLength(1)
    const stored = calls[0]
    if (!stored) { throw new Error('missing replayed terminal call') }
    assertBash(tree(toolNode(stored, 0)), command, 'replayed output')
  })
})
