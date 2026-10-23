import { afterEach, describe, expect, it, vi } from 'vitest'

import { busy, settle, setup } from './appSetup.js'
import { given, key } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
afterEach(() => vi.useRealTimers())

const altEnter = key('enter', { alt: true })
const requestHandlers = {
  'session.resume': () => ({ execution_generation: 7 })
}

describe('explicit busy input over the existing queue', () => {
  it('keeps plain Enter as queue and Alt+Enter as a live correction', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'queued' }) })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()

    await f.type('next task')
    await f.press(key('enter'))
    expect(f.sent('prompt.submit')[0]).toMatchObject({ queued: true, text: 'next task' })
    expect(f.sent('session.steer')).toEqual([])

    await f.type('use the smaller scope')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('session.steer')[0]).toMatchObject({ execution_generation: 7, session_id: 's1', text: 'use the smaller scope' })
    expect(f.app.stores.composer.text).toBe('')
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'use the smaller scope' }))
  })

  it('reverses busy Enter and Alt+Enter when the user selects steer mode', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'queued' }) })
    f.app.session.busyMode = 'steer'
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()

    await f.type('fix this')
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('prompt.submit')).toEqual([])

    await f.type('run next')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('prompt.submit')).toHaveLength(1))
    expect(f.sent('prompt.submit')[0]).toMatchObject({ queued: true, text: 'run next' })
    expect(f.sent('session.steer')).toHaveLength(1)
  })

  it('retains refused correction verbatim, including its caret', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'rejected' }) })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('keep this draft', { cursor: 4 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    await settle()

    expect(f.app.stores.composer.text).toBe('keep this draft')
    expect(f.app.stores.composer.cursor).toBe(4)
    expect(f.sent('prompt.submit')).toEqual([])
    expect(f.app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('rejected') })
  })

  it('coalesces repeat corrections and does not erase a newer draft on late success', async () => {
    const response = Promise.withResolvers<{ status: string }>()
    const f = setup({ ...requestHandlers, 'session.steer': () => response.promise })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('old draft', { cursor: 3 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    await f.press(altEnter)
    f.app.stores.composer.set('new draft', { cursor: 2 })
    response.resolve({ status: 'queued' })
    await settle()

    expect(f.sent('session.steer')).toHaveLength(1)
    expect(f.app.stores.composer.text).toBe('new draft')
    expect(f.app.stores.composer.cursor).toBe(2)
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'old draft' }))
  })

  it('drops stale confirmation when a new session takes the pane', async () => {
    const response = Promise.withResolvers<{ status: string }>()
    const f = setup({ ...requestHandlers, 'session.steer': () => response.promise })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('old correction')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))

    given.session(f.app.stores, 's2')
    f.app.transcript.reset({ session: 'other', usage: undefined })
    f.app.stores.composer.set('new session draft')
    response.resolve({ status: 'queued' })
    await settle()

    expect(f.app.stores.composer.text).toBe('new session draft')
    expect(f.app.transcript.entries.some(e => e.kind === 'turn')).toBe(false)
  })
})
