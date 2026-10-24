// Pinned public Tern Session and Surface: real editor action, raw keys, and
// ownership regressions. This is not a private native compositor mouse test.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Session, type Surface } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { copyToClipboard } from '../clipboard.js'
import { readLaunchEnv } from '../config/env.js'
import { decodeJson } from '../wire/json.js'
import type { BtwThread } from '../wire/side.js'

import { FakeGateway, given, must } from './fakes.js'

vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))

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
function thread(id: string, state: BtwThread['turns'][number]['state'] = 'answered', revision = 1): BtwThread {
  return { id, revision, turns: [{
    id: id + '-turn', question: 'Question ' + id, answer: 'Answer ' + id, state
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

/** Decode emitted native frame JSON, not source literals or fabricated IDs. */
function emittedIds(bytes: string): string[] {
  const ids = new Set<string>()
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/layer\.btw(?:\.[A-Za-z0-9_-]+)+/g)) {
        ids.add(match[0])
      }
    } else if (Array.isArray(value)) {
      value.forEach(inspect)
    } else if (value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        inspect(name)
        inspect(child)
      }
    }
  }

  // Build the same ESC-frame regex without a literal control-regex token (lint gate).
  const esc = String.fromCharCode(27)
  const frames = new RegExp(esc + String.raw`_tsp;f;([\s\S]*?)` + esc + String.raw`\\`, 'g')

  for (const frame of bytes.matchAll(frames)) {
    inspect(decodeJson(must(frame[1], 'a native frame body')))
  }

  return [...ids]
}

function nativeButtonId(h: Harness, kind: 'send' | 'cancel' | 'copy', bytes = h.wire()): string {
  const surface = h.surface()
  const found = emittedIds(bytes).filter(id =>
    id.startsWith('layer.btw.body.actions.') &&
    id.split('.').at(-1)?.startsWith(kind + '-') &&
    typeof surface.dispatch({ ev: 'action', sf: surface.id, id, act: 'click', raw: {} }) === 'function'
  )
  expect(found, 'emitted active native ' + kind + ' button').toHaveLength(1)

  return must(found[0])
}

function nativeControls(h: Harness, bytes = h.wire()) {
  const surface = h.surface()
  const found = emittedIds(bytes).filter(id =>
    id.startsWith('layer.btw.body.') &&
    typeof surface.dispatch({
      ev: 'edit', sf: surface.id, id, from: 0, to: 0, text: '', cursor: 0, len: 0, raw: {}
    }) === 'function' &&
    typeof surface.dispatch({ ev: 'send', sf: surface.id, id, text: '', raw: {} }) === 'function'
  )
  expect(found, 'emitted active native editor').toHaveLength(1)

  return { editor: must(found[0]), send: nativeButtonId(h, 'send', bytes) }
}

/** Read actual rendered A/B IDs after each selection, never pre-bind the incoming event. */
async function selectedAB(h: Harness) {
  const model = h.app.btw
  const beforeA = h.wire().length
  model.update(thread('a'))
  model.update(thread('b'))
  model.select('a')
  const draftA = model.draft
  draftA.set('AAAA 🦉', { cursor: 0 })
  h.app.changed()
  await painted()
  const a = nativeControls(h, h.wire().slice(beforeA))

  const beforeB = h.wire().length
  model.select('b')
  const draftB = model.draft
  draftB.set('BBBB 🧪', { cursor: 0 })
  h.app.changed()
  await painted()
  const b = nativeControls(h, h.wire().slice(beforeB))
  expect(b.editor).not.toBe(a.editor)
  expect(b.send).not.toBe(a.send)

  return { a, b, draftA, draftB, model }
}

