// The gateway's keyed `notification.show` notices (credits, a slow start) on the status strip.
// Mirrors Hermes' ui-tui/src/app/createGatewayEventHandler.ts (notification.show/clear) and
// turnController's keyed notice. Notices is the list; NoticeStrip owns it with the timer that
// re-renders when a `ttl` one expires, so the strip drops it on time.

import type { NoticeEntry } from '../model.js'

import { Dispatches, type AttentionPayload } from './attention.js'

/** A `notification.show` payload. */
export type NoticePayload = AttentionPayload

/** A notice on the status strip. */
export interface Notice {
  key: string
  text: string
  tone: NoticeEntry['tone']
  /** When a `ttl` notice goes (ms since the epoch). */
  expires?: number
}

/** One projection for notices, backed by the bounded Hermes attention reducer. */
export class Notices {
  readonly #items = new Dispatches()

  show(p: NoticePayload, now = Date.now(), hidden = false): Notice | undefined {
    this.#items.show(p, now, hidden)

    return this.current(now)
  }

  /** Clear a visible or deferred key; unkeyed clears never erase other notices. */
  clear(key: string | undefined): boolean {
    return key !== undefined && this.#items.clear(key)
  }

  current(now = Date.now()): Notice | undefined {
    const item = this.#items.active(now).at(-1)

    if (!item) {
      return undefined
    }

    return {
      key: item.key,
      text: item.text,
      tone: item.level === 'warn' ? 'warning' : item.level,
      ...(item.expiresAt !== null ? { expires: item.expiresAt } : {})
    }
  }

  nextExpiry(now = Number.NEGATIVE_INFINITY): number | undefined {
    return this.#items.nextExpiry(now) ?? undefined
  }

  resume(now = Date.now()) {
    this.#items.resume(now)
  }

  reset() {
    this.#items.reset()
  }
}

/** A `/login` step (its link, code or result): read and clicked in the transcript, not on the strip. */
export function isLoginNotice(p: NoticePayload): boolean {
  return Boolean(p.key?.startsWith('login:'))
}

/** What the strip reaches of the app. */
export interface NoticeStripHost {
  /** Asks for a render. */
  changed(): void
}

/** The status strip's notices, and the timer that re-renders when the next `ttl` one expires. */
export class NoticeStrip {
  readonly #host: NoticeStripHost
  readonly #notices = new Notices()
  #timer: NodeJS.Timeout | undefined
  #visible = true

  constructor(host: NoticeStripHost) {
    this.#host = host
  }

  /** Adds or replaces the notice, and re-arms the expiry render. */
  show(p: NoticePayload) {
    this.#notices.show(p, Date.now(), !this.#visible)
    this.#arm()
  }

  /** Drops the notice with `key`. */
  clear(key: string | undefined) {
    this.#notices.clear(key)
    this.#arm()
  }

  /** The notice the strip shows at `now`. */
  current(now = Date.now()): Notice | undefined {
    return this.#notices.current(now)
  }

  /** Forgets every notice (another session is shown). */
  reset() {
    this.#notices.reset()
    this.#arm()
  }

  /** Visibility is host-owned; held notifications start their TTL when the pane returns. */
  visible(shown: boolean) {
    if (shown === this.#visible) return
    this.#visible = shown
    if (shown) this.#notices.resume()
    this.#arm()
    if (shown) this.#host.changed()
  }

  /** Stops the expiry render. */
  dispose() {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  /** Re-renders when the next `ttl` notice expires, so the strip drops it on time. */
  #arm() {
    clearTimeout(this.#timer)
    const at = this.#visible ? this.#notices.nextExpiry(Date.now()) : undefined

    if (at !== undefined) {
      this.#timer = setTimeout(() => {
        this.#notices.current()
        this.#arm()
        this.#host.changed()
      }, Math.max(0, at - Date.now()) + 10)
    }
  }
}
