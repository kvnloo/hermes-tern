import { type Op, type Surface, type TspEvent } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { entryId, subagentId, subagentKey, toolCallId } from '../core/ids.js'
import type { Entry, TurnEntry } from '../model.js'
import { RELOAD_PAGE, RETAIN_TURNS, Retention, retentionBoundary, safeToSettle } from '../view/retention.js'
import type { TranscriptContext } from '../view/transcript.js'

import { stub } from './fakes.js'

const context = (copy = vi.fn()): TranscriptContext => ({
  copy,
  now: 1_000,
  welcome: { tip: 'A tip', version: 'v1' }
})

function history(turns: number): Entry[] {
  const rows: Entry[] = []

  for (let i = 0; i < turns; i++) {
    rows.push({ at: 1, id: entryId('u' + i), kind: 'user', text: 'Prompt ' + i })
    rows.push({
      blocks: [{ id: entryId('x' + i), kind: 'text', text: 'Answer ' + i }],
      end: { status: 'done', endedAt: 2 },
      id: entryId('t' + i),
      kind: 'turn',
      rev: 1,
      startedAt: 1
    })
  }

  return rows
}

function turnAt(entries: readonly Entry[], i: number): TurnEntry {
  const e = entries[i * 2 + 1]

  if (e?.kind !== 'turn') {
    throw new Error('Missing test turn')
  }

  return e
}

/** Records actual SDK operations, not a second fake retention implementation. */
function harness() {
  const frames: Op[][] = []
  const changed = vi.fn()
  let blocked = false
  const raw = {
    id: 'hermes',
    closed: false,
    get blocked() { return blocked },
    send: (ops: Op[]) => { frames.push(ops) },
    dispatch: () => undefined,
    acknowledge: () => undefined
  }
  const surface = stub<Surface>(raw)
  const retention = new Retention(surface, changed)
  const ops = () => frames.flat()
  const paint = (entries: readonly Entry[], cx = context(), hold = false) =>
    retention.paint({ dock: [], layer: [] }, entries, cx, hold)
  const gone = (ids: string[], sf = 'hermes') =>
    retention.gone(stub<TspEvent>({ ev: 'gone', ids, sf }))
  const click = (id: string) =>
    retention.dispatch(stub<TspEvent>({ act: 'click', ev: 'action', id, raw: {}, sf: 'hermes' }))
  const since = (start: number) => ops().slice(start)

  return { changed, click, frames, gone, ops, paint, retention, setBlocked: (value: boolean) => { blocked = value }, since, surface }
}

