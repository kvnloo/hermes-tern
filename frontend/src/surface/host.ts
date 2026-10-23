// One inline Tern surface per document epoch. Retention remains the sole transcript writer.
// Presentation restoration never recreates a Hermes session or sends a gateway request.
import type { Op, Palette, Renderable, RevealAt, ScrollTo, Session, Surface, TspEvent, WireNode } from '@stencil-hq/tern'

import { SurfaceLifecycle, SurfaceView, type SurfaceLifecycleHost, type SurfaceState } from './lifecycle.js'

/** The composer's node id (dock → composer): the completion list sits above it. */
export const COMPOSER_ID = 'dock.composer'
/** The editor node (dock → composer → line → input), where the caret rests. */
export const INPUT_ID = COMPOSER_ID + '.line.input'

export interface SurfaceHostEvents {
  changed(): void
  recovered(surface: Surface): void
  report(message: string): void
}

export class SurfaceHost {
  readonly #life: SurfaceLifecycle
  #writer = new SurfaceView()
  readonly #missing = new Set<string>()
  #focus: string | null | undefined = INPUT_ID
  #palette: Palette | undefined

  constructor(tern: Session, title: string, styles: string, events?: SurfaceHostEvents) {
    const host: SurfaceLifecycleHost = {
      changed: () => events?.changed(),
      report: message => events?.report(message),
      replaced: surface => {
        this.#writer = new SurfaceView()
        this.#missing.clear()
        this.#focus = undefined
        this.#track(surface)
        surface.stylesheet('hermes-tern', styles)
        if (this.#palette) {
          surface.palette(this.#palette)
        }
        events?.recovered(surface)
      }
    }
    this.#life = new SurfaceLifecycle(tern, title, host)
    this.#track(this.raw)
    this.raw.stylesheet('hermes-tern', styles)
  }

  get raw(): Surface {
    return this.#life.raw
  }

  get state(): SurfaceState {
    return this.#life.state
  }

  get closed(): boolean {
    return this.#life.state !== 'visible' || this.raw.closed
  }

  /** Only current-epoch SDK handlers may act, including when queued before detach. */
  guardHandlers(retention: boolean) {
    if (!this.#life.sdk) {
      return
    }
    const surface = this.raw
    const route = retention
      ? surface.dispatch.bind(surface)
      : (event: TspEvent) => this.#writer.dispatch(event)
    surface.dispatch = event => {
      if (!this.#accept(surface, event)) {
        return undefined
      }
      const work = route(event)
      return work && (() => {
        if (this.#accept(surface, event)) {
          return work()
        }
      })
    }
  }

  /** Runs before the existing Retention.gone and unhandled SDK action handling. */
  event(event: TspEvent): boolean {
    const accepted = this.#life.event(event)
    if (accepted && event.ev === 'gone') {
      for (const id of event.ids) {
        this.#missing.add(id)
      }
      this.#writer.forget(event.ids)
      if (this.#focus && this.#absent(this.#focus)) {
        this.#focus = undefined
      }
    }

    return accepted
  }

  /** The non-retention writer uses the same real Surface credits, not a second scheduler. */
  render(view: Renderable) {
    if (this.closed) {
      return
    }
    if (!this.#life.sdk) {
      this.raw.render(view) // Existing App fixture only.
    } else if (!this.#writer.paint(this.raw, view)) {
      this.#life.defer()
    }
  }

  rendered() {
    this.#life.rendered()
  }

  failure(error: unknown) {
    this.#life.failure(error)
  }

  dispose() {
    this.#life.dispose()
  }

  palette(palette: Palette) {
    this.#palette = palette
    if (!this.closed) {
      this.raw.palette(palette)
    }
  }

  focus(id: string | null) {
    if (this.closed || this.raw.blocked || (id !== null && this.#absent(id))) {
      this.#focus = undefined // Reapply after the next real ACK/rebuilt node.
      this.#life.defer()
      return
    }
    this.#focus = id
    this.raw.focus(id)
  }

  follow(id: string | null) {
    if (id !== this.#focus) {
      this.focus(id)
    }
  }

  reveal(id: string, at?: RevealAt) {
    if (!this.closed && !this.raw.blocked && !this.#absent(id)) {
      this.raw.reveal(id, at)
    }
  }

  scroll(id: string, to: ScrollTo) {
    if (!this.closed && !this.raw.blocked && !this.#absent(id)) {
      this.raw.scroll(id, to)
    }
  }

  #accept(surface: Surface, event: TspEvent): boolean {
    return surface === this.raw && !this.closed &&
      (!('sf' in event) || !event.sf || event.sf === surface.id) &&
      (!('id' in event) || !event.id || !this.#absent(event.id))
  }

  #absent(id: string): boolean {
    for (const missing of this.#missing) {
      if (id === missing || id.startsWith(missing + '.')) {
        return true
      }
    }
    return false
  }

  /** A successfully sent add may reestablish a previously evicted focus/handler id. */
  #track(surface: Surface) {
    if (!this.#life.sdk) {
      return
    }
    const send = surface.send.bind(surface)
    surface.send = (ops: readonly Op[]) => {
      if (this.closed || surface !== this.raw || surface.blocked) {
        this.#life.defer()
        return
      }
      // Retention owns rows, not the main region root. A root-level 'gone' must
      // restore the public region parent before any retained row can be added.
      const outbound: readonly Op[] = this.#missing.has('main') &&
        !ops.some(op => op[0] === 'add' && op[1] === 'main')
        ? [['add', 'main', surface.id, null, { id: 'main', k: 'col' }], ...ops]
        : ops
      send(outbound)
      const restored = new Set<string>()
      const visit = (node: WireNode) => {
        restored.add(node.id)
        node.c?.forEach(visit)
      }
      for (const op of outbound) {
        if (op[0] === 'add') {
          visit(op[4])
        }
      }
      for (const id of restored) {
        this.#missing.delete(id)
      }
    }
  }
}
