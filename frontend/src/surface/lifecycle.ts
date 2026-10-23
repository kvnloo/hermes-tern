// Presentation lifetime only: Hermes session state and gateway intents stay in App.
// Adapted from kvnloo/hermes-agent ui-tsp/src/surface-protocol.ts (Hermes contributors).
// Public @stencil-hq/tern SDK by Can Bölük / Stencil (MIT); no private protocol hooks.
import { Node, Surface, Tree, type Renderable, type Session, type TspEvent, View } from '@stencil-hq/tern'

export const ACK_STALL_MS = 5000
export const MAX_SURFACE_RECOVERIES = 3
export type SurfaceState = 'visible' | 'hidden' | 'detached' | 'failed' | 'disposed'

/** The peer owns all unreported siblings, including unkeyed children. */
export function withoutGone(view: View, lost: readonly string[]): View {
  class Remaining extends Tree {
    override readonly children: readonly Tree[]

    constructor(tree: Tree) {
      super(tree.id, new Node(tree.kind, tree.props, [], tree.node.handlers))
      this.children = tree.children.filter(child => !lost.includes(child.id)).map(child => new Remaining(child))
    }
  }

  return new View(view.regions.map(root => (root && !lost.includes(root.id) ? new Remaining(root) : undefined)))
}

/** Non-retained view reconciliation. Retention is the sole writer when settle is supported. */
export class SurfaceView {
  #resident = new View()
  #router: Surface | undefined

  forget(ids: readonly string[]) {
    this.#resident = withoutGone(this.#resident, ids)
    this.#router = undefined
  }

  paint(surface: Surface, input: Renderable): boolean {
    if (surface.blocked || surface.closed) {
      return false
    }

    const next = View.from(input)
    const ops = this.#resident.ops(next, surface.id)
    const router = new Surface({ send() {}, credits: () => 1, dropped() {} }, surface.id, { listen: false })
    router.render(input)
    if (ops.length) {
      surface.send(ops)
    }
    this.#resident = next
    this.#router = router

    return true
  }

  dispatch(event: TspEvent): ReturnType<Surface['dispatch']> {
    return this.#router?.dispatch(event)
  }
}

export interface SurfaceLifecycleHost {
  changed(): void
  replaced(surface: Surface): void
  report(message: string): void
}

/**
 * A single, credit-paced document epoch. No SDK queue replay or timer-driven reopen:
 * only a real whole-document gone, when visible, may allocate another document.
 */
export class SurfaceLifecycle {
  readonly #tern: Session
  readonly #host: SurfaceLifecycleHost
  readonly #title: string
  #surface!: Surface
  #state: SurfaceState = 'visible'
  #visible = true
  #missing = false
  #recoveries = 0
  #dirty = false
  #stalled = false
  #watchdog: ReturnType<typeof setTimeout> | undefined

  constructor(tern: Session, title: string, host: SurfaceLifecycleHost) {
    this.#tern = tern
    this.#title = title
    this.#host = host
    this.#surface = this.#open()
  }

  get raw(): Surface {
    return this.#surface
  }

  get state(): SurfaceState {
    return this.#state
  }

  get sdk(): boolean {
    return typeof this.#surface.seq === 'number' &&
      typeof this.#surface.send === 'function' &&
      typeof this.#surface.acknowledge === 'function'
  }

  /** A previously skipped render/control must be rebuilt from live state after real credit. */
  defer() {
    this.#dirty = true
  }

  rendered() {
    this.#watch()
  }

