import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { type NodeJson, plain } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { Todo } from '../model.js'
import { toTodos } from '../transcript/todos.js'
import { parseJson } from '../wire/json.js'
import { dockNodes } from '../view/dock.js'
import { checklistNode } from '../view/todos.js'
import { toolNode } from '../view/tools/shell.js'
import { dockActions, dockContext } from './dockFakes.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

type Phase = { collapsed?: boolean; items: { id: string; status: string; text: string }[]; title?: string }

function phases(n: NodeJson): Phase[] {
  if (n.k === 'checklist') return stub<Phase[]>(n.p?.['phases'])
  for (const child of n.c ?? []) {
    const found = phases(child)
    if (found.length) return found
  }
  return []
}

/** Exercise the pinned producer, not a handwritten approximation of its normalized list. */
function producerTodos(): Todo[] {
  const script = `from tools.todo_tool import TodoStore
import json
s = TodoStore()
print(json.dumps(s.write([
  {'id':'root','content':'Root','status':'completed'},
  {'id':'other','content':'Other root','status':'pending'},
  {'id':'child','content':'Child','parent':'root','status':'completed'},
  {'id':'deep','content':'Deep work','parent':'child','status':'in_progress'},
  {'id':'leaf','content':'Other leaf','parent':'other','status':'cancelled'}
])))`
  const json = execFileSync('python3', ['-c', script], { cwd: resolve('.hermes-src'), encoding: 'utf8' })
  const data = parseJson(json)
  if (!Array.isArray(data)) throw new Error('TodoStore returned no list')
  return toTodos(data)
}

describe('nested todo checklist', () => {
  it('keeps the flat-list projection unchanged', () => {
    const list: Todo[] = [{ id: 'a', content: 'One', status: 'pending' }, { id: 'b', content: 'Two', status: 'completed' }]
    expect(phases(tree(checklistNode(list)))).toEqual([{ id: 'all', items: [
      { id: 'a', status: 'pending', text: 'One' }, { id: 'b', status: 'done', text: 'Two' }
    ] }])
  })

  it('shows every producer item and its own state without collapsing active descendants', () => {
    const list = producerTodos()
    const result = phases(tree(checklistNode(list)))
    expect(result).toHaveLength(1)
    expect(result[0]?.collapsed).not.toBe(true)
    expect(result[0]?.items.map(i => [i.text, i.status])).toEqual([
      ['Root (root)', 'done'], ['Other root (other)', 'pending'], ['Child (child) — under Root (root)', 'done'],
      ['Deep work (deep) — under Child (child)', 'active'], ['Other leaf (leaf) — under Other root (other)', 'dropped']
    ])
    const rendered = plain(stub({ main: [checklistNode(list)] }), 200)
    expect(rendered).toContain('Child (child) — under Root (root)')
    expect(rendered).toContain('Deep work (deep) — under Child (child)')
    expect(list).toEqual(producerTodos())
  })

  it('renders the same producer snapshot through both the tool card and the open dock', () => {
    const list = producerTodos()
    const card = tree(toolNode(call('todo_list', { todos: list }, { todos: list }), 0))
    const cx = dockContext({ pills: { todos: { list, open: true } } })
    const dock = dockNodes(cx, dockActions()).map(tree).flatMap(phases)
    expect(phases(card)).toEqual(phases(tree(checklistNode(list))))
    expect(dock).toEqual(phases(card))
  })

  it('keeps orphans, cycles and ambiguous duplicate IDs visible exactly once', () => {
    const list: Todo[] = [
      { id: 'a', content: 'Cycle A', parent: 'b', status: 'pending' },
      { id: 'b', content: 'Cycle B', parent: 'a', status: 'completed' },
      { id: 'x', content: 'Missing parent', parent: 'missing', status: 'in_progress' },
      { id: 'dup', content: 'Duplicate 1', status: 'pending' },
      { id: 'dup', content: 'Duplicate 2', status: 'completed' },
      { id: 'c', content: 'Ambiguous parent', parent: 'dup', status: 'pending' }
    ]
    const result = phases(tree(checklistNode(list)))
    const items = result.flatMap(p => p.items)
    for (const t of list) expect(items.filter(i => i.text.startsWith(`${t.content} (${t.id})`))).toHaveLength(1)
    expect(new Set(items.map(i => i.id)).size).toBe(list.length)
    expect(items.find(i => i.text.startsWith('Missing parent'))?.text).toContain('parent unavailable (missing)')
    expect(items.find(i => i.text.startsWith('Ambiguous parent'))?.text).toContain('parent unavailable (dup)')
    expect(result[0]?.collapsed).not.toBe(true)
  })

  it('keeps matching parent titles distinguishable and puts the child first', () => {
    const list: Todo[] = [
      { id: 'a', content: 'Shared', status: 'pending' },
      { id: 'b', content: 'Shared', status: 'pending' },
      { id: 'c', content: 'Urgent', parent: 'b', status: 'in_progress' }
    ]
    const text = plain(stub({ main: [checklistNode(list)] }), 200)
    expect(text).toContain('Shared (a)')
    expect(text).toContain('Shared (b)')
    expect(text).toContain('Urgent (c) — under Shared (b)')
  })

  it('projects a full 256-level producer-sized chain without recursive traversal', () => {
    const list: Todo[] = Array.from({ length: 256 }, (_, i) => ({
      content: `Task ${i}`, id: String(i), ...(i ? { parent: String(i - 1) } : {}), status: 'pending'
    }))
    expect(phases(tree(checklistNode(list))).flatMap(p => p.items)).toHaveLength(256)
  })
})
