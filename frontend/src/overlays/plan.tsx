// Native revision-bound plan review; Hermes gateway remains the only plan authority.
// Adapted from Hermes ui-tsp/src/overlays/plan-review.tsx to hermes-tern's overlay API.

import type { JSX, Key } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { Composer } from '../draft/composer.js'
import { errorText } from '../core/errors.js'
import { latestPlan, planStatusOf, reviewPlanText, type Plan, type PlanStatus } from '../plan.js'
import { editPlanExternal } from '../plan-editor.js'
import { actionsRow, button, type ButtonProps } from '../view/ui/button.js'

import type { Overlay } from './overlay.js'

/** The existing app's narrow ports; no duplicate gateway or session authority. */
export type PlanReviewHost = Pick<
  ChatPorts,
  'busy' | 'changed' | 'close' | 'gw' | 'notice' | 'open' | 'overlays' | 'scroll' | 'session' | 'transcript'
>

interface Target {
  session_id: string
  plan_id: string
  revision: number
}

type EditKind = 'annotation' | 'plan' | 'refine'

/** Opens an inspection sheet; backend mutations are enabled only after a valid plan.status. */
export function openPlanReview(host: PlanReviewHost): void {
  const sid = host.session.ref.live

  if (!sid) {
    host.notice('A live Hermes session is required to review a plan.', 'warning')

    return
  }

  if (host.overlays.at(-1)?.modal && host.overlays.at(-1)?.key !== 'plan') {
    host.notice('Close the current question before opening plan review.', 'warning')

    return
  }

  let plan: Plan | undefined = latestPlan(host.transcript.entries)
  let status: PlanStatus | undefined
  let loading = true
  let selected = 0
  let editing: EditKind | undefined
  let editingSection = 0
  let busy = false
  let submitted = false
  let closed = false
  let error = ''
  const note = new Composer()

  const owned = () => !closed && host.overlays.includes(overlay) && host.session.ref.live === sid
  const target = (): Target | undefined =>
    status?.plan ? { plan_id: status.plan.id, revision: status.plan.revision, session_id: sid } : undefined
  const same = (expected: Target | undefined) => {
    const actual = target()

    return Boolean(expected && actual && expected.session_id === actual.session_id &&
      expected.plan_id === actual.plan_id && expected.revision === actual.revision)
  }
  const canDecide = () =>
    Boolean(status?.enabled && status.plan?.decision === 'pending' && !status.generating && !host.busy && !busy && !submitted)
  const close = () => host.close(overlay)

  const update = (next: unknown) => {
    const verified = planStatusOf(next)

    if (!verified) {
      throw new Error('The gateway returned an invalid plan status. No plan change was assumed.')
    }

    status = verified
    plan = verified.plan ? reviewPlanText(verified.plan.text) : latestPlan(host.transcript.entries)
    selected = Math.min(selected, Math.max(0, (plan?.sections.length ?? 1) - 1))
    editing = undefined
    note.set('')
  }

  const transact = async (request: () => Promise<unknown>, closeOnSuccess = false) => {
    if (!owned() || busy || submitted || host.busy) {
      return
    }

    busy = true
    error = ''
    host.changed()

    try {
      const result = await request()

      if (!owned()) {
        return
      }

      update(result)

      if (closeOnSuccess) {
        submitted = true
        close()
      }
    } catch (cause) {
      if (owned()) {
        error = errorText(cause)
      }
    } finally {
      busy = false

      if (owned()) {
        host.changed()
      }
    }
  }

  const choose = (index: number) => {
    if (!owned() || !plan?.sections[index] || editing) {
      return
    }

    selected = index
    host.changed()
    host.scroll('layer.plan.body.markdown', 'start')
  }

  const startEdit = (kind: EditKind) => {
    if (!owned() || !canDecide() || !plan) {
      return
    }

    editing = kind
    editingSection = selected
    note.set(
      kind === 'plan' ? plan.text :
      kind === 'annotation' ? (status?.plan?.annotations.find(a => a.section === selected)?.text ?? '') : ''
    )
    error = ''
    host.changed()
  }

  const write = (revision: Target | undefined) => {
    if (!owned() || !canDecide() || !same(revision) || !editing) {
      return
    }

    const text = note.text.trim()

    if (editing === 'annotation') {
      if (text.length > 16000) {
        error = 'A section note must be at most 16,000 characters.'
        host.changed()

        return
      }

      void transact(() => host.gw.request<unknown>('plan.annotate', {
        ...revision!, section: editingSection, text
      }))
    } else if (editing === 'plan') {
      if (!text || note.text.length > 200000) {
        error = 'The plan revision must contain 1 to 200,000 characters.'
        host.changed()

        return
      }

      void transact(() => host.gw.request<unknown>('plan.edit', { ...revision!, text: note.text }))
    } else {
      if (text.length > 16000) {
        error = 'Refinement feedback must be at most 16,000 characters.'
        host.changed()

        return
      }

      if (text || status?.plan?.annotations.length) {
        void transact(
          () => host.gw.request<unknown>('plan.decide', { ...revision!, feedback: text, intent: 'refine' }),
          true
        )
      }
    }
  }

  const approve = (revision: Target | undefined) => {
    if (!owned() || !canDecide() || !same(revision) || editing) {
      return
    }

    void transact(
      () => host.gw.request<unknown>('plan.decide', { ...revision!, feedback: '', intent: 'approve' }),
      true
    )
  }

  const toggleMode = () => {
    if (!owned() || !status || busy || submitted || host.busy) {
      return
    }

    const enabled = !status.enabled

    void transact(() => host.gw.request<unknown>('plan.mode', { enabled, session_id: sid }))
  }

  const externalEdit = (revision: Target | undefined, initial: string | undefined) => {
    if (!owned() || !canDecide() || !same(revision) || initial === undefined) {
      return
    }

    void transact(async () => {
      const text = await editPlanExternal(initial)

      if (!owned() || !same(revision)) {
        throw new Error('Plan review or revision changed; external edit was discarded.')
      }

      if (!text.trim() || text.length > 200000) {
        throw new Error('The edited plan must contain 1 to 200,000 characters.')
      }

      return host.gw.request<unknown>('plan.edit', { ...revision!, text })
    })
  }

  const render = (): JSX.Element => {
    const revision = target()
    const allowed = canDecide()
    const section = plan?.sections[selected]
    const annotations = status?.plan?.annotations.filter(item => item.section === selected) ?? []
    const actions: ButtonProps[] = []

    if (editing) {
      actions.push({ key: 'review', label: 'Back to plan', onClick: () => { editing = undefined; host.changed() } })
      actions.push({ key: 'save', label: editing === 'refine' ? 'Send refinement' : 'Save revision', onClick: () => write(revision) })
    } else if (allowed && plan && revision) {
      actions.push({ key: 'approve', label: 'Approve exact revision (no execution)', onClick: () => approve(revision) })
      actions.push({ key: 'refine', label: 'Refine', onClick: () => startEdit('refine') })
    }

    actions.push({ hint: 'escape', key: 'close', label: 'Close', onClick: close })

    const authority = loading
      ? 'Checking gateway plan authority…'
      : status
        ? 'Plan mode ' + (status.enabled ? 'ON · planning-only' : 'OFF') + ' · ' +
          (status.generating ? 'Generating; not approvable' :
            status.plan ? status.plan.id + ' · revision ' + status.plan.revision + ' · ' + status.plan.decision :
              'No authoritative plan')
        : 'Plan authority unavailable. Markdown is for inspection only; no approval is implied.'

    return (
      <overlay anchor="center" head="Plan review" key="plan" modal role="omp.overlay.plan" size="lg">
        <col gap="md" key="body">
          <text key="authority" text={authority} wrap="word" />
          {error ? <text key="error" text={error} wrap="word" /> : null}
          {busy ? <text key="pending" text="Waiting for Hermes to confirm the plan operation…" /> : null}
          {status && !loading && !busy && !host.busy ? button({
            key: 'mode',
            label: status.enabled ? 'Disable plan mode' : 'Enable plan mode',
            onClick: toggleMode
          }) : null}
          {allowed && plan && revision ? (
            <row gap="sm" key="tools" role="omp.plan.tools">
              {button({ key: 'annotate', label: 'Annotate section', onClick: () => startEdit('annotation') })}
              {button({ key: 'edit-plan', label: 'Edit plan', onClick: () => startEdit('plan') })}
              {button({ key: 'external-editor', label: 'Edit in $EDITOR', onClick: () => externalEdit(revision, plan?.text) })}
            </row>
          ) : null}
          {!editing && plan ? (
            <col gap="xs" key="contents" role="omp.plan.contents">
              <text key="hint" text={'Section ' + (selected + 1) + '/' + plan.sections.length + ' · Up/Down to jump'} />
              {plan.sections.map((part, index) => button({
                key: 'section-' + index,
                label: '  '.repeat(Math.max(0, part.level - 1)) + part.title,
                onClick: () => choose(index)
              }))}
            </col>
          ) : null}
          {annotations.map(a => <text key={'annotation-' + a.section} role="omp.plan.annotation" text={'Note: ' + a.text} />)}
          {editing ? (
            <col gap="sm" key="edit">
              <text
                key="editing-hint"
                text={
                  editing === 'plan' ? 'Edit the whole revision; saving clears section notes.' :
                  editing === 'annotation' ? 'Write a note for the selected section.' :
                  'Describe how Hermes should refine this plan.'
                }
              />
              <input
                aria={editing === 'plan' ? 'Plan revision' : editing === 'annotation' ? 'Section annotation' : 'Plan feedback'}
                cursor={note.cursor}
                key="note"
                onEdit={ev => {
                  if (owned() && editing) {
                    note.edit(ev)
                    host.changed()
                  }
                }}
                onUndo={() => {
                  if (owned() && editing) {
                    note.undo()
                    host.changed()
                  }
                }}
                placeholder="Your prompt draft stays untouched"
                role="omp.ask.input"
                text={note.text}
              />
            </col>
          ) : (
            <md
              key="markdown"
              role="omp.plan.body"
              text={plan ? (selected === 0 ? plan.preamble : '') + (section?.text ?? '') :
                status?.generating ? 'Hermes is still generating this plan.' :
                'No completed assistant plan found. Ask Hermes to make a plan first.'}
            />
          )}
          {actionsRow(actions)}
        </col>
      </overlay>
    )
  }

  const overlay: Overlay = {
    key: 'plan',
    modal: true,
    cancel: close,
    focus: id => editing ? id + '.body.edit.note' : null,
    node: render,
    onClose: () => { closed = true },
    onKey: (key: Key) => {
      if (key.name === 'escape') {
        if (editing) {
          editing = undefined
          host.changed()
        } else {
          close()
        }

        return true
      }

      if (editing) {
        if (note.key(key) === 'submit') {
          write(target())
        }

        host.changed()

        return true
      }

      if (key.name === 'up' && !key.ctrl && !key.alt && !key.meta) {
        choose(selected - 1)
      } else if (key.name === 'down' && !key.ctrl && !key.alt && !key.meta) {
        choose(selected + 1)
      } else if (key.name === 'a' && key.alt && !key.ctrl && !key.meta) {
        approve(target())
      } else if (key.name === 'r' && key.alt && !key.ctrl && !key.meta) {
        startEdit('refine')
      }

      return true
    }
  }

  host.open(overlay)

  // A missing or incompatible plan RPC never silently turns an ordinary answer into approval.
  void host.gw.request<unknown>('plan.status', { session_id: sid })
    .then(reply => {
      if (!owned()) {
        return
      }

      loading = false
      const verified = planStatusOf(reply)

      if (verified) {
        update(verified)
      } else {
        error = 'This Hermes gateway does not provide a compatible plan.status response.'
      }

      host.changed()
    })
    .catch(() => {
      if (owned()) {
        loading = false
        error = 'This Hermes gateway does not expose plan review RPCs; inspection only.'
        host.changed()
      }
    })
}
