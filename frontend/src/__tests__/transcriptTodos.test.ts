import { describe, expect, it } from 'vitest'

import type { Entry, Todo } from '../model.js'
import { TODO_LOOK, currentTodos, todoProgress, todosOf, toTodos } from '../transcript/todos.js'

import { stub } from './fakes.js'

const todo = (id: string, status: Todo['status'], content = 'Step ' + id, parent?: string): Todo => ({
  content,
  id,
  ...(parent === undefined ? {} : { parent }),
  status
})

function toolBlock(todos?: Todo[]): { kind: 'tool'; call: { todos: Todo[] | undefined } } {
  return { kind: 'tool', call: { todos } }
}

function turn(...blocks: ReturnType<typeof toolBlock>[]): Entry {
  return stub<Entry>({ kind: 'turn', blocks })
}

describe('transcript todo snapshots and merges', () => {
  it('TODO_LOOK maps every todo status to its checklist appearance', () => {
    expect(TODO_LOOK).toEqual({
      cancelled: { item: 'dropped' },
      completed: { item: 'done' },
      in_progress: { item: 'active' },
      pending: { item: 'pending' }
    })
  })

  it('todoProgress excludes cancelled items from totals and reports the active content', () => {
    const list = [
      todo('a', 'completed', 'a'),
      todo('b', 'in_progress', 'b'),
      todo('c', 'pending', 'c'),
      todo('d', 'cancelled', 'd')
    ]

    expect(todoProgress(list)).toEqual({ current: 'b', done: 1, total: 3 })
  })

  it('todoProgress chooses an in-progress item before an earlier pending item', () => {
    expect(todoProgress([
      todo('p', 'pending', 'waiting'),
      todo('a', 'in_progress', 'running')
    ])).toEqual({ current: 'running', done: 0, total: 2 })
    expect(todoProgress([todo('p', 'pending', 'waiting')]))
      .toEqual({ current: 'waiting', done: 0, total: 1 })
  })

  it('todoProgress reports no current task for completed-only and empty lists', () => {
    expect(todoProgress([todo('a', 'completed'), todo('b', 'completed')]))
      .toEqual({ current: '', done: 2, total: 2 })
    expect(todoProgress([])).toEqual({ current: '', done: 0, total: 0 })
  })

  it('toTodos_normalises full, empty and numeric-id snapshots', () => {
    expect(toTodos([{ id: 'a', content: 'x', status: 'in_progress', parent: 'p' }]))
      .toEqual([{ content: 'x', id: 'a', parent: 'p', status: 'in_progress' }])
    expect(toTodos([{}])).toEqual([{ content: '', id: '0', status: 'pending' }])
    expect(toTodos([{ id: 7, content: 'seven', status: 'pending' }]))
      .toEqual([{ content: 'seven', id: '7', status: 'pending' }])
  })

  it('toTodos_skipsNonObjects and numbers retained entries from zero', () => {
    expect(toTodos([null, 5, 'x', { content: 'a' }]))
      .toEqual([{ content: 'a', id: '0', status: 'pending' }])
  })

  it('toTodos_statusAndParent accepts only exact statuses and omits empty parents', () => {
    const statuses = toTodos([
      { status: 'weird' },
      { status: 'done' },
      { status: 'COMPLETED' },
      { status: 'completed' },
      { status: 'cancelled' }
    ])
    expect(statuses.map(item => item.status))
      .toEqual(['pending', 'pending', 'pending', 'completed', 'cancelled'])

    const noParents = toTodos([{ id: 'empty', parent: '' }, { id: 'null', parent: null }])
    expect(noParents[0]).not.toHaveProperty('parent')
    expect(noParents[1]).not.toHaveProperty('parent')
  })

  it('toTodos_nullId preserves the string "null" when an id key exists', () => {
    expect(toTodos([{ id: null, content: 'x' }]))
      .toEqual([{ content: 'x', id: 'null', status: 'pending' }])
  })

  it('todosOf_replace discards current tasks for false and undefined merge', () => {
    const raw = { id: 'a', content: '  raw ', status: 'completed' }
    const current = [todo('old', 'pending')]
    const expected = toTodos([raw])

    expect(todosOf({ merge: false, todos: [raw] }, current)).toEqual(expected)
    // The runtime also accepts callers with no merge flag, despite TodoDetail typing it boolean.
    expect(todosOf(stub({ merge: undefined, todos: [raw] }), current)).toEqual(expected)
    expect(current).toEqual([todo('old', 'pending')])
  })

  it('todosOf_mergeUpdates trims fields, preserves omitted values and does not mutate current', () => {
    const original = todo('a', 'pending', 'A')
    const current = [original]

    const completed = todosOf({ merge: true, todos: [{ id: 'a', status: ' Completed ' }] }, current)
    expect(completed).toEqual([todo('a', 'completed', 'A')])
    expect(completed[0]).not.toBe(original)
    expect(original.status).toBe('pending')

    expect(todosOf({ merge: true, todos: [{ id: 'a', content: '  New ' }] }, current))
      .toEqual([todo('a', 'pending', 'New')])
    expect(todosOf({ merge: true, todos: [{ id: 'a', content: '  ', status: 'weird' }] }, current))
      .toEqual([todo('a', 'pending', 'A')])
    expect(current).toEqual([todo('a', 'pending', 'A')])
  })

  it('todosOf_mergeAppends trims ids, defaults new statuses and accepts undefined current', () => {
    const patch = [{ id: ' n1 ', content: 'Fresh' }]
    const expected = [todo('n1', 'pending', 'Fresh')]

    expect(todosOf({ merge: true, todos: patch }, [])).toEqual(expected)
    expect(todosOf({ merge: true, todos: patch }, undefined)).toEqual(expected)
    expect(todosOf({ merge: true, todos: [{ id: 'n2', content: 'Other', status: 'weird' }] }, []))
      .toEqual([todo('n2', 'pending', 'Other')])
  })

  it('todosOf_mergeSkips rejects invalid patches but applies JSON-string object updates', () => {
    const patches: unknown[] = [
      { id: 'missing-content' },
      { id: 'blank-content', content: '   ' },
      { content: 'missing id' },
      { id: '', content: 'blank id' },
      { id: '   ', content: 'spaces id' },
      { id: null, content: 'null id' },
      null,
      5,
      '{"id":"a","status":"completed"}',
      '[{"id":"array","content":"not an object"}]'
    ]

    expect(todosOf({ merge: true, todos: patches }, [todo('a', 'pending', 'A')]))
      .toEqual([todo('a', 'completed', 'A')])
  })

  it('todosOf_mergeParent sets, clears and retains parent according to supplied keys', () => {
    const withParent = [todo('b', 'pending', 'B', 'a')]

    expect(todosOf({ merge: true, todos: [{ id: 'b', parent: 'a' }] }, [todo('b', 'pending')])[0])
      .toHaveProperty('parent', 'a')

    for (const parent of ['', null, 'b']) {
      const updated = todosOf({ merge: true, todos: [{ id: 'b', parent }] }, withParent)
      expect(updated[0]).not.toHaveProperty('parent')
    }

    expect(todosOf({ merge: true, todos: [{ id: 'b', status: 'completed' }] }, withParent)[0])
      .toHaveProperty('parent', 'a')
    expect(withParent[0]).toHaveProperty('parent', 'a')
  })

  it('currentTodos_empty returns undefined', () => {
    expect(currentTodos([])).toBeUndefined()
  })

  it('currentTodos selects the newest turn snapshot by array identity', () => {
    const oldTodos = [todo('old', 'pending')]
    const newTodos = [todo('new', 'in_progress')]

    expect(currentTodos([turn(toolBlock(oldTodos)), turn(toolBlock(newTodos))])).toBe(newTodos)
  })

  it('currentTodos selects the last non-empty tool block within a turn', () => {
    const first = [todo('first', 'pending')]
    const last = [todo('last', 'completed')]

    expect(currentTodos([turn(toolBlock(first), toolBlock(last))])).toBe(last)
  })

  it('currentTodos skips empty and missing tool snapshots across blocks and turns', () => {
    const earlier = [todo('earlier', 'pending')]

    expect(currentTodos([turn(toolBlock(earlier), toolBlock([]), toolBlock(undefined))])).toBe(earlier)
    expect(currentTodos([
      turn(toolBlock(earlier)),
      turn(toolBlock([]), toolBlock(undefined))
    ])).toBe(earlier)
  })

  it('currentTodos ignores non-turn entries even when they carry tool-shaped data', () => {
    const earlier = [todo('earlier', 'pending')]
    const ignored = turn(toolBlock([todo('ignored', 'pending')]))
    Reflect.set(ignored, 'kind', 'notice')

    expect(currentTodos([turn(toolBlock(earlier)), ignored])).toBe(earlier)
    expect(currentTodos([ignored])).toBeUndefined()
  })

  it('currentTodos returns undefined when no turn has a non-empty snapshot', () => {
    expect(currentTodos([turn(), turn(toolBlock(undefined), toolBlock([]))])).toBeUndefined()
  })
})
