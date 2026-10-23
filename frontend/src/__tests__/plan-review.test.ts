import { Node, node, type JSX } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { localCommand } from '../commands/local.js'
import type { CommandHost } from '../commands/local.js'
import { entryId, liveSessionId } from '../core/ids.js'
import type { Entry } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openPlanReview, type PlanReviewHost } from '../overlays/plan.js'
import { latestPlan, parsePlan, planStatusOf, reviewPlanText } from '../plan.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, key, must, stub, type Reply } from './fakes.js'

const paint = async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

const doneTurn = (text: string): Entry => ({
  blocks: [{ id: entryId('content'), kind: 'text', text }],
  end: { status: 'done' },
  id: entryId('assistant'),
  kind: 'turn',
  rev: 1,
  startedAt: 1
})

type PlanFixture = {
  enabled: boolean
  generating: boolean
  plan: {
    annotations: { section: number; text: string }[]
    decision: 'pending'
    id: string
    revision: number
    text: string
  }
}

const initial = (): PlanFixture => ({
  enabled: true,
  generating: false,
  plan: {
    annotations: [],
    decision: 'pending',
    id: 'plan-1',
    revision: 3,
    text: 'Intro\n# Implement\nGoal\n## Build\nChange one file\n## Verify\nRun tests'
  }
})

function fixture(replies: Record<string, Reply> = {}) {
  const overlays: Overlay[] = []
  const gw = new FakeGateway({ replies })
  const transcript = new Transcript()
  const session = { info: null, ref: { live: liveSessionId('runtime-a'), stored: null } }
  const changed = vi.fn()
  const scroll = vi.fn()
  const notices = vi.fn()

  transcript.push(doneTurn('Preamble\n# Assistant plan\n## Phase one\nComplete the task'))

  const host: PlanReviewHost = {
    busy: null,
    changed,
    close: overlay => {
      const index = overlays.indexOf(overlay)

      if (index !== -1) {
        overlays.splice(index, 1)
        overlay.onClose?.()
        changed()
      }
    },
    gw: gw.client,
    notice: notices,
    open: overlay => {
      const index = overlays.findIndex(item => item.key === overlay.key)

      if (index !== -1) {
        overlays.splice(index, 1)[0]?.onClose?.()
      }

      overlays.push(overlay)
      changed()
    },
    overlays,
    scroll,
    session,
    transcript
  }

  const walk = (elements: readonly JSX.Element[]): Node[] =>
    elements.flatMap(element => element instanceof Node ? [element, ...walk(element.children)] : [])

  const nodes = () => {
    const overlay = overlays.at(-1)

    return overlay ? walk([overlay.node('layer.' + overlay.key)]) : []
  }
  const element = (name: string) => nodes().find(node => node.props.key === name)
  const click = (name: string) => {
    const found = element(name)
    const action = found?.handlers?.onClick

    if (!action) {
      throw new Error('No native action for ' + name)
    }

    return action({ act: 'click', ev: 'action', id: 'fixture', raw: {}, sf: 'hermes' })
  }
  const capture = (name: string) => {
    const found = element(name)
    const action = found?.handlers?.onClick

    if (!action) {
      throw new Error('No native action for ' + name)
    }

    return () => action({ act: 'click', ev: 'action', id: 'fixture', raw: {}, sf: 'hermes' })
  }

  return { capture, changed, click, element, gw, host, nodes, notices, overlays, scroll, session, transcript }
}

describe('Hermes plan parser and authority boundary', () => {
  it('ignores fenced headings, user text and unfinished turns', () => {
    const text = 'Intro\n' + '~~~md\n# Hidden\n~~~\n' + '# Actual\nBody\n## Same\nOne\n## Same\nTwo'
    const parsed = must(parsePlan(text))

    expect(parsed.preamble).toBe('Intro\n~~~md\n# Hidden\n~~~\n')
    expect(parsed.sections.map(section => section.title)).toEqual(['Actual', 'Same', 'Same'])
    expect(parsed.sections[2]?.text).toBe('## Same\nTwo')
    expect(parsePlan('~~~md\n# Only code\n~~~')).toBeUndefined()
    expect(reviewPlanText('Plain backend plan').sections[0]?.text).toBe('Plain backend plan')
    expect(latestPlan([
      doneTurn('# Approved candidate'),
      { at: 0, id: entryId('user'), kind: 'user', text: '# Fake plan' },
      {
        blocks: [{ id: entryId('live'), kind: 'text', text: '# Not complete' }],
        end: { status: 'live' },
        id: entryId('streaming'),
        kind: 'turn',
        rev: 1,
        startedAt: 2
      }
    ])?.sections[0]?.title).toBe('Approved candidate')
  })

  it('accepts only a complete revision-bound gateway status', () => {
    expect(planStatusOf(initial())?.plan?.revision).toBe(3)
    expect(planStatusOf({ enabled: true, generating: false, plan: {} })).toBeUndefined()
    expect(planStatusOf({ ...initial(), plan: { ...initial().plan, revision: 0 } })).toBeUndefined()
    expect(planStatusOf({ ...initial(), plan: { ...initial().plan, annotations: [{ section: -1, text: 'x' }] } })).toBeUndefined()
    expect(planStatusOf({ enabled: false, generating: true, plan: null })).toEqual({ enabled: false, generating: true, plan: null })
  })
})

