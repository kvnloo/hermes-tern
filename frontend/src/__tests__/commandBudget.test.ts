import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { Transcript } from '../transcript/store.js'
import { describeCommand } from '../view/describe.js'
import { toolNode } from '../view/tools/shell.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]
const nested = (count: number, tail = 'echo ok') => 'ssh user@host '.repeat(count) + tail

describe('terminal title work budget', () => {
  it('keeps ordinary commands and nested SSH descriptions', () => {
    expect(describeCommand('ssh alice@one ssh bob@two echo ok')).toBe('Print text on two on one')
    expect(describeCommand('curl https://user:secret@example.com/path?token=secret')).toBe('Fetch example.com')
    expect(describeCommand(nested(8))).toContain('Print text')
  })

  it('checks the input ceiling before parsing and never reflects oversized command data', () => {
    const within = 'echo ' + 'x'.repeat(4_091)
    const beyond = within + 'x'
    const spy = vi.spyOn(String.prototype, 'matchAll')
    try {
      expect(describeCommand(within)).toBe('Print text')
      spy.mockClear()
      expect(describeCommand(beyond)).toBe('Run a command')
      expect(describeCommand('curl https://user:secret@example.com/?token=' + 'z'.repeat(36_000))).toBe('Run a command')
      expect(describeCommand('curl https://user:secret@[' + 'z'.repeat(5_000))).toBe('Run a command')
      expect(describeCommand('ssh secret@host ' + '<<unfinished '.repeat(4_000))).toBe('Run a command')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('bounds both SSH nesting and cumulative input scanned without leaking outer hosts', () => {
    const spy = vi.spyOn(String.prototype, 'matchAll')
    try {
      const deep = nested(1000)
      expect(describeCommand(deep)).toBe('Run a command') // Input ceiling applies first.
      expect(spy).not.toHaveBeenCalled()
      expect(describeCommand(nested(9))).toBe('Run a command')
      expect(spy).toHaveBeenCalledTimes(9) // Nine parses, then the depth guard.
      spy.mockClear()
      expect(describeCommand(nested(4, 'echo ' + 'x'.repeat(3_900)))).toBe('Run a command')
      expect(spy).toHaveBeenCalledTimes(4) // The fifth parse would exhaust the shared budget.
    } finally {
      spy.mockRestore()
    }
  })

  it.each([['depth', nested(9, 'echo visible')], ['length', nested(2_600, 'echo visible')]])
  ('preserves full %s-limited command, failure status and ANSI output on actual card and replay', (_kind, command) => {
    const output = '\x1b[31merror\x1b[0m'
    const failed = call('terminal', { command }, {
      outcome: { duration: 1, kind: 'error' }, result: { exit_code: 2, output }
    })
    const card = tree(toolNode(failed, 0))
    expect(card.p).toMatchObject({ name: 'bash', status: 'error', exit: 2, title: 'Run a command' })
    expect(nodes(card).find(n => n.p?.['role'] === 'omp.tool.command')?.p?.['text']).toBe(command)
    expect(nodes(card).filter(n => n.k === 'ansi').map(n => n.p?.['text'])).toEqual([output])

    const transcript = new Transcript()
    transcript.load([
      { role: 'user', text: 'check it' },
      { role: 'tool', name: 'terminal', tool_call_id: 't1', args: { command }, content: JSON.stringify({ exit_code: 2, output }) }
    ])
    const calls = transcript.entries.flatMap(e => e.kind === 'turn' ? e.blocks.flatMap(b => b.kind === 'tool' ? [b.call] : []) : [])
    expect(calls).toHaveLength(1)
    const stored = calls[0]
    if (!stored) throw new Error('missing replayed terminal call')
    const replay = tree(toolNode(stored, 0))
    expect(replay.p).toMatchObject({ name: 'bash', title: 'Run a command', exit: 2 })
    expect(nodes(replay).find(n => n.p?.['role'] === 'omp.tool.command')?.p?.['text']).toBe(command)
    expect(nodes(replay).filter(n => n.k === 'ansi').map(n => n.p?.['text'])).toEqual([output])
  })
})
