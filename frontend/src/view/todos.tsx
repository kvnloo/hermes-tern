// The todo list as a Tern `checklist`, as the Todo card and the dock show it.

import type { JSX } from '@stencil-hq/tern'

import type { Todo } from '../model.js'
import { TODO_LOOK } from '../transcript/todos.js'

/** The todos as a checklist: the full ordered list, with parent references for nested items. */
export function checklistNode(todos: Todo[]): JSX.Element {
  const item = (t: Todo) => ({ id: t.id, status: TODO_LOOK[t.status].item, text: t.content })
  const nested = todos.some(t => t.parent)
  // Tern has flat items within a phase. Preserve Hermes' priority order in one
  // phase, with each item's parent in its text: plain output omits item notes.
  const phases = nested ? nestedPhases(todos) : [{ id: 'all', items: todos.map(item) }]

  return <checklist key="list" mode="full" phases={phases} />
}

/** A linear projection also tolerates old or malformed snapshots. */
function nestedPhases(todos: Todo[]) {
  // An ambiguous duplicate cannot safely identify a parent. Keep both rows and
  // disclose the unresolved reference instead of attaching it to the wrong row.
  const byId = new Map<string, number | null>()
  todos.forEach((t, i) => byId.set(t.id, byId.has(t.id) ? null : i))
  return [{
    id: 'all',
    items: todos.map((t, i) => {
      const parent = t.parent ? (byId.get(t.parent) ?? -1) : -1
      const label = `${t.content} (${t.id})`

      return {
        id: `todo:${i}`,
        status: TODO_LOOK[t.status].item,
        text: t.parent
          ? `${label} — ${parent >= 0 ? `under ${todos[parent]?.content} (${t.parent})` : `parent unavailable (${t.parent})`}`
          : label
      }
    })
  }]
}
