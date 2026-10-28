// The gateway's keyed `notification.show` notices (credits, a slow start) on the status strip.
// Mirrors Hermes' ui-tui/src/app/createGatewayEventHandler.ts (notification.show/clear) and
// turnController's keyed notice. Notices projects bounded gateway attention; NoticeStrip owns
// the single expiry timer and freezes short-lived arrivals while the Tern pane is hidden.

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

/** A read-only snapshot; indent every line so gateway text cannot create Markdown links or controls. */
export function noticeReport(items: readonly Notice[]): string {
  if (!items.length) {
    return 'No retained notices at the time this report was opened.'
  }

  const lines = items.flatMap(item => [`[${item.tone}] ${item.text}`, ''])
  return ['Snapshot at open time. Up to eight notices are retained. On overflow, only the newest sticky error and the newest notice are protected; others may have been omitted.', '',
    ...lines.flatMap(line => line.split(/\r\n|\r|\n/).map(part => `    ${part}`))].join('\n')
}

/** One projection for notices, backed by the bounded Hermes attention reducer. */
export class Notices {
  readonly #items = new Dispatches()

  show(p: NoticePayload, now = Date.now(), hidden = false): Notice | undefined {
    if (!p.text?.trim()) {
      return undefined
    }
    this.#items.show(p, now, hidden)

    return this.current(now)
  }

  /** Clear a visible or deferred key; unkeyed clears never erase other notices. */
  clear(key: string | undefined): boolean {
    return key !== undefined && this.#items.clear(key)
  }

  current(now = Date.now()): Notice | undefined {
    return this.active(now).at(-1)
  }

  /** The retained gateway notices, oldest first; a snapshot, not durable history. */
  active(now = Date.now()): Notice[] {
    return this.#items.active(now).map(item => ({
      key: item.key,
      text: item.text,
      tone: item.level === 'warn' ? 'warning' : item.level,
      ...(item.expiresAt !== null ? { expires: item.expiresAt } : {})
    }))
  }

  /** The newest retained error, if another notice is currently shown. */
  otherError(now = Date.now()): Notice | undefined {
    const items = this.active(now)
    const latest = items.at(-1)
    return items.toReversed().find(item => item.tone === 'error' && item.key !== latest?.key)
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

  active(now = Date.now()): Notice[] {
    return this.#notices.active(now)
  }

  otherError(now = Date.now()): Notice | undefined {
    return this.#notices.otherError(now)
  }

  /** Forgets every notice (another session is shown). */
  reset() {
    this.#notices.reset()
    this.#arm()
  }

  /** Visibility is host-owned; held notifications start their TTL when the pane returns. */
  visible(shown: boolean) {
    if (shown === this.#visible) {
      return
    }

    this.#visible = shown
    if (shown) {
      this.#notices.resume()
    }

    this.#arm()
    if (shown) {
      this.#host.changed()
    }
  }

  /** Stops the expiry render. */
  dispose() {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  /** Re-renders when the next `ttl` notice expires, so the strip drops it on time. */
  #arm() {
    clearTimeout(this.#timer)
    this.#timer = undefined
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
