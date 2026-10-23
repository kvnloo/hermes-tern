import { describe, expect, it, vi } from 'vitest'

import { decodePastedImage, pastedImageEvent } from '../artifacts/attachments.js'
import { Attachments, type AttachmentsHost } from '../draft/attachments.js'

import { FakeGateway } from './fakes.js'

const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1
])
const url = 'data:image/png;base64,' + png.toString('base64')

describe('Tern image-paste payloads', () => {
  it('accepts the bounded, correctly signed image and refuses spoofed or invalid bytes', () => {
    expect(decodePastedImage(url)).toMatchObject({ bytes: png, mime: 'image/png', ext: '.png' })
    expect(() => decodePastedImage('data:image/jpeg;base64,' + png.toString('base64'))).toThrow('mismatch')
    expect(() => decodePastedImage('data:image/png;base64,AAAA')).toThrow()
    expect(() => decodePastedImage('data:text/html;base64,' + png.toString('base64'))).toThrow()
    expect(() => decodePastedImage('data:image/png;base64,/////')).toThrow()
  })

  it('reads only native image drop/paste events, preserving text paste', () => {
    expect(pastedImageEvent({ ev: 'drop', raw: { data: url, name: 'chart.png' } }))
      .toEqual({ data: url, name: 'chart.png' })
    expect(pastedImageEvent({ ev: 'paste', data: png.toString('base64'), mime: 'image/png' }))
      .toEqual({ data: url, name: 'Pasted image' })
    expect(pastedImageEvent({ ev: 'paste', data: 'ordinary text' })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'action', data: url })).toBeUndefined()
    expect(pastedImageEvent({ ev: 'drop', raw: { data: url, name: 'bad\nname' } })?.name).toBe('Pasted image')
  })
})

function host() {
  const gw = new FakeGateway()
  const changed = vi.fn()
  const notes: string[] = []
  let sid = 'session-a'
  const deps: AttachmentsHost = {
    attachToHead: () => false,
    blob: () => 'blob-1',
    changed,
    cwd: () => '/repo',
    gw: gw.client,
    launchCwd: '/repo',
    note: text => void notes.push(text),
    sid: () => sid
  }

  return { a: new Attachments(deps), changed, gw, notes, changeSession: (value: string) => void (sid = value) }
}

describe('the gateway-owned uploaded paste', () => {
  it('uploads its bytes to image.attach_bytes, shows one chip, then sends the gateway path', async () => {
    const s = host()
    s.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/shot.png' }))

    await s.a.fromDataUrl(url, 'shot.png')

    expect(s.gw.methods('image.attach_bytes')).toHaveLength(1)
    expect(s.gw.sent('image.attach_bytes')[0]).toMatchObject({
      content_base64: png.toString('base64'), filename: 'image.png', session_id: 'session-a'
    })
    expect(s.a.chips()).toMatchObject([{ label: 'shot.png', image: { blob: 'blob-1' } }])
    expect(s.a.take()).toMatchObject([{ mime: 'image/png', name: 'shot.png', path: '/gateway/shot.png' }])
  })

  it('honors a removed pending chip and a session switch before a delayed upload returns', async () => {
    const s = host()
    const reply = Promise.withResolvers<{ path: string }>()
    s.gw.handlers.set('image.attach_bytes', () => reply.promise)
    const task = s.a.fromDataUrl(url)
    expect(s.a.chips()).toMatchObject([{ pending: true }])
    s.a.remove(0)
    s.changeSession('session-b')
    reply.resolve({ path: '/old/shot.png' })
    await task

    expect(s.a.chips()).toEqual([])
    expect(s.a.take()).toEqual([])
  })

  it('keeps a failed paste out of the sent prompt, reporting the error', async () => {
    const s = host()
    await s.a.fromDataUrl('data:image/png;base64,YWJj', 'bad.png')
    expect(s.a.chips()).toEqual([])
    expect(s.gw.methods('image.attach_bytes')).toEqual([])
    expect(s.notes.join(' ')).toContain('Could not attach bad.png')
  })
})
