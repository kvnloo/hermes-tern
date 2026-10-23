import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { decodePastedImage, encodedImageBytes, nativePathIsLocal, pastedImageEvent } from '../artifacts/attachments.js'
import { liveSessionId, storedSessionId } from '../core/ids.js'
import { Attachments, type AttachmentsHost, type Image } from '../draft/attachments.js'
import { SessionState } from '../session/state.js'

import { setup } from './appSetup.js'
import { FakeGateway, key } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1
])
const url = 'data:image/png;base64,' + png.toString('base64')
const fixtureDir = mkdtempSync(join(tmpdir(), 'hermes-artifacts-'))
const file = join(fixtureDir, 'native image.png')
writeFileSync(file, png)
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

function largeUrl(mib: number) {
  const bytes = Buffer.alloc(mib * 1024 * 1024)
  png.copy(bytes)
  return 'data:image/png;base64,' + bytes.toString('base64')
}

describe('Tern image-paste payloads', () => {
  it('validates canonical bytes and signatures, sizing before decoding', () => {
    expect(encodedImageBytes(url)).toBe(png.length)
    expect(decodePastedImage(url)).toMatchObject({ bytes: png, mime: 'image/png', ext: '.png' })
    expect(() => decodePastedImage('data:image/jpeg;base64,' + png.toString('base64'))).toThrow('mismatch')
    expect(() => decodePastedImage('data:image/png;base64,AAAA')).toThrow()
    expect(() => decodePastedImage('data:text/html;base64,' + png.toString('base64'))).toThrow()
    expect(() => decodePastedImage('data:image/png;base64,/////')).toThrow()
    expect(() => encodedImageBytes('data:image/png;base64,abc')).toThrow('invalid')
  })

  it('parses native raw.path without coercing it into bytes or taking over text paste', () => {
    expect(pastedImageEvent({ ev: 'drop', raw: { data: url, name: 'chart.png' } }))
      .toEqual({ kind: 'data', data: url, name: 'chart.png' })
    expect(pastedImageEvent({ ev: 'paste', data: png.toString('base64'), mime: 'image/png' }))
      .toEqual({ kind: 'data', data: url, name: 'Pasted image' })
    expect(pastedImageEvent({ ev: 'drop', raw: { path: file, name: 'chart.png' } }))
      .toEqual({ kind: 'path', path: file, name: 'chart.png' })
    expect(pastedImageEvent({ ev: 'paste', raw: { path: 'file://' + file.replace(/ /g, '%20') } }))
      .toEqual({ kind: 'path', path: 'file://' + file.replace(/ /g, '%20'), name: 'Pasted image' })
    expect(pastedImageEvent({ ev: 'paste', data: 'ordinary text' })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'paste', raw: { path: './local.png' } })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'drop', raw: { path: 'file://remote/other.png' } })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'action', data: url })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'drop', raw: { data: url, name: 'bad\nname' } })?.name).toBe('Pasted image')
  })

  it('refuses native paths when gateway attached or Tern reached over SSH', () => {
    expect(nativePathIsLocal({ attached: false }, {})).toBe(true)
    expect(nativePathIsLocal({ attached: true }, {})).toBe(false)
    for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
      expect(nativePathIsLocal({ attached: false }, { [name]: 'remote' })).toBe(false)
    }
  })
})

function host({ sid = 'session-a', stored = 'canonical-a', startup, head }: {
  sid?: string | null
  stored?: string
  startup?: string
  head?: Image[]
} = {}) {
  const gw = new FakeGateway()
  gw.attached = false
  const changed = vi.fn()
  const notes: string[] = []
  const state = new SessionState(changed)
  state.ref = { live: sid === null ? null : liveSessionId(sid), stored: sid === null ? null : storedSessionId(stored) }
  const deps: AttachmentsHost = {
    attachToHead: image => {
      head?.push(image)
      return Boolean(head)
    },
    blob: () => 'blob-1',
    changed,
    cwd: () => fixtureDir,
    gw: gw.client,
    launchCwd: fixtureDir,
    note: text => void notes.push(text),
    owner: () => state.ref
  }
  const a = new Attachments(deps, { ...(startup ? { startup } : {}) })
  const changeSession = (live: string | null, saved = 'canonical-' + live) => {
    state.ref = { live: live === null ? null : liveSessionId(live), stored: live === null ? null : storedSessionId(saved) }
  }
  return { a, changed, changeSession, gw, notes, state }
}

