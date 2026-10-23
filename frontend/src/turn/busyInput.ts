// Explicit busy-input intent over the plugin's existing gateway-owned prompt queue.
// Adapted from Hermes ui-tsp/src/busy-input.ts; never creates a parallel queue.

import type { Composer } from '../draft/composer.js'
import type { SessionState } from '../session/state.js'
import type { Transcript } from '../transcript/store.js'
import { steerTurn } from './control.js'
import type { BusyMode } from './serverQueue.js'
import type { Requester } from '../wire/rpc.js'

/** Enter uses an explicit queue or steer action. Interrupt stays on the dedicated Stop action. */
export function busyIntent(mode: BusyMode, alternate = false): 'queue' | 'steer' {
  return (mode === 'steer') !== alternate ? 'steer' : 'queue'
}

export function busyHint(mode: BusyMode): string {
  return busyIntent(mode) === 'steer' ? 'Enter steer · alt+enter queue' : 'Enter queue · alt+enter steer'
}

export interface BusyDraftHost {
  readonly gw: Requester
  readonly session: Pick<SessionState, 'ticket'>
  readonly composer: Pick<Composer, 'text' | 'cursor' | 'revision' | 'set' | 'take'>
  readonly transcript: Pick<Transcript, 'live' | 'steer' | 'notice'>
  changed(): void
}

/** A single in-flight correction; a rejected or stale steer never consumes the draft. */
export class BusyDraft {
  readonly #host: BusyDraftHost
  #pending = false

  constructor(host: BusyDraftHost) {
    this.#host = host
  }

  async steer(raw: string): Promise<void> {
    const { composer, gw, session, transcript } = this.#host
    const ticket = session.ticket()
    const text = raw.trim()

    if (this.#pending || !ticket.sid || !text) {
      return
    }

    // Native Tern Send may carry the submitted text before its matching edit callback.
    if (raw !== composer.text) composer.set(raw)

    const revision = composer.revision
    const cursor = composer.cursor
    const owningTurn = transcript.live
    this.#pending = true

    try {
      const result = await steerTurn(gw, ticket.sid, text)

      // A reattach, switch or interruption may complete this request after the pane moved.
      if (ticket.signal.aborted || !ticket.isCurrent()) {
        return
      }

      if (!result.ok) {
        transcript.notice(
          result.error ? `Steer failed: ${result.error}. Your draft is kept.` : 'Steering was rejected. Your draft is kept.',
          'warning'
        )
        return
      }

      if (owningTurn) {
        // Stamp the turn that requested it, never a later turn which happened to start meanwhile.
        transcript.steer(text, Date.now(), owningTurn)
      } else {
        transcript.notice('Steering accepted for the running turn.')
      }

      // The user may have edited the draft or moved the caret while the RPC was pending.
      if (composer.revision === revision && composer.cursor === cursor && composer.text === raw) {
        composer.take()
      }
    } finally {
      this.#pending = false
      this.#host.changed()
    }
  }
}
