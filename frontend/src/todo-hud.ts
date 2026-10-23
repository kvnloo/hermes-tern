// A bounded, session-scoped projection of todo.updated, never the stored tool-card history.
// Adapted from Hermes ui-tsp/src/todo-hud.ts, over the plugin's existing todo/checklist renderer.

import type { Todo } from './model.js'
import { todos } from './chrome/hud.js'

const MAX_CACHED_SESSIONS = 24

export class TodoHud {
  #active: string | null = null
  readonly #plans = new Map<string, Todo[]>()

  /** Select this session's latest snapshot; seed it from history only on first sight. */
  adopt(key: string | null, history?: readonly Todo[]): void {
    this.#active = key

    if (key && !this.#plans.has(key) && history?.length) {
      this.#remember(key, history)
    }
  }

  /** An empty event clears the current projection, without rewriting old tool cards. */
  update(next: readonly Todo[]): void {
    if (this.#active) {
      this.#remember(this.#active, next)
    }
  }

  /** Prefer this session's event snapshot, including an empty one, then its restored history. */
  visible(turnRunning: boolean, history?: readonly Todo[]): Todo[] | undefined {
    const snapshot = this.#active ? this.#plans.get(this.#active) : undefined
    const plan = snapshot ?? history

    return todos(plan ? [...plan] : undefined, turnRunning)
  }

  #remember(key: string, plan: readonly Todo[]): void {
    // Copy both container and items: event snapshots must not become mutable transcript state.
    this.#plans.delete(key)
    this.#plans.set(key, plan.map(todo => ({ ...todo })))

    while (this.#plans.size > MAX_CACHED_SESSIONS) {
      this.#plans.delete(this.#plans.keys().next().value!)
    }
  }
}
