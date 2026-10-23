// Hermes' keyed notification projection, adapted from ui-tsp/src/attention.ts.
// This is presentation-only: notification.show/clear remain owned by the gateway.

export interface AttentionPayload {
  text?: string | undefined
  level?: string | undefined
  kind?: string | undefined
  ttl_ms?: number | null | undefined
  key?: string | null | undefined
  id?: string | null | undefined
}

export interface Dispatch {
  readonly key: string
  readonly serial: number
  readonly text: string
  readonly level: 'info' | 'warn' | 'error' | 'success'
  readonly expiresAt: number | null
}

const DEFAULT_TTL_MS = 6_000
const MAX_TTL_MS = 60_000
const MAX_DISPATCHES = 8

/** A bounded dock projection: keyed replacements, sticky/TTL notices and hidden-pane catch-up. */
export class Dispatches {
  readonly #items = new Map<string, Dispatch>()
  readonly #held = new Map<string, AttentionPayload>()
  #serial = 0

  show(payload: AttentionPayload, now = Date.now(), hidden = false): void {
    const text = payload.text?.trim()

    if (!text) {
      return
    }

    const key = payload.key?.trim() || payload.id?.trim() || `anonymous:${++this.#serial}`

    if (hidden) {
      // A hidden pane must not exhaust a short notice's TTL before its owner returns.
      this.#items.delete(key)
      this.#held.delete(key)
      this.#held.set(key, { ...payload, key })

      while (this.#held.size > MAX_DISPATCHES) {
        const oldest = this.#held.keys().next().value
        if (oldest === undefined) break
        this.#held.delete(oldest)
      }

      return
    }

    this.#held.delete(key)
    const existing = this.#items.get(key)
    const ttl = typeof payload.ttl_ms === 'number' && Number.isFinite(payload.ttl_ms) && payload.ttl_ms > 0
      ? Math.min(payload.ttl_ms, MAX_TTL_MS)
      : DEFAULT_TTL_MS
    const level = payload.level === 'warning' ? 'warn' : payload.level === 'warn' || payload.level === 'error' || payload.level === 'success' ? payload.level : 'info'
    const note: Dispatch = {
      key,
      serial: existing?.serial ?? ++this.#serial,
      text,
      level,
      expiresAt: payload.kind === 'sticky' ? null : now + ttl
    }

    this.#items.delete(key)
    this.#items.set(key, note)
    this.#prune(now)

    while (this.#items.size > MAX_DISPATCHES) {
      const oldest = this.#items.keys().next().value
      if (oldest === undefined) break
      this.#items.delete(oldest)
    }
  }

  /** A notification.clear removes both a shown key and one waiting for pane visibility. */
  clear(key: string): boolean {
    const shown = this.#items.delete(key)
    const held = this.#held.delete(key)

    return shown || held
  }

  /** Display deferred notices with a fresh TTL, and keep the gateway's keyed order. */
  resume(now = Date.now()): void {
    const held = [...this.#held.values()]
    this.#held.clear()

    for (const note of held) {
      this.show(note, now)
    }
  }

  reset(): void {
    this.#items.clear()
    this.#held.clear()
  }

  active(now = Date.now()): Dispatch[] {
    this.#prune(now)

    return [...this.#items.values()]
  }

  nextExpiry(now = Date.now()): number | null {
    this.#prune(now)
    let next: number | null = null

    for (const note of this.#items.values()) {
      if (note.expiresAt !== null && (next === null || note.expiresAt < next)) {
        next = note.expiresAt
      }
    }

    return next
  }

  #prune(now: number): void {
    for (const [key, note] of this.#items) {
      if (note.expiresAt !== null && note.expiresAt <= now) {
        this.#items.delete(key)
      }
    }
  }
}