describe('the session-owned image controller', () => {
  it('uploads signed bytes and passes only gateway path/mime, not private owner identity', async () => {
    const s = host()
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/shot.png' }))
    await s.a.fromDataUrl(url, 'shot.png')
    expect(s.gw.sent('image.attach_bytes')).toMatchObject([{
      content_base64: png.toString('base64'), filename: 'image.png', session_id: 'session-a'
    }])
    expect(s.a.chips()).toMatchObject([{ label: 'shot.png', image: { blob: 'blob-1' } }])
    expect(s.a.take()).toEqual([{ mime: 'image/png', name: 'shot.png', path: '/gateway/shot.png', caption: '1×1 · 1 KB', preview: { blob: 'blob-1' } }])
  })

  it('drops an A upload that finishes in B without emitting late UI/error, even for reused sid and A-B-A', async () => {
    const s = host()
    const reply = Promise.withResolvers<{ path: string }>()
    s.gw.handlers.set('image.attach_bytes', () => reply.promise)
    const task = s.a.fromDataUrl(url)
    expect(s.a.uploading).toBe(true)
    const changes = s.changed.mock.calls.length
    s.changeSession('session-b')
    s.changeSession('session-a', 'canonical-a') // same wire/stored identity, different SessionState.ref object
    const switched = s.changed.mock.calls.length
    expect(switched).toBe(changes + 2)
    reply.resolve({ path: '/old/shot.png' })
    await task
    expect(s.a.take()).toEqual([])
    expect(s.a.chips()).toEqual([])
    expect(s.notes).toEqual([])
    expect(s.changed).toHaveBeenCalledTimes(switched)
  })

  it('uses actual App key submission to send B text without A images', async () => {
    delete process.env['HERMES_TUI_QUERY']
    delete process.env['HERMES_TUI_IMAGE']
    const { app, press, sent, type } = setup({
      'prompt.submit': () => ({ admission_id: 'admission-b', status: 'started' })
    })
    await app.stores.attachments.fromDataUrl(url, 'session-A.png')
    const original = app.stores.attachments.take()
    expect(original).toHaveLength(1)
    app.stores.attachments.restore(original)
    app.session.ref = { live: liveSessionId('s2'), stored: storedSessionId('canonical-b') }
    await type('only B')
    await press(key('enter'))
    expect(sent('prompt.submit')).toMatchObject([{ text: 'only B', session_id: 's2', attachments: [] }])
    app.stores.attachments.restore(original)
    expect(app.stores.attachments.items).toEqual([])
  })

  it('keeps already-landed A refs out of B take/send and refuses A restore in B', async () => {
    const s = host()
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/a/file.png' }))
    await s.a.fromDataUrl(url, 'a.png')
    const aTake = s.a.take()
    expect(aTake).toHaveLength(1)

    s.a.restore(aTake)
    expect(s.a.items).toHaveLength(1)
    s.changeSession('session-b')
    expect(s.a.items).toEqual([])
    expect(s.a.take()).toEqual([])
    s.a.restore(aTake)
    expect(s.a.items).toEqual([])

    // Even returning to the same canonical and runtime id is a fresh ref.
    s.changeSession('session-a', 'canonical-a')
    s.a.restore(aTake)
    expect(s.a.items).toEqual([])
  })

  it('honors removed chips, failure and cancellation without misattributing B notices', async () => {
    const s = host()
    const reply = Promise.withResolvers<{ path: string }>()
    s.gw.handlers.set('image.attach_bytes', () => reply.promise)
    const task = s.a.fromDataUrl(url)
    s.a.remove(0)
    s.changeSession('session-b')
    reply.resolve({ path: '/a/removed.png' })
    await task
    expect(s.a.items).toEqual([])
    const fail = Promise.withResolvers<{ path: string }>()
    s.gw.handlers.set('image.attach_bytes', () => fail.promise)
    const next = s.a.fromDataUrl(url)
    s.changeSession('session-c')
    fail.reject(new Error('late failure'))
    await next
    expect(s.notes).toEqual([])
    await s.a.fromDataUrl('data:image/png;base64,YWJj', 'invalid.png')
    expect(s.notes.join(' ')).toContain('Could not attach invalid.png')
  })

  it('keeps the first session startup query and draft image without a fabricated null owner', async () => {
    const head: Image[] = []
    const s = host({ sid: null, head, startup: file })
    expect(s.a.awaitingStartup).toBe(true)
    s.changeSession('first-real-session', 'persisted-first')
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/startup.png' }))
    await s.a.attachStartup('first-real-session')
    expect(head.map(i => i.path)).toEqual(['/gateway/startup.png'])
    expect(s.a.items).toEqual([])
    expect(s.a.awaitingStartup).toBe(false)
    s.a.restore(head)
    expect(s.a.items.map(i => i.path)).toEqual(['/gateway/startup.png'])

    const fresh = host({ sid: null, startup: file })
    fresh.changeSession('first-real-session')
    fresh.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/draft.png' }))
    await fresh.a.attachStartup('first-real-session')
    expect(fresh.a.items.map(i => i.path)).toEqual(['/gateway/draft.png'])
  })

  it('accepts native local path events and rejects paths on an attached/remote host', async () => {
    const s = host()
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/native.png' }))
    await s.a.fromNativePath(file, nativePathIsLocal(s.gw.client, {}))
    expect(s.a.items.map(i => i.path)).toEqual(['/gateway/native.png'])
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(1)

    s.gw.attached = true
    await s.a.fromNativePath(file, nativePathIsLocal(s.gw.client, {}))
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(1)
    s.gw.attached = false
    await s.a.fromNativePath(file, nativePathIsLocal(s.gw.client, { SSH_TTY: '/dev/ttys1' }))
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(1)
    expect(s.notes.join(' ')).toContain('remote Tern or gateway path')
  })

  it('caps eight landed or pending images before a ninth begins', async () => {
    const s = host()
    const replies = Array.from({ length: 8 }, () => Promise.withResolvers<{ path: string }>())
    let next = 0
    s.gw.handlers.set('image.attach_bytes', () => {
      const reply = replies[next++]
      return reply?.promise ?? { path: '/gateway/final.png' }
    })
    const tasks = Array.from({ length: 8 }, (_, n) => s.a.fromDataUrl(url, 'image-' + n))
    expect(s.a.uploading).toBe(true)
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(8)
    await s.a.fromDataUrl(url, 'ninth')
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(8)
    s.a.remove(0) // canceled but unsettled: still a concurrency slot
    await s.a.fromDataUrl(url, 'still-blocked')
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(8)
    replies.forEach((r, n) => r.resolve({ path: '/gateway/' + n + '.png' }))
    await Promise.all(tasks)
    expect(s.a.items).toHaveLength(7)
    await s.a.fromDataUrl(url, 'after-settlement')
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(9)
  })

  it('caps 40 MiB across landed and removed-but-inflight work, releasing on settle', async () => {
    const s = host()
    const sixteen = largeUrl(16)
    const nine = largeUrl(9)
    const reply = Promise.withResolvers<{ path: string }>()
    let uploads = 0
    s.gw.handlers.set('image.attach_bytes', () => ++uploads === 1 ? reply.promise : { path: '/gateway/' + uploads + '.png' })
    const pending = s.a.fromDataUrl(sixteen)
    s.a.remove(0)
    await s.a.fromDataUrl(sixteen)
    await s.a.fromDataUrl(nine)
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(2) // 16 canceled + 16 landed; 9 exceeds 40
    reply.resolve({ path: '/gateway/old.png' })
    await pending
    await s.a.fromDataUrl(nine)
    expect(s.gw.sent('image.attach_bytes')).toHaveLength(3) // 16 + 9 now fits
    expect(s.a.items).toHaveLength(2)
  })

  it('releases failed reservations without weakening the per-image signature guard', async () => {
    const s = host()
    const reject = Promise.withResolvers<{ path: string }>()
    s.gw.handlers.set('image.attach_bytes', () => reject.promise)
    const task = s.a.fromDataUrl(url)
    reject.reject(new Error('gateway offline'))
    await task
    expect(s.a.any).toBe(false)
    expect(s.notes.join(' ')).toContain('gateway offline')
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/after-failure.png' }))
    await s.a.fromDataUrl(url)
    expect(s.a.items).toHaveLength(1)
  })
})
