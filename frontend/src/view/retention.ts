// Bounded TSP presentation retention. Hermes' Transcript remains the authoritative history.
// Adapted from kvnloo/hermes-agent ui-tsp/src/retention.ts and RETENTION.md
// (Hermes contributors; Tern/OMP public SDK primitives by Can Bölük / Stencil, MIT).
import { Node, node, type Op, Surface, Tree, type TspEvent, View, type ViewInput } from '@stencil-hq/tern'

import type { Entry } from '../model.js'

import { entryNode, forgetEntryNode, type TranscriptContext } from './transcript.js'

export const RETAIN_TURNS = 20
export const RELOAD_PAGE = 40
const LOAD_ID = 'main.retention-load'

interface Resident {
  readonly id: string
  readonly entry: Entry
  index: number
  revision: number
  status: string
  present: boolean
  settled: boolean
  evicted: boolean
  tree?: Tree | undefined
  readonly missing: Set<string>
}

/** Drop evicted descendants from a saved SDK view before diffing it. */
function withoutGone(view: View, gone: readonly string[]): View {
  class Remaining extends Tree {
    override readonly children: readonly Tree[]

    constructor(tree: Tree) {
      super(tree.id, new Node(tree.kind, tree.props, [], tree.node.handlers))
      this.children = tree.children.filter(child => !gone.includes(child.id)).map(child => new Remaining(child))
    }
  }

  return new View(view.regions.map(tree => (tree && !gone.includes(tree.id) ? new Remaining(tree) : undefined)))
}

/** A turn is cold only when it has no consequential unresolved or failed work. */
export function safeToSettle(entry: Entry): boolean {
  if (entry.kind === 'welcome') {
    return false
  }

  if (entry.kind === 'notice') {
    return entry.tone !== 'error' && entry.tone !== 'warning'
  }

  if (entry.kind === 'compaction') {
    return entry.compaction.state.status === 'done'
  }

  if (entry.kind !== 'turn') {
    return true
  }

  return entry.end.status === 'done' && !entry.warning && entry.blocks.every(block => {
    if (block.kind === 'compaction') {
      return block.compaction.state.status === 'done'
    }

    if (block.kind !== 'tool') {
      return true
    }

    return (block.call.outcome.kind === 'done' || block.call.outcome.kind === 'cancelled') &&
      (block.call.subagents ?? []).every(agent => agent.status === 'done' || agent.status === 'cancelled')
  })
}

/** A prompt stays resident until its following assistant turn safely completes. */
function safePrompt(index: number, entries: readonly Entry[]): boolean {
  if (entries[index]?.kind !== 'user') {
    return true
  }

  for (let i = index + 1; i < entries.length; i++) {
    const next = entries[i]

    if (next?.kind === 'user') {
      return true
    }

    if (next?.kind === 'turn') {
      return safeToSettle(next)
    }
  }

  return false
}

/** Return the first entry before the newest 20 completed assistant turns. */
export function retentionBoundary(entries: readonly Entry[]): number {
  let completed = 0

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]

    if (entry?.kind === 'turn' && entry.end.status !== 'live' && ++completed === RETAIN_TURNS) {
      return entries[i - 1]?.kind === 'user' ? i - 1 : i
    }
  }

  return 0
}

/**
 * One writer for main, plus a public View diff for dock and layer.
 * Both regions share one Surface.send frame and its real credit queue.
 * With no 'settle' capability, the caller retains ordinary Surface.render.
 */
export class Retention {
  readonly #surface: Surface
  readonly #changed: () => void
  #chrome = new View()
  #chromeRouter: Surface | undefined
  readonly #byId = new Map<string, Resident>()
  #ordered: Resident[] = []
  readonly #hot = new Set<Resident>()
  readonly #evicted = new Set<Resident>()
  #reading = new Set<Resident>()
  #source: readonly Entry[] | undefined
  #tail: Entry | undefined
  #length = -1
  #boundary = 0
  #held = false
  #copied: string | undefined
  #cx: TranscriptContext | undefined
  #requested = false
  #reveal = false
  #loadShown = false
  #dirty = false

  constructor(surface: Surface, changed: () => void) {
    this.#surface = surface
    this.#changed = changed

    // SDK 0.1 has no public child-forget or dispatch-adoption API. A non-listening
    // SDK Surface routes gestures, while this writer owns the exact resident main.
    surface.dispatch = event => this.dispatch(event)

    const acknowledge = surface.acknowledge.bind(surface)
    surface.acknowledge = sequence => {
      acknowledge(sequence)

      if (this.#dirty && !surface.blocked && !surface.closed) {
        this.#changed()
      }
    }
  }

