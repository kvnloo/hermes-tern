// Gateway-owned side threads, rendered independently of the main transcript.
// Only the selected thread, unsent drafts and UI lifetime live in this pane.
import type { ChatPorts } from './app/ports.js'
import { Composer } from './draft/composer.js'
import type { EventOf } from './gateway/dispatch.js'
import { openBtwOverlay } from './overlays/btw.js'
import type { Overlay } from './overlays/overlay.js'
import { btwEvent, cancelBtw, listBtw, submitBtw, type BtwThread } from './wire/side.js'

type Host = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'scroll' | 'session'>

/** A rendered completion action captures its exact session, task, thread and presentation revision. */
export interface BtwNotice {
  readonly id: string
  readonly taskId: string
  readonly threadId: string
  readonly turnId: string
  readonly sid: string
  readonly owner: object
  readonly nonce: number
  readonly ticket: number
  readonly failed: boolean
}

type NoticeRecord = Omit<BtwNotice, 'ticket'>

export class BtwThreads {
  readonly host: Host
  threads: BtwThread[] = []
  selected: string | null = null
  state: 'idle' | 'loading' | 'submitting' = 'idle'
  error = ''
  #sid: string | null = null
  #epoch = 0
  #sheet: Overlay | undefined
  #drafts = new Map<string, Composer>()
  /** Typed completions wait for an exact gateway thread/turn ID, never a guessed question match. */
  #pendingCompletions = new Map<string, boolean>()
  #seenCompletions = new Set<string>()
  /** Key by the owning thread: separate terminal threads can share a legacy task ID. */
  #notices = new Map<string, NoticeRecord>()
  #noticedTurns = new Map<string, string>()
  #dismissedTurns = new Map<string, string>()
  #owner: object | undefined
  #noticeTicket = 0
  #noticeNonce = 0

  constructor(host: Host) {
    this.host = host
  }

