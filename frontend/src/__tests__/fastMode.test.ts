// Focused fast-mode unit tests on a fake gateway; no app, terminal, or network.
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { fastCommand, fastTier, fastValue, fastWord, setFast, type FastHost } from '../session/fast.js'

import { FakeGateway } from './fakes.js'

function setup() {
  const gw = new FakeGateway()
  const ref: { live: ReturnType<typeof liveSessionId> | null; stored: null } = {
    live: liveSessionId('s1'),
    stored: null
  }
  const session = {
    get ref() {
      return ref
    },
    info: null
  } as unknown as FastHost['session']
  const host: FastHost = {
    changed: vi.fn(),
    gw: gw.client,
    session,
    transcript: { notice: vi.fn() }
  }

  return { gw, host, ref }
}

describe('session/fast', () => {
  it('fastWord accepts the gateway words and defaults unknown values to normal', () => {
    expect(fastWord('fast')).toBe('fast')
    expect(fastWord('ultrafast')).toBe('ultrafast')
    expect(fastWord('normal')).toBe('normal')

    for (const value of [undefined, null, 'priority', 'FAST', 5]) {
      expect(fastWord(value)).toBe('normal')
    }
  })

  it('fastTier_extra ignores missing or disabled fast and defaults a missing tier to fast', () => {
    expect(fastTier(undefined)).toBeUndefined()
    expect(fastTier(null)).toBeUndefined()
    expect(fastTier({ fast: true })).toBe('fast')
    expect(fastTier({ fast: false, service_tier: 'ultrafast' })).toBeUndefined()
  })

  it('fastValue_aliases accepts supported words with trim and case folding', () => {
    expect(fastValue('')).toBe('toggle')
    expect(fastValue('  ON ')).toBe('fast')
    expect(fastValue('off')).toBe('normal')
    expect(fastValue('Normal')).toBe('normal')
    expect(fastValue('toggle')).toBe('toggle')
    expect(fastValue('fast')).toBe('fast')
    expect(fastValue('status')).toBeNull()
    expect(fastValue('warp')).toBeNull()
  })

  it('fastValue_prototypeKeys refuses inherited object keys and shows usage', async () => {
    expect(fastValue('constructor')).toBeNull()
    expect(fastValue('__proto__')).toBeNull()

    const { gw, host } = setup()

    await fastCommand(host, 'constructor')
    await fastCommand(host, '__proto__')

    expect(gw.calls).toEqual([])
    expect(host.transcript.notice).toHaveBeenCalledTimes(2)
    expect(host.transcript.notice).toHaveBeenNthCalledWith(1, 'Usage: /fast [on|off|ultrafast|status]', 'warning')
    expect(host.transcript.notice).toHaveBeenNthCalledWith(2, 'Usage: /fast [on|off|ultrafast|status]', 'warning')
    expect(host.changed).not.toHaveBeenCalled()
  })

  it('setFast_noSession skips the gateway, notice and render', async () => {
    const { gw, host, ref } = setup()
    ref.live = null

    expect(await setFast(host, 'fast')).toBe(false)
    expect(gw.calls).toEqual([])
    expect(host.session.info).toBeNull()
    expect(host.transcript.notice).not.toHaveBeenCalled()
    expect(host.changed).not.toHaveBeenCalled()
  })

  it('setFast_ultrafast patches the same session using the gateway reply', async () => {
    const { gw, host } = setup()
    host.session.info = { model: 'm' }
    gw.handlers.set('config.set', () => ({ key: 'fast', value: 'ultrafast' }))

    expect(await setFast(host, 'toggle')).toBe(true)
    expect(gw.sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'toggle' }])
    expect(host.session.info).toEqual({ model: 'm', fast: true, service_tier: 'ultrafast' })
    expect(host.transcript.notice).toHaveBeenCalledExactlyOnceWith('Ultrafast mode on: priority processing, billed higher.')
    expect(host.changed).toHaveBeenCalledTimes(1)
  })

  it('setFast_fastAndNormal maps fast, normal and absent reply values', async () => {
    const { gw, host } = setup()
    host.session.info = { model: 'm' }
    gw.handlers.set('config.set', () => ({ value: 'fast' }))

    expect(await setFast(host, 'fast')).toBe(true)
    expect(host.session.info).toEqual({ model: 'm', fast: true, service_tier: 'priority' })
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode on: priority processing, billed higher.')

    gw.handlers.set('config.set', () => ({ value: 'normal' }))
    expect(await setFast(host, 'normal')).toBe(true)
    expect(host.session.info).toEqual({ model: 'm', fast: false, service_tier: '' })
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode off.')

    gw.handlers.set('config.set', () => ({}))
    expect(await setFast(host, 'toggle')).toBe(true)
    expect(host.session.info).toEqual({ model: 'm', fast: false, service_tier: '' })
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode off.')
    expect(gw.sent('config.set')).toEqual([
      { key: 'fast', session_id: 's1', value: 'fast' },
      { key: 'fast', session_id: 's1', value: 'normal' },
      { key: 'fast', session_id: 's1', value: 'toggle' }
    ])
    expect(host.transcript.notice).toHaveBeenCalledTimes(3)
    expect(host.changed).toHaveBeenCalledTimes(3)
  })

  it('setFast_sessionSwitched preserves the new session info while notifying', async () => {
    const { gw, host, ref } = setup()
    gw.handlers.set('config.set', () => {
      ref.live = liveSessionId('s2')

      return { value: 'fast' }
    })

    expect(await setFast(host, 'fast')).toBe(true)
    expect(gw.sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'fast' }])
    expect(ref.live).toBe('s2')
    expect(host.session.info).toBeNull()
    expect(host.transcript.notice).toHaveBeenCalledExactlyOnceWith('Fast mode on: priority processing, billed higher.')
    expect(host.changed).toHaveBeenCalledTimes(1)
  })

  it('setFast_unavailable reports a route limitation without changing info', async () => {
    const { gw, host } = setup()
    host.session.info = { model: 'm' }
    gw.handlers.set('config.set', () => {
      throw new Error('fast_unavailable: route')
    })

    expect(await setFast(host, 'fast')).toBe(false)
    expect(gw.sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'fast' }])
    expect(host.session.info).toEqual({ model: 'm' })
    expect(host.transcript.notice).toHaveBeenCalledExactlyOnceWith('This model has no fast mode on its current route.', 'warning')
    expect(host.changed).toHaveBeenCalledTimes(1)
  })

  it('setFast_otherError reports the actual error without changing info', async () => {
    const { gw, host } = setup()
    host.session.info = { model: 'm' }
    gw.handlers.set('config.set', () => {
      throw new Error('boom')
    })

    expect(await setFast(host, 'normal')).toBe(false)
    expect(gw.sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'normal' }])
    expect(host.session.info).toEqual({ model: 'm' })
    expect(host.transcript.notice).toHaveBeenCalledExactlyOnceWith('Could not set fast mode: boom', 'warning')
    expect(host.changed).toHaveBeenCalledTimes(1)
  })

  it('fastCommand_status reads the live or null session and handles empty replies', async () => {
    const { gw, host, ref } = setup()
    gw.handlers.set('config.get', () => ({ value: 'ultrafast' }))

    await fastCommand(host, ' STATUS ')
    expect(gw.sent('config.get')).toEqual([{ key: 'fast', session_id: 's1' }])
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode: ultrafast.')

    ref.live = null
    await fastCommand(host, 'status')
    expect(gw.sent('config.get')).toEqual([
      { key: 'fast', session_id: 's1' },
      { key: 'fast', session_id: null }
    ])
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode: ultrafast.')

    gw.handlers.set('config.get', () => ({}))
    await fastCommand(host, 'status')
    expect(gw.sent('config.get')).toEqual([
      { key: 'fast', session_id: 's1' },
      { key: 'fast', session_id: null },
      { key: 'fast', session_id: null }
    ])
    expect(host.transcript.notice).toHaveBeenLastCalledWith('Fast mode: normal.')
    expect(host.transcript.notice).toHaveBeenCalledTimes(3)
    expect(gw.sent('config.set')).toEqual([])
    expect(host.changed).not.toHaveBeenCalled()
  })

  it('fastCommand_statusRejects propagates a failed get (no status catch)', async () => {
    const { gw, host } = setup()
    gw.handlers.set('config.get', () => {
      throw new Error('x')
    })

    await expect(fastCommand(host, 'status')).rejects.toThrow('x')
    expect(gw.sent('config.get')).toEqual([{ key: 'fast', session_id: 's1' }])
    expect(gw.sent('config.set')).toEqual([])
    expect(host.transcript.notice).not.toHaveBeenCalled()
    expect(host.changed).not.toHaveBeenCalled()
  })

  it('fastCommand_usage warns on unknown words and sends on/off aliases', async () => {
    const { gw, host } = setup()

    await fastCommand(host, 'warp')
    expect(host.transcript.notice).toHaveBeenCalledWith('Usage: /fast [on|off|ultrafast|status]', 'warning')
    expect(gw.calls).toEqual([])
    expect(host.changed).not.toHaveBeenCalled()

    gw.handlers.set('config.set', params => ({ value: params['value'] }))
    await fastCommand(host, 'on')
    await fastCommand(host, 'off')

    expect(gw.sent('config.set')).toEqual([
      { key: 'fast', session_id: 's1', value: 'fast' },
      { key: 'fast', session_id: 's1', value: 'normal' }
    ])
    expect(gw.sent('config.get')).toEqual([])
    expect(host.transcript.notice).toHaveBeenNthCalledWith(2, 'Fast mode on: priority processing, billed higher.')
    expect(host.transcript.notice).toHaveBeenNthCalledWith(3, 'Fast mode off.')
    expect(host.changed).toHaveBeenCalledTimes(2)
  })
})
