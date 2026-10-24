// Terminal-owned attention, separate from surface rendering and the transcript. Ported from
// kvnloo/hermes-agent ui-tsp/src/host-lifecycle.ts; OSC progress follows Can Bölük /
// Stencil's OMP terminal conventions (MIT). Only changes of confirmed phase emit bytes.

export interface HostState {
  sid: string | null
  working: boolean
  /** A queued handoff may be waiting for admission, not a new confirmed model turn. */
  submitting?: boolean
  waiting: boolean
}

type Phase = 'idle' | 'working' | 'waiting'

const PROGRESS: Record<Phase, string> = {
  idle: '\x1b]9;4;0;\x07',
  working: '\x1b]9;4;3\x07',
  waiting: '\x1b]9;4;4\x07'
}

/** No timer, percentage, or duplicate completion notification. */
export class HostLifecycle {
  #sid: string | null = null
  #phase: Phase = 'idle'

  constructor(private readonly write: (text: string) => void) {}

  /** Report only the last confirmed turn in a queued batch. */
  finish(status: string | null | undefined): void {
    if (this.#phase === 'idle') {
      return
    }

    this.#phase = 'idle'
    this.write(PROGRESS.idle)
    const message = status === 'error' ? 'Turn failed' : status === 'interrupted' ? 'Turn interrupted' : 'Turn finished'
    this.write('\x1b]777;notify;Hermes;' + message + '\x07')
  }

  project(state: HostState): void {
    if (this.#sid !== state.sid && this.#phase !== 'idle') {
      this.write(PROGRESS.idle)
      this.#phase = 'idle'
    }

    this.#sid = state.sid
    const working = state.working || (state.submitting && this.#phase !== 'idle')
    const phase: Phase = !state.sid ? 'idle' : state.waiting ? 'waiting' : working ? 'working' : 'idle'

    if (phase !== this.#phase) {
      this.#phase = phase
      this.write(PROGRESS[phase])

      if (phase === 'waiting') {
        this.write('\x1b]777;notify;Hermes;Input required\x07')
      }
    }
  }
}
