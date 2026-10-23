// Pinned public Tern Session and Surface: real editor action, raw keys, and
// ownership regressions. This is not a private native compositor mouse test.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Session, type Surface } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { readLaunchEnv } from '../config/env.js'
import type { BtwThread } from '../wire/side.js'

import { FakeGateway, given, must } from './fakes.js'

const EDITOR = 'layer.btw.body.followup'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function painted() {
  for (let i = 0; i < 8; i++) await turn()
}
interface Harness {
  readonly app: App
  readonly gw: FakeGateway
  readonly tern: Session
  surface(): Surface
  wire(): string
  event(body: Record<string, unknown>): Promise<void>
  raw(bytes: string): void
}
function thread(id: string): BtwThread {
  return { id, revision: 1, turns: [{
    id: id + '-turn', question: 'Question ' + id, answer: 'Answer ' + id, state: 'answered'
  }] }
}
async function withNativeApp(check: (h: Harness) => Promise<void>) {
  const priorHome = process.env['HERMES_HOME']
  const home = mkdtempSync(join(tmpdir(), 'hermes-btw-sdk-input-'))
  process.env['HERMES_HOME'] = home
  const input = new EventEmitter()
  let outbound = ''
  const tern = new Session(input, {
    write: bytes => { outbound += Buffer.from(bytes).toString('utf8') }
  }, { exitHooks: false, record: '' })
  const hello = tern.handshake()
  input.emit('data', '\x1b_tsp;r;' + JSON.stringify({
    ...tern.caps, r: 'hello', v: 1, term: 'btw-sdk-peer', ver: '0',
    features: [], credits: 64, apc: 1048576
  }) + '\x1b\\')
  let app: App | undefined
  let running: Promise<number> | undefined
  try {
    expect(await hello).toBe(true)
    const gw = new FakeGateway({ replies: {
      'setup.status': () => ({ provider_configured: true }),
      'session.create': () => ({ session_id: 's1', subscription_id: 'sub1' }),
      'btw.list': () => { throw new Error('pinned gateway lacks BTW history') },
      'btw.submit': () => { throw new Error('pinned gateway lacks BTW submit') }
    } })
    app = new App(tern, gw.client, 'test', {
      launch: readLaunchEnv({ HOME: home, HERMES_HOME: home }, home)
    })
    running = app.run()
    gw.event({ type: 'gateway.ready', payload: {} })
    await painted()
    given.session(app, 's1')
    await app.btw.show('side 🧪 粘')
    expect(app.btw.error).toContain('unavailable')
    await painted()
    await check({
      app, gw, tern,
      surface: () => must(tern.surfaces[0], 'a real Tern Surface'),
      wire: () => outbound,
      event: async body => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify(body) + '\x1b\\')
        await painted()
      },
      raw: bytes => input.emit('data', Buffer.from(bytes, 'utf8'))
    })
  } finally {
    app?.quit()
    if (running) await running
    else await tern.close()
    if (priorHome === undefined) delete process.env['HERMES_HOME']
    else process.env['HERMES_HOME'] = priorHome
    rmSync(home, { force: true, recursive: true })
  }
}
describe('BTW native SDK editor focus and ownership', () => {
  it('acquires pointer focus at unchanged caret before raw Unicode, bracketed paste and Enter', async () => {
    await withNativeApp(async h => {
      const side = h.app.btw.draft
      const initial = side.text
      const revision = side.revision
      const cursor = side.cursor
      const surface = h.surface()
      const main = h.app.stores.composer
      main.set('Unsent main 🦊', { cursor: 4 })
      const transcript = [...h.app.transcript.entries]
      const click = { ev: 'action' as const, sf: surface.id, id: EDITOR, act: 'click', raw: {} }
      expect(surface.dispatch(click), 'editor must register an actual SDK click').toBeTypeOf('function')
      // No edit, cursor move or text mutation before this pointer action.
      await h.event(click)
      expect(side.text).toBe(initial)
      expect(side.cursor).toBe(cursor)
      expect(side.revision).toBe(revision)
      await vi.waitFor(() => expect(h.wire()).toMatch(/\["focus","layer\.btw\.body\.followup"\]/))
      const typed = ' 🧪 粘'
      h.raw(typed)
      await vi.waitFor(() => expect(side.text).toBe(initial + typed))
      const pasted = ' paste 🦉 café 漢字'
      h.raw('\x1b[200~' + pasted + '\x1b[201~')
      await vi.waitFor(() => expect(side.text).toBe(initial + typed + pasted))
      expect(side.cursor).toBe((initial + typed + pasted).length)
      h.raw('\r')
      await vi.waitFor(() => expect(h.gw.sent('btw.submit')).toEqual([{
        session_id: 's1', text: initial + typed + pasted
      }]))
      expect(h.gw.methods('prompt.submit')).toHaveLength(0)
      expect(h.gw.methods('prompt.btw')).toHaveLength(0)
      expect(main.text).toBe('Unsent main 🦊')
      expect(main.cursor).toBe(4)
      expect(h.app.transcript.entries).toEqual(transcript)
      expect(side.text).toBe(initial + typed + pasted) // rejected backend preserves it
    })
  })
  it('fences held real SDK editor actions on selection ABA, same-ID adoption and replacement', async () => {
    await withNativeApp(async h => {
      const model = h.app.btw
      model.update(thread('a'))
      model.update(thread('b'))
      model.select('a')
      const draftA = model.draft
      draftA.set('Draft A 🦉', { cursor: 3 })
      h.app.changed()
      await painted()
      const surface = h.surface()
      const click = () => surface.dispatch({
        ev: 'action', sf: surface.id, id: EDITOR, act: 'click', raw: {}
      })
      const edit = () => surface.dispatch({
        ev: 'edit', sf: surface.id, id: EDITOR,
        from: 3, to: 3, text: 'X', cursor: 4, len: draftA.text.length, raw: {}
      })
      const send = () => surface.dispatch({
        ev: 'send', sf: surface.id, id: EDITOR, text: 'Not admitted', raw: {}
      })
      const staleClick = click()
      const staleEdit = edit()
      const staleSend = send()
      expect(staleClick).toBeTypeOf('function')
      expect(staleEdit).toBeTypeOf('function')
      expect(staleSend).toBeTypeOf('function')
      const calls = h.gw.sent('btw.submit').length
      model.select('b')
      const draftB = model.draft
      draftB.set('Draft B 🧪', { cursor: 5 })
      model.select('a')
      await painted()
      await staleClick?.()
      await staleEdit?.()
      await staleSend?.()
      expect(model.draft).toBe(draftA)
      expect(draftA.text).toBe('Draft A 🦉')
      expect(draftA.cursor).toBe(3)
      expect(draftB.text).toBe('Draft B 🧪')
      expect(h.gw.sent('btw.submit')).toHaveLength(calls)
      const adoptionClick = click()
      const adoptionSend = send()
      expect(adoptionClick).toBeTypeOf('function')
      given.session(h.app, 's1') // unchanged ID, changed ref identity
      model.adopt('s1')
      await painted()
      await adoptionClick?.()
      await adoptionSend?.()
      expect(draftA.text).toBe('Draft A 🦉')
      expect(h.gw.sent('btw.submit')).toHaveLength(calls)
      const oldClick = click()
      model.close()
      await model.show()
      await painted()
      await oldClick?.()
      expect(model.draft.text).toBe('Draft A 🦉')
      expect(h.gw.sent('btw.submit')).toHaveLength(calls)
      expect(h.gw.methods('prompt.submit')).toHaveLength(0)
    })
  })
})
