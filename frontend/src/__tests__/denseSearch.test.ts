import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { retainedResults } from '../tool-results.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const codes = (root: NodeJson) => nodes(root).filter(n => n.k === 'code')
const card = (result: unknown, args: Record<string, unknown> = {}) => tree(toolNode(call('search_files', args, { result }), 0))

describe('Hermes dense search cards', () => {
  it('replays search, generic and terminal cards with their separate retained-result and language rules', () => {
    const generic = 'g'.repeat(4001)
    let n = 0
    const entries = history({ kept: [], compactions: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'user', text: 'inspect results' },
      { role: 'tool', name: 'search_files', tool_call_id: 'dense', args: { pattern: 'hit' }, content: JSON.stringify({ matches_text: 'dense result', total_count: 5 }) },
      { role: 'tool', name: 'search_files', tool_call_id: 'structured', args: { pattern: 'hit' }, content: JSON.stringify({ matches: [{ path: 'file.constructor', line: 1, content: 'hit' }], total_count: 1 }) },
      { role: 'tool', name: 'custom_result', tool_call_id: 'generic', args: {}, content: generic },
      { role: 'tool', name: 'terminal', tool_call_id: 'terminal', args: { command: 'curl https://user:secret@[' }, content: JSON.stringify({ exit_code: 2, output: 'curl failed' }) }
    ] })
    const calls = entries.flatMap(e => e.kind === 'turn' ? e.blocks.flatMap(b => b.kind === 'tool' ? [b.call] : []) : [])
    const dense = calls.find(c => c.id === 'dense')
    const structured = calls.find(c => c.id === 'structured')
    const terminal = calls.find(c => c.id === 'terminal')
    if (!dense || !structured || !terminal) throw new Error('missing replay tool')
    expect(codes(tree(toolNode(dense, 0)))[0]?.p?.['text']).toBe('dense result')
    const code = codes(tree(toolNode(structured, 0)))[0]
    expect(code?.p?.['text']).toBe('hit')
    expect(code?.p?.['lang']).toBeUndefined()
    const shell = tree(toolNode(terminal, 0))
    expect(shell.p).toMatchObject({ name: 'bash', title: 'Fetch a URL' })
    expect(nodes(shell).find(node => node.k === 'ansi')?.p?.['text']).toBe('curl failed')
    expect(retainedResults(entries).map(result => result.text)).toEqual([generic])
  })

  it('projects the actual pinned SearchResult and retained history JSON', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/search-result-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const result = parseJson(raw)
    if (!Array.isArray(result)) throw new Error('expected serialized results')
    const short = record(result[0])
    const payload = record(result[1])
    expect(short?.['matches_text']).toBeUndefined()
    expect(codes(card(short))[0]?.p?.['text']).toBe('  hit 1\n  hit 2\n  hit 3\n  hit 4')
    expect(payload?.['matches']).toBeUndefined()
    expect(payload?.['matches_format']).toContain('path-grouped')
    expect(payload?.['matches_text']).toBe('src/a.py\n  1:   hit 1\n  2:   hit 2\n  3:   hit 3\n  4:   hit 4\n  5:   hit 5')
    const live = card(payload, { pattern: 'hit' })
    expect(codes(live)[0]?.p).toMatchObject({ lang: 'text', text: payload?.['matches_text'] })
    expect(live.p?.['meta']).toEqual(['At least 7 matches', 'Search results truncated upstream'])

    let n = 0
    const entries = history({ kept: [], compactions: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'user', text: 'find it' },
      { role: 'tool', name: 'search_files', tool_call_id: 'search', args: { pattern: 'hit' }, content: JSON.stringify(payload) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    expect(block?.kind).toBe('tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    const replay = tree(toolNode(block.call, 0))
    expect(codes(replay)[0]?.p).toMatchObject({ lang: 'text', text: payload?.['matches_text'] })
    expect(replay.p?.['meta']).toEqual(live.p?.['meta'])
  })

  it('bounds dense output without splitting pairs and escapes terminal and bidi controls', () => {
    const root = card({ matches_text: 'x'.repeat(3999) + '😀\u001b[31m\u202etest', total_count: 9 })
    const content = codes(root)[0]?.p?.['text']
    expect(content).toBe('x'.repeat(3999))
    expect(root.p?.['meta']).toEqual(['9 matches', 'Search text clipped in view'])
    const unsafe = card({ matches_text: 'a\n\tb\u001b[31m\u202ex\ud800' })
    expect(codes(unsafe)[0]?.p?.['text']).toBe('a\n\tb\\u001b[31m\\u202ex\\ud800')
    expect(unsafe.p?.['meta']).toEqual(['Control characters escaped in view'])
  })

  it('does not invent counts and signals upstream and display limits separately', () => {
    for (const bad of [undefined, -1, 2.5, Infinity, '9']) {
      const root = card({ matches_text: 'visible', total_count: bad, truncated: true })
      expect(root.p?.['meta']).toEqual(['Search results truncated upstream'])
    }
    const root = card({ matches_text: 'x'.repeat(4001), total_count: 9, truncated: true })
    expect(root.p?.['meta']).toEqual(['At least 9 matches', 'Search results truncated upstream', 'Search text clipped in view'])
    const detail = toolDetail(call('search_files', {}, { result: { matches_text: 'x'.repeat(4001), total_count: 9, truncated: true } }), 0).map(tree).flatMap(nodes)
    const notices = detail.filter(n => n.p?.['role'] === 'omp.tool.notice')
    expect(notices.map(n => n.p?.['spans'])).toEqual([
      [{ s: 'muted', t: 'At least 9 matches' }],
      [{ s: 'muted', t: 'Search results truncated upstream' }],
      [{ s: 'muted', t: 'Search text clipped in view' }]
    ])
    for (const matches of [[], [null]]) {
      expect(codes(card({ matches, matches_text: 'retained' }))[0]?.p?.['text']).toBe('retained')
    }
  })

  it('keeps structured matches and file mode, and marks the file display cap', () => {
    const structured = card({ matches: [{ path: 'a.py', line: 1, content: 'hello' }], total_count: 1, matches_text: 'ignored' })
    expect(codes(structured)[0]?.p?.['text']).toBe('hello')
    expect(structured.p?.['meta']).toEqual(['1 match · 1 file shown'])
    const files = card({ files: Array.from({ length: 201 }, (_, i) => `f${i}`), total_count: 250, truncated: true }, { target: 'files' })
    expect(nodes(files).filter(n => n.p?.['role'] === 'omp.tool.file')).toHaveLength(200)
    expect(files.p?.['meta']).toEqual(['At least 250 files', 'Search results truncated upstream', 'Showing 200 of 201 retained files'])
  })

  it('keeps error and cancellation status alongside partial dense output', () => {
    const failed = call('search_files', {}, { result: { matches_text: 'partial', error: 'failed\u001b' }, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(nodes(root).find(n => n.p?.['role'] === 'omp.tool.error')?.p?.['spans']).toEqual([{ s: 'error', t: 'failed\\u001b' }])
    expect(toolDetail(failed, 0).map(tree).flatMap(nodes).some(n => n.p?.['role'] === 'omp.tool.error')).toBe(true)
    const cancelled = call('search_files', {}, { result: { matches_text: 'partial' }, outcome: { duration: 1, kind: 'cancelled' } })
    const stopped = tree(toolNode(cancelled, 0))
    expect(codes(stopped)[0]?.p?.['text']).toBe('partial')
    expect(nodes(stopped).some(n => n.p?.['role'] === 'omp.tool.notice')).toBe(true)
  })
})
