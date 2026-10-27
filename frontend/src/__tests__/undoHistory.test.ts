import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UndoHistory, type Snapshot } from '../draft/undo.js'

function snap(text: string, cursor = text.length, pasted: string[] = []): Snapshot {
  return { text, cursor, pasted }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(10_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UndoHistory', () => {
  it('emptyUndoRedo: returns undefined when no step exists in either direction', () => {
    const history = new UndoHistory()
    const current = snap('x')

    expect(history.undo(current)).toBeUndefined()
    expect(history.redo(current)).toBeUndefined()
  })

  it('recordThenUndo: restores the exact snapshot, cursor and paste provenance once', () => {
    const history = new UndoHistory()
    const before = snap('!ls', 1, ['!ls'])
    const current = snap('edited')

    history.record(before, { merge: false })

    const restored = history.undo(current)
    expect(restored).toBe(before)
    expect(restored?.cursor).toBe(1)
    expect(restored?.pasted).toEqual(['!ls'])
    expect(history.undo(current)).toBeUndefined()
  })

  it('redoAfterUndo: replays current and restores the undone step for another undo', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const current = snap('ab')

    history.record(before, { merge: false })

    expect(history.undo(current)).toBe(before)
    expect(history.redo(before)).toBe(current)
    expect(history.undo(current)).toBe(before)
  })

  it('mergeWithinWindow: merges typing records 100 ms apart into one step', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    history.record(before, { merge: true })
    vi.setSystemTime(10_100)
    history.record(second, { merge: true })

    expect(history.undo(current)).toBe(before)
    expect(history.undo(current)).toBeUndefined()
  })

  it('mergeBoundary800: joins at exactly 800 ms but splits at 801 ms', () => {
    const joined = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    joined.record(before, { merge: true })
    vi.setSystemTime(10_800)
    joined.record(second, { merge: true })

    expect(joined.undo(current)).toBe(before)
    expect(joined.undo(current)).toBeUndefined()

    const split = new UndoHistory()
    vi.setSystemTime(10_000)
    split.record(before, { merge: true })
    vi.setSystemTime(10_801)
    split.record(second, { merge: true })

    expect(split.undo(current)).toBe(second)
    expect(split.undo(current)).toBe(before)
    expect(split.undo(current)).toBeUndefined()
  })

  it('nonMergeAlwaysSteps: non-merge edits and a merge after non-merge start new steps', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    history.record(before, { merge: false })
    history.record(second, { merge: false })

    expect(history.undo(current)).toBe(second)
    expect(history.undo(current)).toBe(before)
    expect(history.undo(current)).toBeUndefined()

    const next = new UndoHistory()
    next.record(before, { merge: false })
    vi.setSystemTime(10_010)
    next.record(second, { merge: true })

    expect(next.undo(current)).toBe(second)
    expect(next.undo(current)).toBe(before)
  })

  it('mergeWithEmptyUndo: creates the first step even when time is inside 800 ms', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const current = snap('ab')

    vi.setSystemTime(100)
    history.record(before, { merge: true })

    expect(history.undo(current)).toBe(before)
  })

  it('recordDropsRedo: recording a new edit invalidates previously undone steps', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const current = snap('ab')
    const newBefore = snap('ac')

    history.record(before, { merge: false })
    expect(history.undo(current)).toBe(before)
    history.record(newBefore, { merge: false })

    expect(history.redo(snap('anything'))).toBeUndefined()
    expect(history.undo(snap('acd'))).toBe(newBefore)
  })

  it('breakBurstSplits: explicit burst break creates a distinct undo step', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    history.record(before, { merge: true })
    history.breakBurst()
    vi.setSystemTime(10_010)
    history.record(second, { merge: true })

    expect(history.undo(current)).toBe(second)
    expect(history.undo(current)).toBe(before)
  })

  it('undoEndsBurst: undo prevents the following merge edit from joining a previous step', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    history.record(before, { merge: true })
    expect(history.undo(current)).toBe(before)
    vi.setSystemTime(10_010)
    history.record(second, { merge: true })

    expect(history.undo(current)).toBe(second)
    expect(history.undo(current)).toBeUndefined()
  })

  it('clearForgetsAll: clears both undo and redo even after an undo', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('ab')
    const current = snap('abc')

    history.record(before, { merge: false })
    history.record(second, { merge: false })
    expect(history.undo(current)).toBe(second)
    history.clear()

    expect(history.undo(current)).toBeUndefined()
    expect(history.redo(current)).toBeUndefined()
  })

  it('cappedAt200: evicts the oldest five of 205 non-merged steps', () => {
    const history = new UndoHistory()
    const current = snap('current')

    for (let i = 0; i < 205; i++) {
      history.record(snap(`n${i}`), { merge: false })
    }

    const undone: string[] = []
    let restored = history.undo(current)
    while (restored !== undefined) {
      undone.push(restored.text)
      restored = history.undo(current)
    }

    expect(undone).toHaveLength(200)
    expect(undone[0]).toBe('n204')
    expect(undone[199]).toBe('n5')
    expect(undone).toEqual(Array.from({ length: 200 }, (_, i) => `n${204 - i}`))
  })

  it('pastedPreserved: undo carries pasted command text unchanged', () => {
    const history = new UndoHistory()
    const before = snap('!ls', 3, ['!ls'])

    history.record(before, { merge: false })

    const restored = history.undo(snap(''))
    expect(restored).toBe(before)
    expect(restored?.pasted).toEqual(['!ls'])
  })

  it('recordAfterClearWithinWindow: empty history records a merge immediately after clear', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const second = snap('b')
    const current = snap('bc')

    history.record(before, { merge: true })
    history.clear()
    vi.setSystemTime(10_010)
    history.record(second, { merge: true })

    expect(history.undo(current)).toBe(second)
    expect(history.undo(current)).toBeUndefined()
  })

  it('emptyPopDoesNotChangeRedo: an exhausted undo cannot add a redo step', () => {
    const history = new UndoHistory()
    const before = snap('a')
    const current = snap('ab')

    history.record(before, { merge: false })
    expect(history.undo(current)).toBe(before)
    expect(history.undo(snap('not a step'))).toBeUndefined()
    expect(history.redo(before)).toBe(current)
    expect(history.redo(before)).toBeUndefined()
  })
})
