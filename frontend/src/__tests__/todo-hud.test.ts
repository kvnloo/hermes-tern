import { describe, expect, it, vi } from 'vitest'

import { Hud } from '../chrome/hud.js'
import type { Todo } from '../model.js'
import { TodoHud } from '../todo-hud.js'
import { dockModel, shownPills } from '../view/dockModel.js'

import { dockSources } from './dockFakes.js'

const todo = (id: string, status: Todo['status']): Todo => ({ content: 'Step ' + id, id, status })

describe('session-scoped todo.updated projection', () => {
  it('uses the latest snapshot, without mutating the caller or historical tool state', () => {
    const model = new TodoHud()
    const original = [todo('a', 'pending'), todo('b', 'pending')]

    model.adopt('session-a')
    model.update(original)
    original[0]!.status = 'completed'
    original.push(todo('c', 'in_progress'))

    expect(model.visible(false)).toEqual([todo('a', 'pending'), todo('b', 'pending')])
    model.update([todo('a', 'completed'), todo('b', 'in_progress')])
    expect(model.visible(false)).toEqual([todo('a', 'completed'), todo('b', 'in_progress')])
    expect(original[1]?.status).toBe('pending')
  })

  it('isolates switching and restores a session history only when no event snapshot was cached', () => {
    const model = new TodoHud()
    const history = [todo('a', 'pending')]

    model.adopt('a', history)
    history[0]!.status = 'completed'
    expect(model.visible(false)).toEqual([todo('a', 'pending')])
    model.adopt('b')
    expect(model.visible(false)).toBeUndefined()
    model.update([todo('b', 'in_progress')])
    model.adopt('a', [todo('stale', 'pending')])
    expect(model.visible(false)).toEqual([todo('a', 'pending')])
    model.adopt('b')
    expect(model.visible(false)).toEqual([todo('b', 'in_progress')])
    model.update([])
    expect(model.visible(true, [todo('stale', 'pending')])).toBeUndefined()
  })

  it('hides completed idle work and cancels fully dropped lists, without hiding a busy completion', () => {
    const model = new TodoHud()

    model.adopt('a')
    model.update([todo('a', 'completed'), todo('b', 'cancelled')])
    expect(model.visible(false)).toBeUndefined()
    expect(model.visible(true)).toEqual([todo('a', 'completed'), todo('b', 'cancelled')])
    model.update([todo('a', 'cancelled')])
    expect(model.visible(true)).toBeUndefined()
  })

  it('bounds cached sessions and restores a current snapshot from tool history', () => {
    const model = new TodoHud()

    for (let index = 0; index < 25; index++) {
      model.adopt('session-' + index)
      model.update([todo(String(index), 'pending')])
    }

    model.adopt('session-0')
    expect(model.visible(false)).toBeUndefined()
    model.adopt('session-0', [todo('restored', 'pending')])
    expect(model.visible(false)).toEqual([todo('restored', 'pending')])
  })

  it('feeds the existing dock and keyboard pill, with no replacement checklist renderer', () => {
    const model = new TodoHud()

    model.adopt('a')
    model.update([todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')])
    const sources = dockSources({ todoHud: model })
    const dock = dockModel(sources, 100)

    expect(dock.pills.todos?.list).toEqual([todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')])
    expect(shownPills(sources, 100)).toContain('todos')
    expect(dock.pills.todos?.open).toBe(false)
  })

  it('resets expanded todo UI and focus on a new session, but not a same-session reattach', () => {
    const changed = vi.fn()
    const hud = new Hud({ changed, open: vi.fn() })

    hud.adopt('one')
    hud.toggleTodos()
    expect(hud.todosOpen).toBe(true)
    hud.adopt('one')
    expect(hud.todosOpen).toBe(true)
    hud.adopt('two')
    expect(hud.todosOpen).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
