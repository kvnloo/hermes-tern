// The contract every floating panel (approval, clarify, pickers, completion
// list) implements. The app keeps a stack: the top overlay sees keys first,
// every overlay draws into the `layer` region, and `close()` removes it (and tells it, through
// `onClose`, so its timers and watches end with it). OverlayStack is that stack.

import type { JSX, Key, TspEvent } from '@stencil-hq/tern'

import { NATIVE_OVERLAY_PREFIX, withinOverlayRoot } from './identity.js'

/** One floating panel in the `layer` region. */
export interface Overlay {
  /** Logical request/replacement/cancellation key; never a native node id. */
  readonly key: string
  /** Covers the transcript and takes every key (a question that must be answered). */
  readonly modal?: boolean
  /**
   * The `input` that takes Tern's caret while this overlay is on top, given
   * its node id; null for none. Unset: none for a modal overlay, else the composer.
   */
  focus?(id: string): string | null
  /** The overlay's node, keyed by its assigned native root's final component. */
  node(id: string): JSX.Element
  /** A key while this overlay is on top: true when it consumed the key. */
  onKey(key: Key): boolean
  /**
   * Ctrl+C while this overlay is on top: give the safe answer (deny, skip, cancel) and close.
   * Unset: the app closes the overlay.
   */
  cancel?(): void
  /**
   * The overlay left the stack: closed, or replaced by one with the same key. Ends what it runs
   * while open (a tick, a watch). Called once, after it is off the stack.
   */
  onClose?(): void
}

/** What overlays reach of the app. */
export interface OverlayHost {
  /** Pushes `overlay` on top, replacing an open overlay with the same key. */
  open(overlay: Overlay): void
  /** Removes this exact instance and calls its onClose; a no-op once it was closed or replaced. */
  close(overlay: Overlay): void
  /** Re-render after a state change made outside a key or event handler. */
  changed(): void
}

/** What the stack tells the app: an overlay opened or left, and that the view changed. */
export interface OverlayStackHost {
  /** `overlay` is on top now (after any same-key one left). */
  opened(overlay: Overlay): void
  /** `overlay` left the stack, before its own onClose runs. */
  closed(overlay: Overlay): void
  changed(): void
}

/** A native event's immutable receipt (captured before SDK dispatch). */
export interface NativeOverlayReceipt {
  readonly allowed: boolean
  readonly root: string | null
}

/** The open overlays, bottom first: a newer one with a key already open replaces it. */
export class OverlayStack implements Pick<OverlayHost, 'close' | 'open'> {
  /** The overlays, bottom first; changed only through open() and close(). */
  readonly items: Overlay[] = []
  readonly #host: OverlayStackHost
  readonly #roots = new Map<Overlay, string>()
  #serial = 0

  constructor(host: OverlayStackHost) {
    this.#host = host
  }

  open(overlay: Overlay) {
    const same = this.items.find(o => o.key === overlay.key)

    if (same) {
      this.close(same)
    }

    // Allocate on every open, even when the very same object is opened again.
    // Never recycle an id: the terminal may still send an event from an old paint.
    this.#roots.set(overlay, `layer.overlay-${++this.#serial}`)
    this.items.push(overlay)
    this.#host.opened(overlay)
    this.#host.changed()
  }

  /** Only a currently open instance has a native identity. */
  rootOf(overlay: Overlay): string {
    const root = this.#roots.get(overlay)

    if (root === undefined) {
      throw new Error('Overlay has no open native root')
    }

    return root
  }

  /**
   * Capture the actual action id before asking the SDK for a handler: a last
   * painted event may arrive after the SDK has rendered a same-key successor.
   * The root is the *top* instance's root, not an overlay object's key.
   * Main, dock, ACK, gone, visibility and foreign events keep their normal path.
   */
  nativeReceipt(event: TspEvent): NativeOverlayReceipt {
    const id = 'id' in event ? event.id : undefined

    if (typeof id !== 'string' || !id.startsWith(NATIVE_OVERLAY_PREFIX)) {
      return { allowed: true, root: null }
    }

    const top = this.items.at(-1)
    const root = top === undefined ? undefined : this.#roots.get(top)

    return { allowed: root !== undefined && withinOverlayRoot(id, root), root: root ?? null }
  }

  /** A callback already chosen by the SDK must still belong to the live top open. */
  ownsNativeReceipt(receipt: NativeOverlayReceipt): boolean {
    if (!receipt.allowed) {
      return false
    }

    if (receipt.root === null) {
      return true
    }

    const top = this.items.at(-1)

    return top !== undefined && this.#roots.get(top) === receipt.root
  }

  close(overlay: Overlay) {
    // By identity: a stale callback of a replaced overlay must not close its same-key successor.
    const at = this.items.indexOf(overlay)

    if (at >= 0) {
      this.items.splice(at, 1)
      this.#roots.delete(overlay)
      this.#host.closed(overlay)
      overlay.onClose?.()
      this.#host.changed()
    }
  }
}