  adopt(sid: string | null) {
    const owner = this.host.session.ref

    if (this.#sid === sid && this.#owner === owner) {
      return
    }

    const switched = this.#sid !== sid
    this.#owner = owner
    this.#noticeTicket++
    this.#pendingCompletions.clear()
    this.#seenCompletions.clear()
    this.#notices.clear()
    this.#noticedTurns.clear()
    this.#dismissedTurns.clear()

    // Reattaching the same live ID revokes queued notice handlers without losing side drafts.
    if (!switched) {
      this.host.changed()

      return
    }

    this.#sid = sid
    this.#epoch++

    if (this.#sheet) {
      this.host.close(this.#sheet)
      this.#sheet = undefined
    }

    this.threads = []
    this.selected = null
    this.state = 'idle'
    this.error = ''
    this.#drafts.clear()
    this.host.changed()
  }

  /** Overlay opening, dismissal or same-key replacement revokes already-dispatched SDK callbacks. */
  invalidateActions() {
    this.#noticeTicket++
  }

  /** A fresh render ticket prevents a queued SDK action from following later selection or ownership. */
  get notices(): BtwNotice[] {
    return [...this.#notices.values()].map(notice => ({ ...notice, ticket: this.#noticeTicket }))
  }

  get thread(): BtwThread | undefined {
    return this.threads.find(item => item.id === this.selected)
  }

  get draft(): Composer {
    const id = this.selected ?? 'new'
    let draft = this.#drafts.get(id)

    if (!draft) {
      draft = new Composer()
      this.#drafts.set(id, draft)
    }

    return draft
  }

  select(id: string | null) {
    if (id === null || this.threads.some(item => item.id === id)) {
      if (this.selected !== id) {
        this.#noticeTicket++
      }

      this.selected = id
      this.host.changed()
    }
  }

  /**
   * Bind native editor controls to one rendered sheet, session owner and
   * selection generation. The existing notice ticket revokes held actions
   * on selection ABA, same-ID adoption and sheet replacement.
   */
  captureEditor(sheet: Overlay): { readonly draft: Composer; current(): boolean } {
    const draft = this.draft
    const selected = this.selected
    const owner = this.#owner
    const sid = this.#sid
    const ticket = this.#noticeTicket

    return {
      draft,
      current: () => Boolean(owner && sid && this.owns(sheet) &&
        this.#owner === owner && this.host.session.ref === owner &&
        this.#sid === sid && this.selected === selected &&
        this.#noticeTicket === ticket && this.draft === draft)
    }
  }

  owns(sheet: Overlay): boolean {
    return this.#sheet === sheet &&
      this.host.overlays.includes(sheet) &&
      this.host.overlays.at(-1) === sheet &&
      this.#owner === this.host.session.ref &&
      this.host.session.ref.live === this.#sid
  }

  closed(sheet: Overlay) {
    if (this.#sheet === sheet) {
      this.#sheet = undefined
      this.#epoch++
      this.#noticeTicket++
      this.state = 'idle'
    }
  }

  close() {
    const sheet = this.#sheet

    if (sheet && this.owns(sheet)) {
      this.host.close(sheet)
    }
  }

  /**
   * Merge the newest gateway revision. A real btw.update (not list or RPC)
   * can announce a terminal turn, as in the donor's noticed-thread projection.
   */
  update(thread: BtwThread, noticed = false) {
    const index = this.threads.findIndex(item => item.id === thread.id)
    const previous = this.threads[index]
    let current: BtwThread

    if (index < 0) {
      this.threads.push(thread)
      current = thread
    } else if (previous && previous.revision < thread.revision) {
      this.threads[index] = thread
      current = thread
    } else if (noticed && previous) {
      current = previous
    } else {
      return
    }

    // A follow-up took this thread's latest-turn slot: an older completion
    // must not keep an actionable notice over the newer running work.
    if (previous && previous.turns.at(-1)?.id !== current.turns.at(-1)?.id) {
      this.#dropNotices(current.id)
    }

    const last = current.turns.at(-1)

    if (noticed && last && (last.state === 'answered' || last.state === 'error') &&
        this.#noticedTurns.get(current.id) !== last.id) {
      this.#publish(current, last.id, last.state === 'error')
    }

    this.#matchCompletions()
    this.host.changed()
  }

  /**
   * The typed legacy completion carries task_id, not thread_id. Only a unique exact
   * thread/turn ID from the session-owned BTW snapshot can authorize a View action.
   * A completion that arrives before its BTW update stays pending, without a fake thread.
   */
  completed(ev: EventOf<'btw.complete'>): boolean {
    const payload = ev.payload
    const taskId = payload?.task_id
    const text = payload?.text

    if (typeof taskId !== 'string' || !taskId.trim() || typeof text !== 'string' || !text.trim() ||
        !this.#sid || ev.session_id !== this.#sid || this.host.session.ref.live !== this.#sid ||
        this.#owner !== this.host.session.ref || this.#seenCompletions.has(taskId)) {
      return false
    }

    this.#seenCompletions.add(taskId)
    this.#pendingCompletions.set(taskId, /^error:/i.test(text.trimStart()))
    this.#matchCompletions()
    this.host.changed()

    return true
  }

  /** The gateway event is already tagged to a conversation; never append it to main history. */
  onEvent(raw: unknown) {
    const parsed = btwEvent(raw)

    if (!parsed.success || parsed.data.session_id !== this.#sid ||
        parsed.data.session_id !== this.host.session.ref.live) {
      return
    }

    this.update(parsed.data.payload.thread, true)
  }

  async show(question = '', selectedThread?: string) {
    const sid = this.host.session.ref.live

    if (!sid) {
      this.adopt(null)
      const sheet = openBtwOverlay(this)
      this.#sheet = sheet
      this.error = 'No active Hermes session.'
      this.state = 'idle'
      this.host.changed()

      return
    }

    this.adopt(sid)
    if (selectedThread && !this.threads.some(thread => thread.id === selectedThread)) {
      return
    }

    // A notice View is pinned to its thread; a slash question uses the NEW-thread slot.
    // Stage it before the fallible history read, so an unsupported gateway cannot lose it.
    const explicitQuestion = Boolean(question.trim())
    let autoSubmit: { draft: Composer; revision: bigint } | undefined

    if (selectedThread) {
      this.selected = selectedThread
    } else if (explicitQuestion) {
      this.selected = null
      const draft = this.draft

      if (!draft.text) {
        draft.set(question)
        autoSubmit = { draft, revision: draft.revision }
      } else if (draft.text !== question) {
        // A previous unadmitted question owns this draft. Retain both and require
        // an explicit Send rather than silently submitting their combined text.
        draft.splice(draft.text.length, draft.text.length, '\n' + question, draft.cursor)
      }
    }

    this.#noticeTicket++
    const sheet = openBtwOverlay(this)
    this.#sheet = sheet
    // Re-selecting a different thread and back while history loads revokes auto-send.
    const selectionTicket = this.#noticeTicket
    const epoch = ++this.#epoch
    this.state = 'loading'
    this.error = ''
    this.host.changed()

    try {
      const found = await listBtw(this.host.gw, sid)

      if (!this.#current(sid, epoch, sheet)) {
        return
      }

      for (const thread of found) {
        this.update(thread)
      }

      this.selected ??= explicitQuestion ? null : this.threads.at(-1)?.id ?? null
      this.state = 'idle'

      // A list can settle after the user edits or changes selection. Never
      // auto-submit that newer draft, or overwrite it with the slash argument.
      if (autoSubmit && this.#noticeTicket === selectionTicket &&
          this.selected === null && this.draft === autoSubmit.draft &&
          this.draft.revision === autoSubmit.revision) {
        await this.submit()
      }
    } catch {
      if (this.#current(sid, epoch, sheet)) {
        // The pinned gateway may not yet implement BTW history. Do not send a
        // legacy prompt.btw request that would change conversation semantics.
        this.error = 'Side-thread history is unavailable on this Hermes gateway.'
        this.state = 'idle'
      }
    }

    this.host.changed()
  }

  async submit(text?: string) {
    const sid = this.host.session.ref.live
    const sheet = this.#sheet
    const draft = this.draft
    const question = (text ?? draft.text).trim()
    const previous = this.selected

    if (!sid || sid !== this.#sid || !sheet || !this.owns(sheet) || this.state !== 'idle' ||
        !question || this.thread?.turns.at(-1)?.state === 'running') {
      return
    }

    const epoch = this.#epoch
    const revision = draft.revision
    this.state = 'submitting'
    this.error = ''
    this.host.changed()

    try {
      const answer = await submitBtw(this.host.gw, sid, question, previous ?? undefined)

      if (!this.#current(sid, epoch, sheet)) {
        return
      }

      this.update(answer.thread)

      if (this.selected === previous) {
        if (this.selected !== answer.thread.id) {
          this.invalidateActions()
        }

        this.selected = answer.thread.id
      }

      if (draft.revision === revision) {
        draft.set('')
      }
    } catch {
      if (this.#current(sid, epoch, sheet)) {
        this.error = 'Could not send side question. The draft was preserved.'
      }
    } finally {
      if (this.#current(sid, epoch, sheet)) {
        this.state = 'idle'
        this.host.changed()
      }
    }
  }

  async cancel() {
    const sid = this.host.session.ref.live
    const sheet = this.#sheet
    const thread = this.thread
    const turn = thread?.turns.at(-1)
    const epoch = this.#epoch

    if (!sid || sid !== this.#sid || !sheet || !this.owns(sheet) ||
        !thread || turn?.state !== 'running') {
      return
    }

    try {
      const answer = await cancelBtw(this.host.gw, sid, thread.id, turn.id)

      if (this.#current(sid, epoch, sheet)) {
        this.update(answer.thread)
      }
    } catch {
      if (this.#current(sid, epoch, sheet)) {
        this.error = 'Could not stop the side turn.'
        this.host.changed()
      }
    }
  }

  /** Never resolve a task ID via an older turn, question, index or current selection. */
  #matchCompletions() {
    if (!this.#sid || !this.#owner || this.#owner !== this.host.session.ref) {
      return
    }

    for (const [taskId, failed] of this.#pendingCompletions) {
      const matches = this.threads.filter(thread =>
        thread.id === taskId || thread.turns.at(-1)?.id === taskId
      )

      if (matches.length !== 1) {
        continue
      }

      const thread = matches[0]

      if (!thread) {
        continue
      }

      if (this.#publish(thread, taskId, failed)) {
        this.#pendingCompletions.delete(taskId)
      }
    }
  }

  /** The one current completion per gateway thread, with an immutable action identity. */
  #publish(thread: BtwThread, taskId: string, failed: boolean) {
    const turn = thread.turns.at(-1)

    // Legacy complete may race the real final snapshot. Keep it pending until
    // a terminal turn supplies the only safe View identity.
    if (!turn || turn.state === 'running' || !this.#sid || !this.#owner) {
      return false
    }

    this.#noticedTurns.set(thread.id, turn.id)

    if (this.#dismissedTurns.get(thread.id) === turn.id) {
      return true
    }

    this.#dropNotices(thread.id)
    this.#notices.set(thread.id, {
      id: 'btw:' + thread.id,
      taskId,
      threadId: thread.id,
      turnId: turn.id,
      sid: this.#sid,
      owner: this.#owner,
      nonce: ++this.#noticeNonce,
      failed
    })
    this.#noticeTicket++

