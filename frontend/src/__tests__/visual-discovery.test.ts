import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Entry, ToolCall, TurnEntry } from '../model.js'
import { VISUAL_DISCOVERY_LIMITS as limits, parseVisualCandidate, recentVisualCandidates } from '../visual-discovery.js'

const scope = '["stored","main"]'
const id = 'a'.repeat(64)

function hint(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ kind: 'hermes.visual.candidate', version: 1, id, path: '/tmp/one.hvisual.json', scope, ...extra })
}

function call(output = hint(), extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: toolCallId('call-1'),
    name: 'terminal',
    args: {},
    argsText: '',
    context: '',
    startedAt: 0,
    outcome: { kind: 'done', duration: 1 },
    result: { exit_code: 0, output },
    via: { kind: 'direct' },
    ...extra
  }
}

function turn(calls: ToolCall[]): TurnEntry {
  return {
    kind: 'turn',
    id: entryId('turn-1'),
    rev: 0,
    end: { status: 'done' },
    startedAt: 0,
    blocks: calls.map(c => ({ kind: 'tool', id: c.id, call: c }))
  }
}

describe('reported OpenUI candidate discovery', () => {
  it('accepts only exact versioned JSON with the same scope and a full identity', () => {
    const value = parseVisualCandidate(hint({ path: '/tmp/a b/file.hvisual.json' }), scope, 'tool-1')
    expect(value?.path).toBe('/tmp/a b/file.hvisual.json')
    expect(value?.callId).toBe('tool-1')
    expect(Object.isFrozen(value)).toBe(true)

    for (const raw of [hint() + '\nwarning', 'prefix\n' + hint(), '/tmp/one.hvisual.json', '[]', 'null', '{']) {
      expect(parseVisualCandidate(raw, scope, 'tool-1')).toBeUndefined()
    }
  })

  it('rejects injected fields, other versions, identities, scopes and unsafe paths', () => {
    for (const extra of [
      { command: 'terminal' }, { approved: true }, { version: 2 }, { kind: 'html_render' },
      { id: 'short' }, { scope: 'other' }, { scope: null }
    ]) {
      expect(parseVisualCandidate(hint(extra), scope, 'call')).toBeUndefined()
    }

    for (const path of [
      'relative.hvisual.json', 'file:///tmp/file.hvisual.json', '/tmp/file.html',
      '/tmp/a\n.hvisual.json', '/tmp/a\u202e.hvisual.json', '/' + 'x'.repeat(4100) + '.hvisual.json'
    ]) {
      expect(parseVisualCandidate(hint({ path }), scope, 'call')).toBeUndefined()
    }

    expect(parseVisualCandidate(hint(), '', 'call')).toBeUndefined()
    expect(parseVisualCandidate(hint({ scope: 'x'.repeat(257) }), 'x'.repeat(257), 'call')).toBeUndefined()
    expect(parseVisualCandidate(' '.repeat(limits.outputChars) + hint(), scope, 'call')).toBeUndefined()
  })

  it('uses only successful completed terminal results, not prose, arguments or summaries', () => {
    const calls = [
      call(hint(), { name: 'read_file' }),
      call(hint(), { outcome: { kind: 'running' } }),
      call(hint(), { outcome: { kind: 'error', duration: 1 } }),
      call(hint(), { outcome: { kind: 'cancelled', duration: 1 } }),
      call('', { result: { exit_code: 1, output: hint() } }),
      call('', { result: { output: hint() } }),
      call('', { result: { exit_code: 0, output: hint(), error: 'failed' } }),
      call('', { result: { exit_code: 0, output: hint(), isError: true } }),
      call('', { result: undefined, resultText: hint(), args: { output: hint() } })
    ]
    const entry = turn(calls)
    entry.blocks.push({ kind: 'text', id: entryId('text'), text: hint() })
    expect(recentVisualCandidates([entry], scope)).toEqual([])
  })

  it('parses an entire serialized result envelope without scraping partial logs', () => {
    expect(recentVisualCandidates([turn([call('', { result: JSON.stringify({ exit_code: 0, output: hint() }) })])], scope)[0]?.id).toBe(id)

    for (const result of ['{', 'x'.repeat(limits.outputChars + 1), null, []]) {
      expect(recentVisualCandidates([turn([call('', { result })])], scope)).toEqual([])
    }
  })

  it('preserves newest-first order, deduplicates retries and leaves transcript intact', () => {
    const old = call()
    const retry = call(hint(), { id: toolCallId('retry') })
    const newest = call(hint({ id: 'b'.repeat(64), path: '/tmp/new.hvisual.json' }), { id: toolCallId('new') })
    const entries = [turn([old, retry, newest])]
    const before = JSON.stringify(entries)
    const found = recentVisualCandidates(entries, scope)
    expect(found.map(c => c.callId)).toEqual(['new', 'retry'])
    expect(Object.isFrozen(found)).toBe(true)
    expect(JSON.stringify(entries)).toBe(before)
  })

  it('bounds entries, blocks, candidates and aggregate parse work', () => {
    const large = turn(Array.from({ length: 20 }, (_, i) => call(hint({ path: `/tmp/${i}.hvisual.json` }), { id: toolCallId(String(i)) })))
    expect(recentVisualCandidates([large], scope)).toHaveLength(limits.candidates)

    const notices: Entry[] = Array.from({ length: limits.entries }, (_, n) => ({
      kind: 'notice', id: entryId(String(n)), text: '', tone: 'info'
    }))
    expect(recentVisualCandidates([turn([call()]), ...notices], scope)).toEqual([])

    const tooMany = turn([call()])
    for (let i = 0; i < limits.blocks; i++) {
      tooMany.blocks.push({ kind: 'text', id: entryId(String(i)), text: '' })
    }
    expect(recentVisualCandidates([tooMany], scope)).toEqual([])

    const budget = turn([call(), ...Array.from({ length: 9 }, (_, n) => call(' '.repeat(limits.outputChars), { id: toolCallId(String(n)) }))])
    expect(recentVisualCandidates([budget], scope)).toEqual([])
  })
})