describe('retained long-session transcript', () => {
  it('uses 20 completed turns, protecting running, failed, interrupted and warning state', () => {
    const entries = history(30)
    turnAt(entries, 0).end = { status: 'live' }
    turnAt(entries, 1).end = { status: 'error', error: 'Service unavailable' }
    turnAt(entries, 2).end = { status: 'interrupted', endedAt: 2 }
    turnAt(entries, 3).warning = 'Incomplete output'
    turnAt(entries, 4).blocks.push({
      call: {
        id: toolCallId('job'), name: 'terminal', args: {}, argsText: '', context: '',
        outcome: { kind: 'running' }, startedAt: 1, via: { kind: 'direct' }
      },
      id: toolCallId('job'),
      kind: 'tool'
    })
    const h = harness()
    h.paint(entries)
    const settled = new Set(h.ops().filter(op => op[0] === 'settle').map(op => op[1]))

    for (let i = 0; i < 5; i++) {
      expect(settled.has('main.u' + i)).toBe(false)
      expect(settled.has('main.t' + i)).toBe(false)
    }

    expect(settled.has('main.t5')).toBe(true)
    expect(settled.has('main.u5')).toBe(true)
    expect(settled.has('main.t10')).toBe(false)
    expect(settled.has('main.t29')).toBe(false)
    expect(retentionBoundary(entries)).toBe(20)
    expect(RETAIN_TURNS).toBe(20)
  })

  it('never settles unresolved subagents, errors, unfinished compactions or notices', () => {
    const t = turnAt(history(1), 0)
    t.blocks.push({
      call: {
        id: toolCallId('delegate'), name: 'delegate_task', args: {}, argsText: '', context: '',
        outcome: { kind: 'done', duration: 10 }, startedAt: 1, via: { kind: 'direct' },
        subagents: [{
          id: subagentId('child'), key: subagentKey('child'), goal: 'inspect', index: 0, name: 'Agent 1',
          status: 'failed', toolCount: 0, tokens: 0, calls: 0, startedAt: 1
        }]
      },
      id: toolCallId('delegate'),
      kind: 'tool'
    })
    expect(safeToSettle(t)).toBe(false)
    expect(safeToSettle({ id: entryId('warning'), kind: 'notice', text: 'Review', tone: 'warning' })).toBe(false)
    expect(safeToSettle({ id: entryId('error'), kind: 'notice', text: 'Failed', tone: 'error' })).toBe(false)
    expect(safeToSettle({
      id: entryId('compact'), kind: 'compaction', rev: 1,
      compaction: { startedAt: 1, state: { status: 'running' } }
    })).toBe(false)
    expect(safeToSettle({ id: entryId('panel'), kind: 'panel', title: 'Report', text: 'Details' })).toBe(true)
  })

  it('keeps old main roots untouched on streaming and updates the addressed live turn', () => {
    const entries = history(25)
    const h = harness()
    h.paint(entries)
    const start = h.ops().length
    const live = turnAt(entries, 24)
    live.end = { status: 'live' }

    for (let i = 0; i < 25; i++) {
      const text = live.blocks[0]

      if (text?.kind === 'text') {
        text.text += 'x'
      }

      live.rev++
      h.paint(entries)
    }

    const updates = h.since(start)
    expect(updates.some(op => (op[0] === 'add' || op[0] === 'del') && op[1] === 'main')).toBe(false)
    expect(updates.some(op => op[0] === 'move' || op[0] === 'reveal')).toBe(false)
    expect(updates.some(op => op[1] === 'main.t0' || op[1] === 'main.u0')).toBe(false)
    expect(updates.some(op => op[0] === 'text' || op[0] === 'set')).toBe(true)
  })

  it('does not resurrect evicted settled history until load is explicitly clicked', async () => {
    const entries = history(25)
    const h = harness()
    h.paint(entries)
    h.gone(['main.u1', 'main.t0', 'main.u0', 'main.t1'])
    h.paint(entries)
    const start = h.ops().length
    h.paint(entries)
    expect(h.since(start)).toEqual([])
    const before = h.ops().length
    expect(h.ops()).toContainEqual(expect.arrayContaining(['add', 'main.retention-load']))
    await h.click('main.retention-load')?.()
    h.paint(entries)
    const restored = h.since(before)
      .filter(op => op[0] === 'add' && /main\.[ut][01]$/.test(op[1]))
      .map(op => op[1])
    expect(restored).toEqual(['main.t1', 'main.u1', 'main.t0', 'main.u0'])
    expect(h.ops().some(op => op[0] === 'del' && op[1] === 'main.retention-load')).toBe(true)
  })

  it('reloads at most 40 evicted entries, reveals the oldest reloaded id, then releases the page', () => {
    const entries = history(60)
    const h = harness()
    h.paint(entries)
    const evicted = Array.from({ length: 40 }, (_, i) => ['main.u' + i, 'main.t' + i]).flat()
    h.gone(evicted)
    h.paint(entries)
    h.retention.request(true)
    const start = h.ops().length
    h.paint(entries)
    const added = h.since(start).filter(op => op[0] === 'add' && evicted.includes(op[1]))
    expect(added).toHaveLength(RELOAD_PAGE)
    expect(h.since(start)).toContainEqual(['reveal', 'main.u20', 'start'])
    expect(h.since(start).some(op => op[0] === 'settle' && op[1] === 'main.u20')).toBe(false)
    h.retention.request(true)
    const next = h.ops().length
    h.paint(entries)
    expect(h.since(next)).toContainEqual(['settle', 'main.u20'])
    expect(h.since(next).some(op => op[0] === 'add' && op[1] === 'main.u0')).toBe(true)
  })

  it('ignores foreign evictions, removes old session IDs, and refuses a stale queued Copy', async () => {
    const entries = history(25)
    const copy = vi.fn()
    const h = harness()
    h.paint(entries, context(copy))
    h.gone(['main.t0'], 'another-surface')
    h.paint(entries, context(copy))
    expect(h.ops().some(op => op[1] === 'main.retention-load')).toBe(false)
    const action = h.click('main.u0.tools.copy')
    expect(action).toBeTypeOf('function')
    h.paint([], context(copy))
    await action?.()
    expect(copy).not.toHaveBeenCalled()
    expect(h.ops()).toContainEqual(['del', 'main.u0'])
    expect(h.ops()).not.toContainEqual(['del', 'main.retention-load'])
  })

  it('defers all operations under credit pressure, then catches up on acknowledgement', () => {
    const h = harness()
    const entries = history(25)
    h.setBlocked(true)
    h.paint(entries)
    expect(h.frames).toHaveLength(0)
    entries.push({ at: 1, id: entryId('new-prompt'), kind: 'user', text: 'More' })
    h.paint(entries)
    h.setBlocked(false)
    h.surface.acknowledge(1)
    expect(h.changed).toHaveBeenCalled()
    h.paint(entries)
    expect(h.ops().some(op => op[0] === 'add' && op[1] === 'main.new-prompt')).toBe(true)
  })

  it('has a history-size-independent number of operations for one token', () => {
    const counts = [100, 1000].map(n => {
      const entries = history(n)
      const h = harness()
      h.paint(entries)
      const start = h.ops().length
      const last = turnAt(entries, n - 1)
      last.rev++
      const tail = last.blocks[0]
      if (tail?.kind === 'text') { tail.text += ' token' }
      h.paint(entries)
      return h.since(start).length
    })
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(counts[0])
  })
})
