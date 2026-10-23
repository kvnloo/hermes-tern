// End-to-end model/overlay contracts against a recording gateway and Tern's real nodes.
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { BtwThreads } from '../btw.js'
import { copyToClipboard } from '../clipboard.js'
import { localCommand } from '../commands/local.js'
import type { BtwThread } from '../wire/side.js'

import { FakeGateway, fakeTern, given, key, must, stubOverlay, tree } from './fakes.js'
import { sideSetup } from './sideSetup.js'

vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))
vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

function thread(id: string, state: BtwThread['turns'][number]['state'] = 'answered', revision = 1): BtwThread {
  return {
    id, revision,
    turns: [{ id: id + '-turn', question: 'Question ' + id, answer: 'Answer ' + id, state }]
  }
}

function walk(n: NodeJson): NodeJson[] {
  return [n, ...(n.c ?? []).flatMap(walk)]
}

function parts(model: BtwThreads, overlayId = 'layer.btw'): NodeJson[] {
  const overlay = must(model.host.overlays.at(-1))

  return walk(tree(overlay.node(overlayId)))
}

function textFor(model: BtwThreads, role: string): unknown[] {
  return parts(model).filter(n => n.p?.['role'] === role).map(n => n.p?.['text'])
}

describe('native BTW thread history and reader', () => {
  it('routes /btw to the native sheet, never to the legacy prompt.btw command', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('prior')] }))
    expect(localCommand('btw')?.run).toBeDefined()
    await must(localCommand('btw')).run({ ...f.host, btw: model }, '')
    expect(f.gw.sent('btw.list')).toEqual([{ session_id: 's1' }])
    expect(f.gw.methods('prompt.btw')).toHaveLength(0)
    expect(f.overlays.map(o => o.key)).toEqual(['btw'])
  })

  it('loads 237 threads without a cap and allows independent history/reader scrolling', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    const all = Array.from({ length: 237 }, (_, i) => thread('t' + i))
    f.gw.handlers.set('btw.list', () => ({ threads: all }))
    await model.show()
    expect(model.threads).toHaveLength(237)
    expect(parts(model).filter(n => n.p?.['role'] === 'omp.btn').length).toBeGreaterThan(237)
    const sheet = must(f.overlays.at(-1))
    sheet.onKey(key('tab'))
    sheet.onKey(key('tab'))
    sheet.onKey(key('page_down'))
    expect(f.scroll).toHaveBeenCalledWith('layer.btw.body.panes.history', 'page-down')
    sheet.onKey(key('tab'))
    sheet.onKey(key('page_up'))
    expect(f.scroll).toHaveBeenCalledWith('layer.btw.body.panes.reader', 'page-up')
    sheet.onKey(key('n', { ctrl: true }))
    expect(model.selected).toBe('t0')
  })

  it('streams revisions without downgrading to an older RPC reply, and never changes the main transcript', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    const earlier = thread('prior')
    f.gw.handlers.set('btw.list', () => ({ threads: [earlier] }))
    await model.show()
    model.draft.set('Follow up 🦉', { cursor: 3 })
    const reply = Promise.withResolvers<unknown>()
    f.gw.handlers.set('btw.submit', () => reply.promise)
    const pending = model.submit()
    const streaming = { ...earlier, revision: 3, turns: [
      ...earlier.turns,
      { id: 'followup', question: 'Follow up 🦉', answer: 'Real delta', state: 'running' as const }
    ] }
    model.onEvent({ type: 'btw.update', session_id: 's1', payload: { thread: streaming } })
    model.onEvent({ type: 'btw.update', session_id: 'foreign', payload: { thread: thread('foreign') } })
    reply.resolve({ thread: { ...streaming, revision: 2, turns: [
      ...earlier.turns, { ...streaming.turns[1], answer: '' }
    ] }, turn_id: 'followup' })
    await pending
    expect(model.thread?.revision).toBe(3)
    expect(model.thread?.turns.at(-1)?.answer).toBe('Real delta')
    expect(textFor(model, 'omp.btw.answer')).toContain('Real delta')
    expect(f.gw.sent('btw.submit')).toEqual([{ session_id: 's1', thread_id: 'prior', text: 'Follow up 🦉' }])
    expect(model.draft.text).toBe('')
  })


  it('preserves an edited BTW draft after a late submit succeeds', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('prior')] }))
    await model.show()
    const draft = model.draft
    draft.set('Initial question')
    const reply = Promise.withResolvers<unknown>()
    f.gw.handlers.set('btw.submit', () => reply.promise)
    const pending = model.submit()
    const submittedRevision = draft.revision
    draft.set('Newer unsent question', { cursor: 5 })
    expect(draft.revision).toBeGreaterThan(submittedRevision)
    reply.resolve({ thread: thread('prior', 'answered', 2), turn_id: 'prior-turn' })
    await pending
    expect(draft.text).toBe('Newer unsent question')
    expect(draft.cursor).toBe(5)
    expect(model.state).toBe('idle')
    expect(f.gw.methods('prompt.submit')).toEqual([])
  })

  it('protects an ABA/undo draft from a late BTW reply, even when the original text returns', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('prior')] }))
    await model.show()
    const draft = model.draft
    draft.set('Same 🦉', { cursor: 2 })
    const reply = Promise.withResolvers<unknown>()
    f.gw.handlers.set('btw.submit', () => reply.promise)
    const pending = model.submit()
    const submittedRevision = draft.revision
    draft.edit({ cursor: 3, from: 2, len: draft.text.length, text: 'x', to: 2 })
    expect(draft.text).toBe('Saxme 🦉')
    draft.undo()
    expect(draft.text).toBe('Same 🦉')
    expect(draft.cursor).toBe(2)
    expect(draft.revision).toBeGreaterThan(submittedRevision)
    reply.resolve({ thread: thread('prior', 'answered', 2), turn_id: 'prior-turn' })
    await pending
    expect(draft.text).toBe('Same 🦉')
    expect(draft.cursor).toBe(2)
    expect(f.gw.methods('prompt.submit')).toEqual([])
  })

  it('starts a new side question with canonical IDs; cancellation scopes the selected turn', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('old')] }))
    f.gw.handlers.set('btw.submit', () => ({ thread: thread('created', 'running'), turn_id: 'created-turn' }))
    f.gw.handlers.set('btw.cancel', () => ({ thread: thread('created', 'cancelled', 2), turn_id: 'created-turn' }))
    await model.show('What changed?')
    expect(f.gw.sent('btw.submit')).toEqual([{ session_id: 's1', text: 'What changed?' }])
    expect(model.selected).toBe('created')
    await model.cancel()
    expect(f.gw.sent('btw.cancel')).toEqual([{
      session_id: 's1', thread_id: 'created', turn_id: 'created-turn'
    }])
    expect(model.thread?.turns[0]?.state).toBe('cancelled')
  })

  it('keeps each unsent draft across selections, close and reopen, without leaking the main draft', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('a'), thread('b')] }))
    await model.show()
    model.select('a')
    model.draft.set('A 🦉', { cursor: 1 })
    model.select('b')
    model.draft.set('B 🦉', { cursor: 2 })
    model.select('a')
    expect(model.draft.text).toBe('A 🦉')
    expect(model.draft.cursor).toBe(1)
    const before = f.gw.calls.length
    const sheet = must(f.overlays.at(-1))
    f.open(stubOverlay('approval', { modal: true }))
    sheet.onKey(key('enter'))
    expect(f.gw.calls).toHaveLength(before)
    f.close(must(f.overlays.at(-1)))
    model.close()
    await model.show()
    expect(model.draft.text).toBe('A 🦉')
    model.select('b')
    expect(model.draft.text).toBe('B 🦉')
  })

  it('copies only the chosen side thread and never calls a gateway mutation on Copy', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => ({ threads: [thread('selected')] }))
    await model.show()
    const count = f.gw.calls.length
    must(f.overlays.at(-1)).onKey(key('c'))
    expect(copyToClipboard).toHaveBeenCalledWith('Question selected\n\nAnswer selected')
    expect(f.gw.calls).toHaveLength(count)
  })

  it('discards late list results and invalidates stale sheets when a different session is adopted', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    const pendingList = Promise.withResolvers<unknown>()
    f.gw.handlers.set('btw.list', () => pendingList.promise)
    const pending = model.show()
    const old = must(f.overlays.at(-1))
    f.session.ref.live = 's2'
    model.adopt('s2')
    pendingList.resolve({ threads: [thread('private-old')] })
    await pending
    expect(model.threads).toEqual([])
    expect(f.overlays).toEqual([])
    old.onKey(key('enter'))
    expect(f.gw.methods('btw.submit')).toHaveLength(0)
    expect(model.draft.text).toBe('')
  })

  it('projects backend stream events through the real App subscription, not the main transcript', async () => {
    const gw = new FakeGateway({ replies: { 'btw.list': () => ({ threads: [thread('app-thread')] }) } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')

    try {
      await app.btw.show()
      const before = app.transcript.entries.length
      const updated = { ...thread('app-thread', 'running', 2), turns: [{
        id: 'app-thread-turn', question: 'Question app-thread', answer: 'Streamed outside main', state: 'running' as const
      }] }
      gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: updated } })
      expect(app.btw.thread?.turns[0]?.answer).toBe('Streamed outside main')
      expect(app.transcript.entries).toHaveLength(before)
    } finally {
      app.quit()
      tern.end()
      await running
    }
  })

  it('leaves drafts in place on invalid list, submit and malformed update replies', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    f.gw.handlers.set('btw.list', () => { throw new Error('unsupported gateway') })
    await model.show()
    expect(model.error).toContain('unavailable')
    model.draft.set('Keep my draft')
    f.gw.handlers.set('btw.submit', () => { throw new Error('provider error') })
    await model.submit()
    expect(model.draft.text).toBe('Keep my draft')
    model.onEvent({ type: 'btw.update', session_id: 's1', payload: { thread: { id: 'bad' } } })
    expect(model.threads).toEqual([])
  })
})
