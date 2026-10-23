// Explicit busy-input intent over the plugin's existing gateway-owned prompt queue.
// Adapted from Hermes ui-tsp/src/busy-input.ts; never creates a parallel queue.

import type { Composer } from '../draft/composer.js'
import type { Activity } from './activity.js'
import type { PromptRouter } from './router.js'
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
  readonly composer: Pick<Composer, 'text' | 'cursor' | 'revision' | 'pasted' | 'set' | 'take'>
  readonly activity: Pick<Activity, 'busy'>
  readonly router: Pick<PromptRouter, 'expanded'>
  readonly transcript: Pick<Transcript, 'live' | 'generation' | 'steerAccepted' | 'notice'>
  /** The modal and attachment admission gate, checked again after async expansion. */
  admit(): boolean
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
    const { activity, composer, gw, router, session, transcript } = this.#host
    const ticket = session.ticket()
    const text = raw.trim()

    if (this.#pending || !ticket.sid || !text) {
      return
    }

    // Native Send can precede its edit callback. Keep the last caret and applicable paste markers.
    if (raw !== composer.text) {
      composer.set(raw, { cursor: Math.min(composer.cursor, raw.length), pasted: composer.pasted.filter(p => raw.includes(p)) })
    }

    const revision = composer.revision
    const cursor = composer.cursor
    const pasted = [...composer.pasted]
    const owningTurn = transcript.live
    const generation = transcript.generation
    const busySince = activity.busy?.since
    this.#pending = true

    try {
      // The regular router owns {!cmd} expansion (and its pasted exclusions). A failed
      // command reports its error but leaves this still-owned draft exactly where it was.
      const ready = await router.expanded(
        ticket.sid,
        { images: [], kind: 'typed', pasted, text },
        { restoreOnFailure: false, current: () => !ticket.signal.aborted && ticket.isCurrent() }
      )
      const running = activity.busy

      // A modal, edited draft, switch or different turn may have arrived during shell.exec.
      if (
        !ready ||
        ticket.signal.aborted ||
        !ticket.isCurrent() ||
        !this.#host.admit() ||
        !running ||
        (running.since !== busySince && transcript.generation === generation) ||
        composer.revision !== revision ||
        composer.cursor !== cursor ||
        composer.text !== raw
      ) {
        return
      }

      if (!ready.text.trim()) {
        transcript.notice('Steering needs text after {!…} expansion. Your draft is kept.', 'warning')
        return
      }

      const result = await steerTurn(gw, ticket.sid, ready.text.trim())

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

      // Same-ID reattach can reset/load the transcript without invalidating the session
      // ticket. Never write to the captured orphan; reconcile a current running owner.
      const current = activity.busy
      const runningAt = current && (current.since === busySince || transcript.generation !== generation) ? current.startedAt : undefined
      transcript.steerAccepted(text, { generation, owner: owningTurn, runningAt })

      // Acceptance is recorded before clearing, and a late acknowledgement never takes an edit.
      if (composer.revision === revision && composer.cursor === cursor && composer.text === raw) {
        composer.take()
      }
    } finally {
      this.#pending = false
      this.#host.changed()
    }
  }
}