  /** Returns whether this epoch can consume the event. Child gone is delivered even when hidden. */
  event(event: TspEvent): boolean {
    if (this.#state === 'disposed' || this.#state === 'failed') {
      return false
    }

    const sf = 'sf' in event ? event.sf : undefined
    const current = this.#surface

    if (event.ev === 'gone' && (!sf || sf === current.id) && event.ids.includes(current.id)) {
      current.gone()
      this.#missing = true
      this.#state = 'detached'
      this.#dirty = false
      this.#clearWatch()
      this.#recover()

      return false
    }

    if (sf && sf !== current.id) {
      return false
    }

    if (event.ev === 'unknown' && ['ack', 'error', 'gone'].includes(String(event.raw['ev']))) {
      this.failure('Tern sent a malformed ' + String(event.raw['ev']) + ' protocol event.')
      return false
    }

    if (event.ev === 'error') {
      const where = [event.s === undefined ? '' : 'frame ' + event.s, event.op === undefined ? '' : 'op ' + event.op].filter(Boolean).join(', ')
      this.failure('Tern protocol rejected ' + (where || 'an operation') + ': ' + event.msg)
      return false
    }

    if (event.ev === 'gone') {
      this.#dirty = true
      return true
    }

    if ((event.ev === 'visible' || event.ev === 'resize') && event.visible !== undefined) {
      this.#visible = event.visible
      this.#state = this.#missing ? 'detached' : event.visible ? 'visible' : 'hidden'
      this.#clearWatch()
      if (event.visible) {
        this.#recover()
        this.#host.changed()
        this.#watch()
      }
    }

    return this.#state === 'visible'
  }

  /** A view-builder or local terminal-send failure is terminal for this document. */
  failure(reason: unknown) {
    if (this.#state === 'disposed' || this.#state === 'failed') {
      return
    }

    this.#state = 'failed'
    this.#dirty = false
    this.#clearWatch()
    // gone(), unlike close(), cannot flush rejected or untrusted queued ops.
    this.#surface.gone()
    this.#host.report(typeof reason === 'string' ? reason : 'Tern could not build a frame: ' +
      (reason instanceof Error ? reason.message : String(reason)))
  }

  dispose() {
    this.#state = 'disposed'
    this.#dirty = false
    this.#clearWatch()
  }

  #open(): Surface {
    if (this.#state === 'disposed') {
      throw new Error('Cannot reopen a disposed Tern surface')
    }

    const id = this.#recoveries ? 'hermes.recovery-' + this.#recoveries : 'hermes'
    const surface = this.#tern.open({ id, mode: 'inline', role: 'omp.session', title: this.#title })
    if (typeof surface.send !== 'function' || typeof surface.acknowledge !== 'function' || typeof surface.seq !== 'number') {
      return surface // Legacy in-process App fixture, never used as protocol evidence.
    }

    const send = surface.send.bind(surface)
    const ack = surface.acknowledge.bind(surface)

    surface.send = ops => {
      if (surface !== this.#surface || this.#state !== 'visible' || surface.closed || surface.blocked) {
        if (surface === this.#surface && this.#state === 'visible' && !surface.closed) {
          this.#dirty = true
        }
        return
      }
      send(ops)
      this.#watch()
    }

    surface.acknowledge = s => {
      if (surface !== this.#surface || this.#state === 'disposed' || this.#state === 'failed' ||
        surface.closed || !Number.isInteger(s) || s < 1 || s > surface.seq) {
        return
      }
      const blocked = surface.blocked
      ack(s)
      if (blocked && !surface.blocked) {
        this.#stalled = false
        this.#clearWatch()
        if (this.#dirty && this.#state === 'visible') {
          this.#dirty = false
          this.#host.changed()
        }
      }
      this.#watch()
    }

    return surface
  }

  #recover() {
    if (!this.#missing || !this.#visible || this.#state === 'failed' || this.#state === 'disposed') {
      return
    }
    if (this.#recoveries === MAX_SURFACE_RECOVERIES) {
      this.failure('Tern surface recovery limit reached; reconnect the frontend.')
      return
    }

    this.#recoveries++
    this.#missing = false
    this.#state = 'visible'
    this.#dirty = false
    this.#stalled = false
    this.#surface = this.#open()
    this.#host.replaced(this.#surface)
    this.#host.changed()
  }

  #watch() {
    if (this.#watchdog || this.#stalled || this.#state !== 'visible' ||
      !this.sdk || !this.#surface.blocked) {
      return
    }

    this.#watchdog = setTimeout(() => {
      this.#watchdog = undefined
      if (this.#state === 'visible' && this.#surface.blocked) {
        this.#stalled = true
        this.#host.report('Tern is not acknowledging visible frames; waiting for credit (no frames bypassed).')
      }
    }, ACK_STALL_MS)
    this.#watchdog.unref()
  }

  #clearWatch() {
    clearTimeout(this.#watchdog)
    this.#watchdog = undefined
  }
}
