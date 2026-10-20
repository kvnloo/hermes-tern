// The ask_control calls' sheets and answers. A finished call opens its sheet; the answer goes to the
// agent as the user's next message (vendor/ripple's intentText), waiting behind a running turn as a
// connect card's Continue does. Two panes may show one chat: the first to answer claims the control
// in the plugin's data folder (`controls/<session>.<call>.<control>.json`, the intent), the other closes its
// sheet and shows that answer, and a resumed chat reads its old answers back from the same files.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from '../connections/cards.js'
import { errorCode } from '../core/errors.js'
import { attempt } from '../core/result.js'
import type { ToolCall } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { CONTROL_TOOL, controlDetail } from '../tools/control.js'
import type { Transcript } from '../transcript/store.js'
import { type FastControl, type Intent, intentText, type Outcome, parseIntent } from '../vendor/ripple/index.js'
import { record } from '../wire/json.js'

import { type ControlSheet, controlSheet } from './sheet.js'

/** What the controls reach of the app. */
export interface ControlsHost {
  readonly transcript: Pick<Transcript, 'calls' | 'mutateCall'>
  open(overlay: Overlay): void
  close(overlay: Overlay): void
  changed(): void
  /** Sends `text` to the agent as the user's message: it waits behind a running turn. */
  tell(text: string): void
  /** The chat's stored session id: claims are kept per chat, as call ids repeat across chats. */
  sid(): string | null
}

const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, '_')

/** The control a finished `ask_control` call showed, if the tool showed one. */
export function controlOf(call: ToolCall): FastControl | undefined {
  if (call.name !== CONTROL_TOOL || call.outcome.kind === 'running') {
    return undefined
  }

  return controlDetail({ args: call.args, result: record(call.result) }).control
}

export class Controls {
  readonly #host: ControlsHost
  /** Where the claims are; unset: the plugin's data folder, read at each claim (tests point it at their own). */
  readonly #dir: string | undefined
  /** The open sheets, by call id. */
  readonly #open = new Map<string, ControlSheet>()

  constructor(host: ControlsHost, { dir }: { dir?: string } = {}) {
    this.#host = host
    this.#dir = dir
  }

  /** A finished ask_control call: its sheet opens, unless the control is answered already. */
  show(call: ToolCall | undefined) {
    const control = call && controlOf(call)

    if (!call || !control || this.#settled(call)) {
      return
    }

    this.#openSheet(call, control)
  }

  /** A chat adopted: the last chat's sheets close, and its controls' answers (another pane's, or from before a resume) go onto their cards. */
  adopt() {
    this.dispose()

    for (const call of this.#host.transcript.calls(CONTROL_TOOL)) {
      this.#settled(call)
    }
  }

  /** The card's Answer: call `ref`'s sheet again, unless it was answered meanwhile. */
  reopen(ref: string) {
    const call = this.#host.transcript.calls(CONTROL_TOOL).find(c => c.id === ref)
    const control = call && controlOf(call)

    if (call && control && !this.#settled(call)) {
      this.#openSheet(call, control)
    }
  }

  /**
   * A transcript (dictation, or a typed reply) for the sheet on top: answers it when it names exactly
   * one row (or a number for a slider, yes/no for a confirm). False when no sheet is open.
   */
  hear(text: string): boolean {
    const top = [...this.#open.values()].at(-1)

    top?.feed({ kind: 'say', text })

    return top !== undefined
  }

  /** Closes every open sheet: the chat changed, or the pane quits. */
  dispose() {
    for (const sheet of [...this.#open.values()]) {
      this.#host.close(sheet.overlay)
    }

    this.#open.clear()
  }

  #openSheet(call: ToolCall, control: FastControl) {
    const sheet = controlSheet(call.id, control, {
      changed: () => this.#host.changed(),
      settle: outcome => this.#settle(call, control, sheet, outcome)
    })

    this.#open.set(call.id, sheet)
    this.#host.open(sheet.overlay)
  }

  #settle(call: ToolCall, control: FastControl, sheet: ControlSheet, outcome: Outcome) {
    this.#open.delete(call.id)
    this.#host.close(sheet.overlay)

    if (outcome.kind === 'answer') {
      this.#answer(call, control, outcome.intent)
    }

    this.#host.changed()
  }

  /** Claims the control for this pane and tells the agent; a control another pane answered first keeps that answer. */
  #answer(call: ToolCall, control: FastControl, intent: Intent) {
    const path = this.#claimPath(call)
    const claim = path
      ? attempt(() => {
          mkdirSync(join(path, '..'), { recursive: true })
          writeFileSync(path, JSON.stringify(intent), { flag: 'wx' })
        })
      : undefined

    if (claim?.kind === 'failed' && errorCode(claim.error) === 'EEXIST') {
      this.#settled(call)

      return
    }

    // Claimed, or the claim could not be written (no folder, no permission): the answer goes all the same.
    this.#host.transcript.mutateCall(call, c => {
      c.controlAnswer = intent
    })
    this.#host.tell(intentText(control, intent))
  }

  /** Whether `call` has an answer: one this pane holds, or one on disk, which goes onto the call. */
  #settled(call: ToolCall): boolean {
    if (call.controlAnswer) {
      return true
    }

    const path = this.#claimPath(call)
    const read = path ? attempt(() => readFileSync(path, 'utf8')) : undefined
    const intent = read?.kind === 'ok' ? parseIntent(record(read.value)) : null

    if (!intent) {
      return false
    }

    this.#host.transcript.mutateCall(call, c => {
      c.controlAnswer = intent
    })

    // Answered in another pane while this one's sheet was open.
    const open = this.#open.get(call.id)

    if (open) {
      this.#open.delete(call.id)
      this.#host.close(open.overlay)
    }

    return true
  }

  /** The claim of `call`'s control: by chat, call and control, as a model may reuse a call id. */
  #claimPath(call: ToolCall): string | undefined {
    const sid = this.#host.sid()
    const control = controlOf(call)

    return sid && control ? join(this.#dir ?? dataDir(), 'controls', `${safe(sid)}.${safe(call.id)}.${safe(control.id)}.json`) : undefined
  }
}
