// Scout repro (not for commit): the figure ask on PR #64.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-scout-'))
process.env.HERMES_HOME = home

const { App } = await import('../app.js')

type Handler = (arg: unknown) => void

function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

function setup() {
  const handlers = new Map<string, Handler>()
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const gw = {
    drain: () => undefined,
    isCanonical: true,
    kill: () => undefined,
    on: (name: string, fn: Handler) => void handlers.set(name, fn),
    request: (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })

      return Promise.resolve({})
    }
  }
  const waiting: ((r: IteratorResult<{ type: 'key'; key: Key }>) => void)[] = []
  let rendered: unknown
  const surface = { closed: false, focus: () => undefined, palette: () => undefined, render: (t: unknown) => void (rendered = t), stylesheet: () => undefined }
  const tern = {
    blob: () => 'blob',
    caps: { cols: 100, features: ['send'] },
    close: async () => undefined,
    open: () => surface,
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<{ type: 'key'; key: Key }>>(resolve => waiting.push(resolve)),
      return: async () => ({ done: true as const, value: undefined })
    })
  }
  const app = new App(tern as never, gw as never, '1.0.0')
  void app.run()
  app.sid = 's1'

  const press = async (k: Key) => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
    waiting.shift()?.({ done: false, value: { key: k, type: 'key' } })
    await settle()
  }
  const type = async (text: string) => {
    for (const ch of text) await press(key(ch, { text: ch }))
  }
  const emit = (name: string, arg: unknown) => handlers.get(name)?.(arg)
  const submitted = () => requests.filter(r => r.method === 'prompt.submit').map(r => String(r.params.text))

  /** Tern's native `send` (Carly, `tern agents send`, the agent pane's first prompt): the composer's onSend. */
  const nativeSend = async (text: string) => {
    app.changed()
    await settle()
    const find = (n: unknown): ((ev: unknown) => void) | undefined => {
      if (!n || typeof n !== 'object') return undefined
      const o = n as { p?: Record<string, unknown>; c?: unknown[]; props?: Record<string, unknown>; children?: unknown[]; handlers?: Record<string, unknown> }
      const fn = o.handlers?.onSend ?? o.p?.onSend ?? o.props?.onSend
      if (typeof fn === 'function') return fn as (ev: unknown) => void
      for (const c of [...(o.c ?? []), ...(o.children ?? []), ...(Array.isArray(n) ? n : []), ...Object.values(o).filter(v => v && typeof v === 'object')]) {
        const hit = find(c)
        if (hit) return hit
      }
      return undefined
    }
    const onSend = find(rendered)
    expect(onSend, 'the composer has an onSend handler').toBeTypeOf('function')
    onSend!({ ev: 'send', id: 'composer', text })
    await settle()
  }

  return { app, emit, nativeSend, press, requests, submitted, type }
}

const brokenBase = 'Here:\n```mermaid\nflowchart LR\n  A[Start --> B\n```'
let broken = ''
beforeEach(() => { broken = `${Math.random()} ${brokenBase}` })
const failing = (figs: readonly { lang: 'mermaid' | 'svg'; n: number; source: string }[]) =>
  Promise.resolve(figs.map(f => ({ ...f, error: 'Unterminated node label', line: 2 })))

describe('PR #64 figure ask', () => {
  it('re-arms for a prompt that arrives through Tern send (Carly / tern agents send)', async () => {
    const { app, emit, nativeSend, press, submitted, type } = setup()
    const check = vi.fn(failing)
    ;(app as unknown as { figureCheck: unknown }).figureCheck = check

    await type('draw it')
    await press(key('enter'))
    emit('event', { payload: { status: 'complete', text: broken }, session_id: 's1', type: 'message.complete' })
    await settle()
    expect(submitted().filter(t => t.startsWith('A figure'))).toHaveLength(1)

    // The fix turn answers, then a new prompt comes in through Tern's send event.
    emit('event', { payload: { status: 'complete', text: 'fixed' }, session_id: 's1', type: 'message.complete' })
    await settle()
    await nativeSend('now draw the other one')
    expect(submitted()).toContain('now draw the other one')
    emit('event', { payload: { status: 'complete', text: broken.replace('Start', 'Other') }, session_id: 's1', type: 'message.complete' })
    await settle()

    console.log('checks run:', check.mock.calls.length, 'asks:', submitted().filter(t => t.startsWith('A figure')).length)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('control: a typed prompt re-arms', async () => {
    const { app, emit, press, submitted, type } = setup()
    const check = vi.fn(failing)
    ;(app as unknown as { figureCheck: unknown }).figureCheck = check
    await type('draw it')
    await press(key('enter'))
    emit('event', { payload: { status: 'complete', text: broken }, session_id: 's1', type: 'message.complete' })
    await settle()
    emit('event', { payload: { status: 'complete', text: 'fixed' }, session_id: 's1', type: 'message.complete' })
    await settle()
    await type('now draw the other one')
    await press(key('enter'))
    emit('event', { payload: { status: 'complete', text: broken.replace('Start', 'Other') }, session_id: 's1', type: 'message.complete' })
    await settle()
    console.log('control:', JSON.stringify(submitted()), 'busy', JSON.stringify(app.busy), 'queue', JSON.stringify((app as unknown as { queue: unknown }).queue))
    expect(check).toHaveBeenCalledTimes(2)
    expect(submitted().filter(t => t.startsWith('A figure'))).toHaveLength(2)
  })

  it('drops a check that settles after the user has sent the next prompt', async () => {
    const { app, emit, press, requests, submitted, type } = setup()
    let release!: () => void
    ;(app as unknown as { figureCheck: unknown }).figureCheck = (figs: Parameters<typeof failing>[0]) =>
      new Promise(resolve => (release = () => void failing(figs).then(resolve)))

    await type('draw it')
    await press(key('enter'))
    emit('event', { payload: { status: 'complete', text: broken }, session_id: 's1', type: 'message.complete' })
    await settle()

    // A first check is slow (uv fetches merman); the user moves on meanwhile.
    await type('thanks, now something else')
    await press(key('enter'))
    expect(submitted()).toContain('thanks, now something else')
    release()
    await settle()
    // The user's new turn finishes; anything queued behind it now goes.
    emit('event', { payload: { status: 'complete', text: 'something else' }, session_id: 's1', type: 'message.complete' })
    await settle()
    console.log('submitted:', JSON.stringify(submitted()), 'queue:', JSON.stringify((app as unknown as { queue: unknown }).queue), JSON.stringify(requests.map(r => [r.method, r.params.text])))
    expect(submitted().filter(t => t.startsWith('A figure'))).toHaveLength(0)
  })
})

describe('scout: Tern send and shell commands', () => {
  it('a sent !cmd or {!cmd}', async () => {
    const { nativeSend, requests } = setup()
    await nativeSend('!echo sent-bang')
    await nativeSend('look at {!echo sent-brace}')
    await settle()
    console.log('SEND-SHELL', JSON.stringify(requests.filter(r => /shell|prompt\.submit/.test(r.method)).map(r => [r.method, r.params.command ?? r.params.text])))
  })
})