    return true
  }

  /** Deletes only notices owned by this thread, revoking their already-rendered handlers. */
  #dropNotices(threadId: string) {
    let removed = false

    for (const [key, notice] of this.#notices) {
      if (notice.threadId === threadId) {
        this.#notices.delete(key)
        removed = true
      }
    }

    if (removed) {
      this.#noticeTicket++
    }
  }

  #ownsNotice(notice: BtwNotice): boolean {
    const current = this.#notices.get(notice.threadId)

    return Boolean(current && current.nonce === notice.nonce &&
      current.id === notice.id && current.threadId === notice.threadId &&
      current.taskId === notice.taskId &&
      notice.ticket === this.#noticeTicket && notice.sid === this.#sid &&
      notice.sid === this.host.session.ref.live && notice.owner === this.#owner &&
      notice.owner === this.host.session.ref &&
      this.threads.some(thread => thread.id === notice.threadId &&
        thread.turns.at(-1)?.id === notice.turnId && thread.turns.at(-1)?.state !== 'running'))
  }

  /** Opens only the captured completed thread, refusing modal precedence and stale SDK actions. */
  viewNotice(notice: BtwNotice) {
    if (!this.#ownsNotice(notice) || this.host.overlays.at(-1)?.modal) {
      return
    }

    void this.show('', notice.threadId)
  }

  /** Dismissal revokes both the removed notice and any previously rendered action tickets. */
  dismissNotice(notice: BtwNotice) {
    if (!this.#ownsNotice(notice)) {
      return
    }

    this.#notices.delete(notice.threadId)
    this.#dismissedTurns.set(notice.threadId, notice.turnId)
    this.#noticeTicket++
    this.host.changed()
  }

  #current(sid: string, epoch: number, sheet: Overlay): boolean {
    return this.#epoch === epoch && this.#sid === sid && this.host.session.ref.live === sid &&
      this.#sheet === sheet && this.host.overlays.includes(sheet)
  }
}
