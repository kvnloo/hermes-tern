// Picker navigation only: model authority stays in the Hermes gateway.
// Ported from Hermes ui-tsp/src/model-recents.ts (Can Bölük / Stencil integration).

export interface RecentModel {
  readonly provider: string
  readonly model: string
}

export const modelId = (row: RecentModel): string => `${row.provider}\t${row.model}`

/** One pane's recent selections, reset when its gateway session changes. */
export class ModelRecents {
  #sid: string | null = null
  #rows: RecentModel[] = []
  #cycling: Promise<void> = Promise.resolve()

  list(sid: string): readonly RecentModel[] {
    if (sid !== this.#sid) {
      this.#sid = sid
      this.#rows = []
    }

    return this.#rows
  }

  remember(sid: string, row: RecentModel): void {
    if (!row.model || !row.provider) {
      return
    }

    this.list(sid)

    if (!this.#rows.some(item => modelId(item) === modelId(row))) {
      this.#rows.push({ model: row.model, provider: row.provider })
      // Bounded navigational state, not durable user model configuration.
      if (this.#rows.length > 32) {
        this.#rows.shift()
      }
    }
  }

  /** Await the last switch before reading the gateway's active/pending route. */
  enqueue(run: () => Promise<void>): Promise<void> {
    this.#cycling = this.#cycling.then(run, run)

    return this.#cycling
  }
}

const panes = new WeakMap<object, ModelRecents>()

/** A stable SessionState object uniquely owns one pane's recents and queue. */
export function modelRecents(pane: object): ModelRecents {
  let history = panes.get(pane)

  if (!history) {
    history = new ModelRecents()
    panes.set(pane, history)
  }

  return history
}
