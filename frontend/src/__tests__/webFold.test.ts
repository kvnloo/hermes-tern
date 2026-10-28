import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { webExtractNeedsAttention } from '../tools/web-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const extract = (result: unknown, more: Partial<ToolCall> = {}) => call('web_extract', {}, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { tip: '', version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const mixed = { results: [{ url: 'https://a.example', content: 'page', error: null }, { url: '', content: '', error: 'failed' }] }

describe('web extraction attention in work folds', () => {
  it('keeps a done call with an entry failure as a direct card between folded work and answer', () => {
    const fetch = tool('fetch', extract(mixed))
    const t = turn([tool('before', call('terminal')), fetch, tool('after', call('terminal')), text('answer')])
    expect(foldOf(t)?.hidden.has(fetch.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:fetch', 'fold:after', 'shown:answer'])
    expect(pieces([fetch], t.blocks)).toEqual([{ kind: 'block', block: fetch }])
    const root = tree(entryNode(t, 'main.test', cx))
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(card?.p?.['status']).toBe('done')
    expect(fetch.call.outcome.kind).toBe('done')
    expect(JSON.stringify(card)).toContain('page')
    // Entry error text requires #118; this #74-based branch changes fold ownership only.
  })

  it('keeps a failure after an answer out of the fold without reordering', () => {
    const fetch = tool('fetch', extract(mixed))
    const t = turn([tool('before', call('terminal')), text('answer'), fetch])
    expect(foldOf(t)?.hidden.has(fetch.id)).toBe(false)
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'answer', 'fetch'])
  })

  it('matches Fetch parsing while rejecting malformed and empty error fields', () => {
    const payloads = [undefined, null, {}, { results: 'bad' }, { results: [] },
      { results: [null, 7, 'error', ['x'], { error: null }, { error: '' }, { error: ' \n' }, { error: 1 }, { error: {} }] },
      { error: 'top-level only', results: [{ error: null }] }]
    for (const payload of payloads) expect(webExtractNeedsAttention(extract(payload))).toBe(false)
    expect(webExtractNeedsAttention(call('another_tool', {}, { result: mixed }))).toBe(false)
    expect(webExtractNeedsAttention(extract({ results: [{ error: 'failed' }] }))).toBe(true)
    expect(webExtractNeedsAttention(extract(JSON.stringify(mixed)))).toBe(true)
    expect(webExtractNeedsAttention(extract({ results: ['{"error":"legacy error"}'] }))).toBe(true)
    expect(webExtractNeedsAttention(extract({ results: [Object.create({ error: 'prototype' })] }))).toBe(true)
  })

  it('preserves #74 error/running handling and existing cancellation behavior', () => {
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'running' as const }]) {
      const b = tool('fetch', extract(mixed, { outcome }))
      expect(webExtractNeedsAttention(b.call)).toBe(false)
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).not.toBe(true)
    }
    const cancelled = tool('cancelled', extract(mixed, { outcome: { kind: 'cancelled', duration: 1 } }))
    expect(webExtractNeedsAttention(cancelled.call)).toBe(false)
    expect(foldOf(turn([cancelled, text('answer')]))?.hidden.has(cancelled.id)).toBe(true)
    const clean = tool('clean', extract({ results: [{ url: 'https://a', content: 'ok', error: null }] }))
    expect(foldOf(turn([clean, text('answer')]))?.hidden.has(clean.id)).toBe(true)
  })

  it('preserves done and attention for a retained history result', () => {
    let n = 0
    const entries = history({ kept: [], compactions: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'fetch' },
      { role: 'tool', name: 'web_extract', tool_call_id: 'f', args: {}, content: JSON.stringify(mixed) },
      { role: 'assistant', text: 'answer' }
    ] })
    const t = entries.find(e => e.kind === 'turn')
    if (!t) throw new Error('missing turn')
    const block = t.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing tool')
    expect(block.call.outcome.kind).toBe('done')
    expect(webExtractNeedsAttention(block.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(block.id)).not.toBe(true)
    const card = nodes(tree(entryNode(t, 'main.replay', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(card?.p?.['status']).toBe('done')
  })
})