  /** Explicit history intent; current native SDK has no scroll-end/reload event. */
  request(reveal = false): void {
    this.#requested = true
    this.#reveal ||= reveal
    this.#changed()
  }

  /** The peer evicted nodes; never target their IDs until an explicit reload. */
  gone(event: TspEvent): void {
    if (event.ev !== 'gone' || event.sf !== this.#surface.id) {
      return
    }

    const gone = event.ids
    this.#chrome = withoutGone(this.#chrome, gone)
    this.#chromeRouter = undefined

    if (gone.includes('main') || gone.includes(LOAD_ID)) {
      this.#loadShown = false
    }

    for (const row of this.#ordered) {
      if (!row.present) {
        continue
      }

      const rootLost = gone.includes('main') || gone.includes(row.id)
      const descendants = gone.filter(id => id.startsWith(row.id + '.'))

      if (!rootLost && !descendants.length) {
        continue
      }

      forgetEntryNode(row.entry)

      if (rootLost) {
        row.present = false
        row.evicted = true
        row.tree = undefined
        row.missing.clear()
        this.#evicted.add(row)
      } else {
        for (const id of descendants) {
          row.missing.add(id)
        }
      }

      // Do not resurrect cold settled history on an ordinary streaming frame.
      if (!row.settled || !rootLost) {
        this.#hot.add(row)
      }
    }

    this.#changed()
  }

