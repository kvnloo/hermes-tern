import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dockModel } from '../view/dockModel.js'

import { settle, setup } from './appSetup.js'
import { given, key } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})

const toggle = key('v', { alt: true, shift: true })

describe('live voice and consent lifecycle', () => {
  it('a shortcut opens a disclosure, never audio; consent blocks send without clearing draft', async () => {
    const { app, press, sent } = setup()
    app.stores.composer.set('keep this draft')
    expect(app.liveVoice.blocked).toBe(false)
    await press(toggle)
    expect(app.liveVoice.phase).toBe('consent')
    expect(sent('voice.live.start')).toHaveLength(0)
    expect(dockModel(app.stores, 0).composer.ready).toBe(false)
    await press(key('enter'))
    expect(app.stores.composer.text).toBe('keep this draft')
    expect(sent('prompt.submit')).toHaveLength(0)
    await press(key('c', { ctrl: true }))
    expect(app.liveVoice.blocked).toBe(false)
    expect(app.stores.composer.text).toBe('keep this draft')
    expect(sent('voice.live.start')).toHaveLength(0)
  })

  it('starts exactly one lease after Allow; audio cannot send the typed draft', async () => {
    const { app, press, sent } = setup()
    app.stores.composer.set('unsent')
    app.liveVoice.start()
    expect(sent('voice.live.start')).toHaveLength(0)
    await press(toggle)
    app.liveVoice.start()
    app.liveVoice.start()
    await settle()
    expect(sent('voice.live.start')).toHaveLength(1)
    const start = sent('voice.live.start')[0]
    expect(start).toMatchObject({ session_id: 's1', consent: true })
    expect(start?.['live_id']).toEqual(expect.any(String))
    await press(key('enter'))
    expect(sent('prompt.submit')).toHaveLength(0)
    expect(app.stores.composer.text).toBe('unsent')
    expect(dockModel(app.stores, 0).composer.ready).toBe(false)
  })

  it('Escape during start queues Stop behind its acknowledgement; only exact idle releases Send', async () => {
    const gate = Promise.withResolvers<object>()
    const { app, emit, press, sent } = setup({ 'voice.live.start': () => gate.promise })
    await press(toggle)
    app.liveVoice.start()
    await press(key('escape'))
    expect(sent('voice.live.control')).toHaveLength(0)
    const liveId = sent('voice.live.start')[0]?.['live_id']
    gate.resolve({})
    await settle()
    expect(sent('voice.live.control')).toMatchObject([
      { session_id: 's1', live_id: liveId, action: 'stop' }
    ])
    expect(app.liveVoice.blocked).toBe(true)
    emit('event', { type: 'voice.live', session_id: 's1', payload: { live_id: 'not-ours', phase: 'idle' } })
    await settle()
    expect(app.liveVoice.blocked).toBe(true)
    emit('event', { type: 'voice.live', session_id: 's1', payload: { live_id: liveId, phase: 'idle' } })
    await settle()
    expect(app.liveVoice.blocked).toBe(false)
    expect(dockModel(app.stores, 0).composer.ready).toBe(true)
  })

  it('mute/unmute and interrupt are strictly per-lease; hints never duplicate normal messages', async () => {
    const { app, emit, press, sent } = setup()
    await press(toggle)
    app.liveVoice.start()
    await settle()
    const liveId = sent('voice.live.start')[0]?.['live_id']
    await app.liveVoice.control('mute')
    await app.liveVoice.control('mute')
    await app.liveVoice.control('interrupt')
    expect(sent('voice.live.control')).toMatchObject([
      { session_id: 's1', live_id: liveId, action: 'mute', muted: true },
      { session_id: 's1', live_id: liveId, action: 'mute', muted: false },
      { session_id: 's1', live_id: liveId, action: 'interrupt' }
    ])
    emit('event', { type: 'voice.live', session_id: 's2', payload: { live_id: liveId, phase: 'speaking', assistant_text: 'foreign' } })
    await settle()
    expect(app.liveVoice.assistant).toBe('')
    const before = app.transcript.entries.length
    emit('event', { type: 'voice.live', session_id: 's1', payload: {
      live_id: liveId, phase: 'speaking', assistant_text: 'spoken response', user_text: 'spoken user'
    } })
    await settle()
    expect(app.liveVoice.assistant).toBe('spoken response')
    expect(app.transcript.entries).toHaveLength(before)
  })

  it('new session identity retires old lease without moving it to the next owner', async () => {
    const { app, emit, press, sent } = setup()
    await press(toggle)
    app.liveVoice.start()
    await settle()
    const liveId = sent('voice.live.start')[0]?.['live_id']
    given.session(app.stores, 's2')
    await settle()
    expect(sent('voice.live.control').at(-1)).toMatchObject({
      session_id: 's1', live_id: liveId, action: 'stop'
    })
    expect(app.liveVoice.blocked).toBe(true)
    emit('event', { type: 'voice.live', session_id: 's1', payload: { live_id: liveId, phase: 'idle' } })
    await settle()
    expect(app.liveVoice.blocked).toBe(false)
    expect(app.liveVoice.phase).toBe('idle')
    expect(sent('voice.live.start')).toHaveLength(1)
  })

  it('permission failure and failed stop remain visible, and never retry automatically', async () => {
    const { app, press, sent } = setup({
      'voice.live.start': () => { throw new Error('Microphone permission denied') }
    })
    await press(toggle)
    app.liveVoice.start()
    await settle()
    expect(app.liveVoice.phase).toBe('error')
    expect(app.liveVoice.blocked).toBe(false)
    expect(app.liveVoice.error).toContain('permission denied')
    expect(sent('voice.live.start')).toHaveLength(1)

    const other = setup({ 'voice.live.control': () => { throw new Error('Audio release failed') } })
    await other.press(toggle)
    other.app.liveVoice.start()
    await settle()
    await other.app.liveVoice.control('stop')
    expect(other.app.liveVoice.blocked).toBe(true)
    expect(other.app.liveVoice.error).toContain('Audio release failed')
  })

  it('backend exit revokes local consent/lease; late voice hints are not adopted', async () => {
    const { app, emit, press, sent } = setup()
    await press(toggle)
    app.liveVoice.start()
    await settle()
    const liveId = sent('voice.live.start')[0]?.['live_id']
    emit('exit', 1)
    await settle()
    expect(app.liveVoice.blocked).toBe(false)
    emit('event', { type: 'voice.live', session_id: 's1', payload: { live_id: liveId, phase: 'listening' } })
    await settle()
    expect(app.liveVoice.phase).toBe('idle')
  })
})