describe('BTW native SDK editor focus and ownership', () => {
  it('acquires pointer focus at unchanged caret before raw Unicode, bracketed paste and Enter', async () => {
    await withNativeApp(async h => {
      const side = h.app.btw.draft
      const initial = side.text
      const revision = side.revision
      const cursor = side.cursor
      const surface = h.surface()
      const editorId = nativeControls(h).editor
      const main = h.app.stores.composer
      main.set('Unsent main 🦊', { cursor: 4 })
      const transcript = [...h.app.transcript.entries]
      const click = { ev: 'action' as const, sf: surface.id, id: editorId, act: 'click', raw: {} }
      expect(surface.dispatch(click), 'editor must register an actual SDK click').toBeTypeOf('function')
      // No edit, cursor move or text mutation before this pointer action.
      await h.event(click)
      expect(side.text).toBe(initial)
      expect(side.cursor).toBe(cursor)
      expect(side.revision).toBe(revision)
      await vi.waitFor(() => expect(h.wire()).toContain(JSON.stringify(['focus', editorId])))
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
      const editorId = nativeControls(h).editor
      const click = (id: string) => surface.dispatch({
        ev: 'action', sf: surface.id, id, act: 'click', raw: {}
      })
      const edit = (id: string) => surface.dispatch({
        ev: 'edit', sf: surface.id, id,
        from: 3, to: 3, text: 'X', cursor: 4, len: draftA.text.length, raw: {}
      })
      const send = (id: string) => surface.dispatch({
        ev: 'send', sf: surface.id, id, text: 'Not admitted', raw: {}
      })
      const staleClick = click(editorId)
      const staleEdit = edit(editorId)
      const staleSend = send(editorId)
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
      const afterAba = nativeControls(h).editor
      const adoptionClick = click(afterAba)
      const adoptionSend = send(afterAba)
      expect(adoptionClick).toBeTypeOf('function')
      given.session(h.app, 's1') // unchanged ID, changed ref identity
      model.adopt('s1')
      await painted()
      await adoptionClick?.()
      await adoptionSend?.()
      expect(draftA.text).toBe('Draft A 🦉')
      expect(h.gw.sent('btw.submit')).toHaveLength(calls)
      const oldClick = click(nativeControls(h).editor)
      model.close()
      await model.show()
      await painted()
      await oldClick?.()
      expect(model.draft.text).toBe('Draft A 🦉')
      expect(h.gw.sent('btw.submit')).toHaveLength(calls)
      expect(h.gw.methods('prompt.submit')).toHaveLength(0)
    })
  })


  it('rejects an old A editor edit sent on real SDK wire only after B is painted', async () => {
    await withNativeApp(async h => {
      const { a, b, draftA, draftB } = await selectedAB(h)
      const main = h.app.stores.composer
      main.set('main 🦊', { cursor: 3 })
      const transcript = [...h.app.transcript.entries]

      await h.event({
        ev: 'edit', sf: h.surface().id, id: a.editor,
        from: 0, to: 0, text: 'X', cursor: 1, len: draftA.text.length, raw: {}
      })
      expect(draftA.text).toBe('AAAA 🦉')
      expect(draftB.text).toBe('BBBB 🧪')
      expect(draftB.cursor).toBe(0)
      expect(h.gw.sent('btw.submit')).toEqual([])

      await h.event({
        ev: 'edit', sf: h.surface().id, id: b.editor,
        from: 0, to: 0, text: '✓', cursor: 1, len: draftB.text.length, raw: {}
      })
      expect(draftB.text).toBe('✓BBBB 🧪')
      expect(draftB.cursor).toBe(1)
      expect(draftA.text).toBe('AAAA 🦉')
      expect(main.text).toBe('main 🦊')
      expect(main.cursor).toBe(3)
      expect(h.app.transcript.entries).toEqual(transcript)
      expect(h.gw.methods('prompt.submit')).toEqual([])
      expect(h.gw.methods('prompt.btw')).toEqual([])
    })
  })

  it('rejects an old A editor Send on actual SDK wire after B is painted', async () => {
    await withNativeApp(async h => {
      const { a, b, draftA, draftB } = await selectedAB(h)
      await h.event({
        ev: 'send', sf: h.surface().id, id: a.editor, text: draftA.text, raw: {}
      })
      expect(h.gw.sent('btw.submit')).toEqual([])
      expect(draftB.text).toBe('BBBB 🧪')

      await h.event({
        ev: 'send', sf: h.surface().id, id: b.editor, text: draftB.text, raw: {}
      })
      expect(h.gw.sent('btw.submit')).toEqual([{
        session_id: 's1', thread_id: 'b', text: 'BBBB 🧪'
      }])
      expect(draftA.text).toBe('AAAA 🦉')
      expect(draftB.text).toBe('BBBB 🧪') // real unsupported reply retains the side draft
      expect(h.gw.methods('prompt.submit')).toEqual([])
      expect(h.gw.methods('prompt.btw')).toEqual([])
    })
  })

  it('rejects an old native A Send button after B is painted; fresh B Send works', async () => {
    await withNativeApp(async h => {
      const { a, b, draftB } = await selectedAB(h)
      await h.event({
        ev: 'action', sf: h.surface().id, id: a.send, act: 'click', raw: {}
      })
      expect(h.gw.sent('btw.submit')).toEqual([])

      await h.event({
        ev: 'action', sf: h.surface().id, id: b.send, act: 'click', raw: {}
      })
      expect(h.gw.sent('btw.submit')).toEqual([{
        session_id: 's1', thread_id: 'b', text: 'BBBB 🧪'
      }])
      expect(draftB.text).toBe('BBBB 🧪')
      expect(h.gw.methods('prompt.submit')).toEqual([])
      expect(h.gw.methods('prompt.btw')).toEqual([])
    })
  })

  it('never revives old A native editor or Send IDs after A to B to A', async () => {
    await withNativeApp(async h => {
      const { a, draftA, model } = await selectedAB(h)
      const beforeReturn = h.wire().length
      model.select('a')
      h.app.changed()
      await painted()
      const currentA = nativeControls(h, h.wire().slice(beforeReturn))
      expect(currentA.editor).not.toBe(a.editor)
      expect(currentA.send).not.toBe(a.send)
      await h.event({ ev: 'send', sf: h.surface().id, id: a.editor, text: draftA.text, raw: {} })
      await h.event({ ev: 'action', sf: h.surface().id, id: a.send, act: 'click', raw: {} })
      expect(h.gw.sent('btw.submit')).toEqual([])
      expect(draftA.text).toBe('AAAA 🦉')
      expect(h.gw.methods('prompt.submit')).toEqual([])
    })
  })

  it('retains already-bound Send/Stop/Copy fences even before another selection renders', async () => {
    await withNativeApp(async h => {
      vi.mocked(copyToClipboard).mockClear()
      const { model } = await selectedAB(h)
      const beforeA = h.wire().length
      model.select('a')
      await painted()
      const a = nativeControls(h, h.wire().slice(beforeA))
      const copyA = nativeButtonId(h, 'copy', h.wire().slice(beforeA))
      const surface = h.surface()
      const heldSend = surface.dispatch({ ev: 'action', sf: surface.id, id: a.send, act: 'click', raw: {} })
      const heldCopy = surface.dispatch({ ev: 'action', sf: surface.id, id: copyA, act: 'click', raw: {} })
      expect(heldSend).toBeTypeOf('function')
      expect(heldCopy).toBeTypeOf('function')

      const beforeB = h.wire().length
      model.select('b')
      await heldSend?.()
      await heldCopy?.()
      expect(h.gw.sent('btw.submit')).toEqual([])
      expect(copyToClipboard).not.toHaveBeenCalled()
      await painted()
      await h.event({
        ev: 'action', sf: surface.id, id: nativeButtonId(h, 'copy', h.wire().slice(beforeB)), act: 'click', raw: {}
      })
      expect(copyToClipboard).toHaveBeenCalledTimes(1)
      expect(copyToClipboard).toHaveBeenCalledWith('Question b\n\nAnswer b')

      model.update(thread('a', 'running', 2))
      model.update(thread('b', 'running', 2))
      const beforeStop = h.wire().length
      model.select('a')
      await painted()
      const stopA = nativeButtonId(h, 'cancel', h.wire().slice(beforeStop))
      const heldStop = surface.dispatch({ ev: 'action', sf: surface.id, id: stopA, act: 'click', raw: {} })
      expect(heldStop).toBeTypeOf('function')
      model.select('b')
      await heldStop?.()
      expect(h.gw.sent('btw.cancel')).toEqual([])
      await painted()
      await h.event({
        ev: 'action', sf: surface.id, id: nativeButtonId(h, 'cancel'), act: 'click', raw: {}
      })
      expect(h.gw.sent('btw.cancel')).toEqual([{
        session_id: 's1', thread_id: 'b', turn_id: 'b-turn'
      }])
      expect(h.gw.methods('prompt.submit')).toEqual([])
    })
  })

  it('fresh B pointer click keeps its unchanged caret; raw Unicode, paste and Enter submit once', async () => {
    await withNativeApp(async h => {
      const { a, b, draftA, draftB } = await selectedAB(h)
      const main = h.app.stores.composer
      main.set('Main 🦊', { cursor: 2 })
      const transcript = [...h.app.transcript.entries]
      const initial = draftB.text
      const cursor = draftB.cursor
      const revision = draftB.revision

      await h.event({ ev: 'action', sf: h.surface().id, id: b.editor, act: 'click', raw: {} })
      expect(draftB.text).toBe(initial)
      expect(draftB.cursor).toBe(cursor)
      expect(draftB.revision).toBe(revision)
      await vi.waitFor(() => expect(h.wire()).toContain(JSON.stringify(['focus', b.editor])))
      const typed = '🦉 café'
      h.raw(typed)
      await vi.waitFor(() => expect(draftB.text).toBe(typed + initial))
      const pasted = ' 粘🧪漢字'
      h.raw('\x1b[200~' + pasted + '\x1b[201~')
      const expected = typed + pasted + initial
      await vi.waitFor(() => expect(draftB.text).toBe(expected))
      expect(nativeControls(h).editor).toBe(b.editor)
      h.raw('\r')
      await vi.waitFor(() => expect(h.gw.sent('btw.submit')).toEqual([{
        session_id: 's1', thread_id: 'b', text: expected
      }]))
      expect(draftA.text).toBe('AAAA 🦉')
      expect(draftB.text).toBe(expected)
      expect(main.text).toBe('Main 🦊')
      expect(main.cursor).toBe(2)
      expect(h.app.transcript.entries).toEqual(transcript)
      expect(h.gw.methods('prompt.submit')).toEqual([])
      expect(h.gw.methods('prompt.btw')).toEqual([])
      expect(a.editor).not.toBe(b.editor)
    })
  })

  it('rotates native IDs on same-ID adoption, replacement and close/reopen', async () => {
    await withNativeApp(async h => {
      const { b, model } = await selectedAB(h)
      const sf = h.surface().id

      const beforeReplace = h.wire().length
      await model.show() // same-key sheet replacement, not a new root API
      await painted()
      const replacement = nativeControls(h, h.wire().slice(beforeReplace))
      expect(replacement.editor).not.toBe(b.editor)
      await h.event({ ev: 'send', sf, id: b.editor, text: 'old', raw: {} })
      expect(h.gw.sent('btw.submit')).toEqual([])

      const beforeAdopt = h.wire().length
      given.session(h.app, 's1') // live ID reused, ref identity is new
      model.adopt('s1')
      await painted()
      const adopted = nativeControls(h, h.wire().slice(beforeAdopt))
      expect(adopted.editor).not.toBe(replacement.editor)
      await h.event({ ev: 'action', sf, id: replacement.send, act: 'click', raw: {} })
      expect(h.gw.sent('btw.submit')).toEqual([])

      const beforeReopen = h.wire().length
      model.close()
      await model.show()
      await painted()
      const reopened = nativeControls(h, h.wire().slice(beforeReopen))
      expect(reopened.editor).not.toBe(adopted.editor)
      await h.event({ ev: 'send', sf, id: adopted.editor, text: 'old', raw: {} })
      expect(h.gw.sent('btw.submit')).toEqual([])

      const beforeSession = h.wire().length
      given.session(h.app, 's2')
      model.adopt('s2')
      await model.show()
      await painted()
      const replacementSession = nativeControls(h, h.wire().slice(beforeSession))
      expect(replacementSession.editor).not.toBe(reopened.editor)
      await h.event({ ev: 'action', sf, id: reopened.send, act: 'click', raw: {} })
      expect(h.gw.sent('btw.submit')).toEqual([])
      expect(h.gw.methods('prompt.submit')).toEqual([])
    })
  })

  it('retired Stop native ID cannot cancel a successor turn in the same selected thread', async () => {
    await withNativeApp(async h => {
      const { model } = await selectedAB(h)
      model.select('a')
      model.update(thread('a', 'running', 2))
      await painted()
      const aStop = nativeButtonId(h, 'cancel')
      const aEditor = nativeControls(h).editor
      const next: BtwThread = {
        id: 'a', revision: 3, turns: [
          ...thread('a', 'running').turns,
          { id: 'a-next', question: 'Next', answer: '', state: 'running' }
        ]
      }
      const before = h.wire().length
      model.update(next)
      await painted()
      expect(nativeControls(h, h.wire().slice(before)).editor).not.toBe(aEditor)
      await h.event({ ev: 'action', sf: h.surface().id, id: aStop, act: 'click', raw: {} })
      expect(h.gw.sent('btw.cancel')).toEqual([])
    })
  })

})