  /** A surface gesture is rebuilt against its addressed row, not all old handlers. */
  dispatch(event: TspEvent): ReturnType<Surface['dispatch']> {
    if (!('sf' in event) || event.sf !== this.#surface.id) {
      return undefined
    }

    if (!('id' in event) || !event.id?.startsWith('main.')) {
      return this.#chromeRouter?.dispatch(event)
    }

    if (event.ev === 'action' && event.id === LOAD_ID && event.act === 'click') {
      return () => this.request()
    }

    if (event.ev !== 'action' || !this.#cx) {
      return undefined
    }

    const key = event.id.slice('main.'.length).split('.')[0]
    const row = key ? this.#byId.get(key) : undefined

    if (!row || !row.present || row.evicted) {
      return undefined
    }

    const router = new Surface({ send() {}, credits: () => 1, dropped() {} }, this.#surface.id, { listen: false })
    router.render({ main: [entryNode(row.entry, row.id, this.#cx)] })
    const action = router.dispatch(event)

    if (row.settled) {
      forgetEntryNode(row.entry)
    }

    return action && (() => {
      if (this.#byId.get(row.entry.id) !== row || !row.present || row.evicted) {
        return
      }

      return action()
    })
  }

  /** Send just changed rows plus chrome; no old JSX or Tree rebuild on tokens. */
  paint(chrome: ViewInput, entries: readonly Entry[], cx: TranscriptContext, hold: boolean): void {
    if (this.#surface.closed) {
      return
    }

    if (this.#surface.blocked) {
      this.#dirty = true

      return
    }

    this.#dirty = false
    this.#cx = cx
    const view = { ...chrome, main: [] }
    const next = View.from(view)
    const ops: Op[] = this.#chrome.ops(next, this.#surface.id)
    this.#chrome = next
    this.#chromeRouter = new Surface({ send() {}, credits: () => 1, dropped() {} }, this.#surface.id, { listen: false })
    this.#chromeRouter.render(view)

    const structural = entries !== this.#source || entries.length !== this.#length || entries.at(-1) !== this.#tail
    let boundaryChanged = structural

    if (structural) {
      const current = new Set(entries)

      for (const row of this.#ordered) {
        if (current.has(row.entry)) {
          continue
        }

        if (row.present) {
          ops.push(['del', row.id])
        }

        forgetEntryNode(row.entry)
        this.#hot.delete(row)
        this.#evicted.delete(row)
        this.#reading.delete(row)
        this.#byId.delete(row.entry.id)
      }

      const ordered: Resident[] = []

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]

        if (!entry) {
          continue
        }

        let row = this.#byId.get(entry.id)

        if (!row || row.entry !== entry) {
          if (row?.present) {
            ops.push(['del', row.id])
          }

          if (row) {
            forgetEntryNode(row.entry)
            this.#hot.delete(row)
            this.#evicted.delete(row)
            this.#reading.delete(row)
          }

          row = {
            entry, id: 'main.' + entry.id, index: i, revision: -1,
            status: '', present: false, settled: false, evicted: false, missing: new Set()
          }
          this.#byId.set(entry.id, row)
          this.#hot.add(row)
        }

        row.index = i
        ordered.push(row)
      }

      this.#ordered = ordered
      this.#source = entries
      this.#length = entries.length
      this.#tail = entries.at(-1)
    }

    for (const row of this.#ordered) {
      const rev = row.entry.kind === 'turn' || row.entry.kind === 'compaction' ? row.entry.rev : 0
      const status = row.entry.kind === 'turn' ? row.entry.end.status : ''

      if (rev !== row.revision) {
        row.revision = rev
        this.#hot.add(row)
      }

      if (status !== row.status) {
        row.status = status
        boundaryChanged = true
        this.#hot.add(row)
      }
    }

    if (boundaryChanged) {
      this.#boundary = retentionBoundary(entries)

      for (const row of this.#ordered) {
        if (row.index >= this.#boundary && row.settled && !row.evicted) {
          this.#hot.add(row)
        } else if (row.index < this.#boundary && !row.settled) {
          this.#hot.add(row)
        }
      }
    }

    if (this.#copied !== cx.copied) {
      if (this.#copied) {
        const old = this.#byId.get(this.#copied)
        if (old) { this.#hot.add(old) }
      }

      if (cx.copied) {
        const current = this.#byId.get(cx.copied)
        if (current) { this.#hot.add(current) }
      }

      this.#copied = cx.copied
    }

    if (this.#held !== hold) {
      this.#held = hold

      if (!hold) {
        for (const row of this.#ordered) {
          if (row.index < this.#boundary && !row.settled) {
            this.#hot.add(row)
          }
        }
      }
    }

    const reload = this.#requested
      ? [...this.#evicted].sort((a, b) => a.index - b.index).slice(-RELOAD_PAGE)
      : []
    this.#requested = false

    if (reload.length) {
      for (const row of this.#reading) {
        this.#hot.add(row)
      }

      this.#reading = new Set(reload)

      for (const row of reload) {
        row.evicted = false
        this.#evicted.delete(row)
        this.#hot.add(row)
      }
    }

    for (const row of [...this.#hot].sort((a, b) => b.index - a.index)) {
      this.#hot.delete(row)
      const settle = !hold && !this.#reading.has(row) && row.index < this.#boundary &&
        safeToSettle(row.entry) && safePrompt(row.index, entries)

      if (row.evicted && settle) {
        continue
      }

      const projected = entryNode(row.entry, row.id, cx)

      if (!(projected instanceof Node)) {
        throw new Error('Transcript entry must project to a Tern Node')
      }

      const tree = new Tree(row.id, projected)
      const before = this.#nextResident(row.index)

      if (!row.present) {
        ops.push(['add', row.id, 'main', before, tree.wire()])
      } else if (row.tree) {
        class Prior extends Tree {
          override readonly children: readonly Tree[]
          constructor(child: Tree) {
            super('main', node('col', {}))
            this.children = [child]
          }
        }

        const prior = new View([new Prior(row.tree)])
        const resident = row.missing.size ? withoutGone(prior, [...row.missing]) : prior
        const changes = resident.ops(View.from({ main: [tree.node] }), this.#surface.id)

        for (const op of changes) {
          if ((op[0] === 'add' || op[0] === 'move') && op[2] === 'main' && op[3] === null) {
            if (op[0] === 'add') {
              ops.push(['add', op[1], op[2], before, op[4]])
            } else {
              ops.push(['move', op[1], op[2], before])
            }
          } else {
            ops.push(op)
          }
        }
      } else {
        // Settled trees were deliberately released: rebuild this one row only.
        ops.push(['del', row.id], ['add', row.id, 'main', before, tree.wire()])
      }

      row.present = true
      row.evicted = false
      this.#evicted.delete(row)
      row.missing.clear()
      row.settled = settle
      row.tree = settle ? undefined : tree

      if (settle) {
        ops.push(['settle', row.id])
        forgetEntryNode(row.entry)
      }
    }

    const missing = this.#evicted.size > 0

    if (missing !== this.#loadShown) {
      if (missing) {
        const load = new Tree(LOAD_ID, node('el', {
          tag: 'button', aria: 'Load older history', key: 'retention-load',
          role: 'omp.history.load', text: 'Load older history · Ctrl+Home',
          actions: { click: 'click' }
        }))
        ops.push(['add', LOAD_ID, 'main', this.#nextResident(-1), load.wire()])
      } else {
        ops.push(['del', LOAD_ID])
      }

      this.#loadShown = missing
    }

    if (this.#reveal) {
      const first = reload[0]
      ops.push(first ? ['reveal', first.id, 'start'] : ['scroll', 'main', 'start'])
      this.#reveal = false
    }

    if (ops.length) {
      this.#surface.send(ops)
    }
  }

  #nextResident(index: number): string | null {
    for (let i = index + 1; i < this.#ordered.length; i++) {
      const next = this.#ordered[i]

      if (next?.present && !next.evicted) {
        return next.id
      }
    }

    return null
  }
}
