import type { ConfigGetResult } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import { FakeGateway, key } from '../../__tests__/fakes.js'

import { APP_SHORTCUTS } from '../actions.js'
import { BindingPreferences } from '../binding-preferences.js'

/** Pinned tui_gateway/methods_config.py: config.get key=full/profile. */
function full(bindings: unknown = {}, exposed = false): ConfigGetResult {
  return { config: { display: { tern_keybindings: bindings, tern_profile_identity: exposed } } }
}

function profile(name: string): ConfigGetResult {
  return { home: '/hermes/profiles/work', display: name }
}

function fixture(initial: ConfigGetResult = full(), identity = profile('Work')) {
  let sid: string | null = 's1'
  let stored = initial
  let shown = identity
  const gw = new FakeGateway({ replies: { 'config.get': p => p['key'] === 'profile' ? shown : stored } })
  const notice = vi.fn()
  const changed = vi.fn()
  const prefs = new BindingPreferences({ gw: gw.client, sid: () => sid, changed, notice })

  return {
    gw, prefs, notice, changed,
    get sid() { return sid },
    set sid(value: string | null) { sid = value },
    set stored(value: ConfigGetResult) { stored = value },
    set identity(value: ConfigGetResult) { shown = value }
  }
}

describe('owning-session binding preferences on pinned config.get', () => {
  it('reads full and opted-in profile identity from the exact session owner', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    expect(f.prefs.profile).toBe('')
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toEqual([
      { key: 'full', session_id: 's1' },
      { key: 'profile', session_id: 's1' }
    ])
    expect(f.prefs.profile).toBe('Work')
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
    expect(f.prefs.matches('app.help', key('f1'))).toBe(false)

    f.stored = full({ 'app.help': null }, false)
    await f.prefs.refresh()
    expect(f.gw.sent('config.get').at(-1)).toEqual({ key: 'full', session_id: 's1' })
    expect(f.prefs.matches('app.help', key('f1'))).toBe(true)
    expect(f.prefs.profile).toBe('')
    expect(f.changed).toHaveBeenCalled()
  })

  it('rejects invalid, overlapping, host-reserved and editor-owned maps atomically', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }))
    await f.prefs.refresh()

    for (const bindings of [
      { 'app.help': 'alt+a' },
      { 'app.help': 'ctrl+shift+c' },
      { 'app.help': 'ctrl+shift+p' },
      { 'app.help': 'ctrl+shift+k' },
      { 'app.help': 'enter' },
      { 'app.help': 'space' },
      { 'app.help': 'ctrl+ctrl+k' },
      { 'app.help': 7 },
      null,
      { 'app.help': 'alt+y', 'unknown.action': 'alt+h' }
    ]) {
      f.stored = full(bindings)
      await f.prefs.refresh()
      expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
      expect(f.prefs.matches('app.help', key('f1'))).toBe(false)
    }

    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Overlapping chord'))
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Host-reserved'))
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Composer-owned'))
    f.sid = 's2'
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.prefs.profile).toBe('')
    f.stored = full({ 'app.help': 'alt+y' })
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('y', { alt: true }))).toBe(true)
  })

  it('discards late full reads after session replacement and after direct accepted readback', async () => {
    const f = fixture()
    const first = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'full' ? first.promise : profile('Work'))
    const pending = f.prefs.refresh()
    f.sid = 's2'
    expect(f.prefs.accept(full({ 'app.help': 'alt+h' }, true), 's2', profile('Personal'))).toBe(true)
    first.resolve(full({ 'app.help': [] }, true))
    await pending
    expect(f.prefs.profile).toBe('Personal')
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)

    const later = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'full' ? later.promise : profile('Personal'))
    const reading = f.prefs.refresh()
    f.prefs.accept(full({ 'app.help': [] }), 's2')
    later.resolve(full({ 'app.help': 'alt+h' }))
    await reading
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(false)
  })

  it('does not apply an old profile lookup to the replacement session', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    const pendingIdentity = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'profile' ? pendingIdentity.promise : full({ 'app.help': 'alt+h' }, true))
    const pending = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toContainEqual({ key: 'profile', session_id: 's1' }))
    f.sid = 's2'
    f.prefs.accept(full({ 'app.help': 'alt+y' }, true), 's2', profile('New owner'))
    pendingIdentity.resolve(profile('Old owner'))
    await pending
    expect(f.prefs.profile).toBe('New owner')
    expect(f.prefs.matches('app.help', key('y', { alt: true }))).toBe(true)
  })

  it('retains bindings when optional profile identity cannot be fetched', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    f.gw.handlers.set('config.get', p => {
      if (p['key'] === 'profile') throw new Error('Profile lookup unavailable')
      return full({ 'app.help': 'alt+h' }, true)
    })
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
    expect(f.prefs.profile).toBe('')
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Profile lookup unavailable'))
  })

  it('preserves built-in shortcuts if the supported config.get full call fails', async () => {
    const f = fixture()
    f.gw.handlers.set('config.get', () => { throw new Error('Method not found') })
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toEqual([{ key: 'full', session_id: 's1' }])
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Method not found'))
  })
})