describe('native plan review', () => {
  it('is read-only without a compatible backend, including an ordinary heading-based candidate', async () => {
    const f = fixture()
    openPlanReview(f.host)
    await paint()

    expect(f.gw.sent('plan.status')).toEqual([{ session_id: 'runtime-a' }])
    expect(f.element('authority')?.props.text).toContain('Plan authority unavailable')
    expect(f.element('markdown')?.props.text).toContain('# Assistant plan')
    expect(f.element('approve')).toBeUndefined()
    expect(f.element('refine')).toBeUndefined()
    expect(f.element('mode')).toBeUndefined()
    f.click('section-1')
    expect(f.scroll).toHaveBeenCalledWith('layer.plan.body.markdown', 'start')
    expect(f.element('markdown')?.props.text).toContain('## Phase one')
    f.click('close')
    expect(f.overlays).toHaveLength(0)
    expect(f.gw.sent('prompt.submit')).toEqual([])
  })

  it('renders authoritative status and sends a single exact-revision approval, not a prompt', async () => {
    const status = initial()
    const f = fixture({
      'plan.status': () => structuredClone(status),
      'plan.decide': params => ({ ...status, plan: { ...status.plan, decision: params['intent'] === 'approve' ? 'approved' : 'refined' } })
    })
    openPlanReview(f.host)
    await paint()

    expect(f.element('authority')?.props.text).toContain('plan-1 · revision 3')
    expect(f.element('markdown')?.props.text).toContain('# Implement')
    const first = f.capture('approve')
    first()
    first()
    await paint()

    expect(f.gw.sent('plan.decide')).toEqual([{
      feedback: '', intent: 'approve', plan_id: 'plan-1', revision: 3, session_id: 'runtime-a'
    }])
    expect(f.gw.sent('prompt.submit')).toEqual([])
    expect(f.overlays).toHaveLength(0)
  })

  it('round-trips annotation and editing as new revisions; stale captured decisions do nothing', async () => {
    let status = initial()
    const check = (params: Record<string, unknown>) => {
      if (params['plan_id'] !== status.plan.id || params['revision'] !== status.plan.revision) {
        throw new Error('Stale plan revision')
      }
    }
    const f = fixture({
      'plan.status': () => structuredClone(status),
      'plan.annotate': params => {
        check(params)
        status = { ...status, plan: {
          ...status.plan, annotations: [{ section: Number(params['section']), text: String(params['text']) }],
          revision: status.plan.revision + 1
        } }

        return structuredClone(status)
      },
      'plan.edit': params => {
        check(params)
        status = { ...status, plan: {
          ...status.plan, annotations: [], revision: status.plan.revision + 1, text: String(params['text'])
        } }

        return structuredClone(status)
      },
      'plan.decide': () => { throw new Error('Stale approval should never reach gateway') }
    })

    openPlanReview(f.host)
    await paint()
    const stale = f.capture('approve')
    f.click('section-1')
    f.click('annotate')
    f.overlays.at(-1)?.onKey(key('text', { text: 'Add rollback test' }))
    f.click('save')
    await paint()

    expect(f.gw.sent('plan.annotate')).toEqual([{
      plan_id: 'plan-1', revision: 3, section: 1, session_id: 'runtime-a', text: 'Add rollback test'
    }])
    expect(f.element('authority')?.props.text).toContain('revision 4')
    expect(f.nodes().some(node => node.props.role === 'omp.plan.annotation')).toBe(true)
    stale()
    expect(f.gw.sent('plan.decide')).toEqual([])

    f.click('edit-plan')
    // The dedicated editor starts with the plan; replace it without touching the prompt draft.
    for (let index = 0; index < status.plan.text.length; index++) {
      f.overlays.at(-1)?.onKey(key('backspace'))
    }
    f.overlays.at(-1)?.onKey(key('text', { text: '# Smaller\nOnly one change' }))
    f.click('save')
    await paint()
    expect(f.gw.sent('plan.edit')[0]).toEqual({
      plan_id: 'plan-1', revision: 4, session_id: 'runtime-a', text: '# Smaller\nOnly one change'
    })
    expect(f.element('authority')?.props.text).toContain('revision 5')
    expect(f.gw.sent('prompt.submit')).toEqual([])
  })

  it('drops replaced or changed-session decisions, and never displaces an active prompt', async () => {
    const f = fixture({ 'plan.status': initial, 'plan.decide': initial })

    openPlanReview(f.host)
    await paint()
    const stale = f.capture('approve')
    openPlanReview(f.host)
    await paint()
    stale()
    expect(f.gw.sent('plan.decide')).toEqual([])
    const afterReplacement = f.capture('approve')
    f.session.ref.live = liveSessionId('runtime-b')
    afterReplacement()
    expect(f.gw.sent('plan.decide')).toEqual([])

    const active = f.overlays.at(0)

    if (active) {
      f.host.close(active)
    }
    const prompt: Overlay = { key: 'approval', modal: true, node: () => node('overlay', { key: 'approval', modal: true }), onKey: () => true }
    f.host.open(prompt)
    openPlanReview(f.host)
    expect(f.overlays).toEqual([prompt])
    expect(f.notices).toHaveBeenCalledWith(expect.stringContaining('Close the current question'), 'warning')
  })

  it('preserves /plan with arguments as gateway generation and opens only bare /plan locally', async () => {
    const f = fixture({ 'plan.status': initial })
    const cmd = must(localCommand('plan'))

    expect(await cmd.run(stub<CommandHost>(f.host), 'build the change')).toBe(false)
    expect(f.gw.sent('plan.status')).toEqual([])
    await cmd.run(stub<CommandHost>(f.host), '')
    await paint()
    expect(f.element('authority')?.props.text).toContain('revision 3')
  })
})
