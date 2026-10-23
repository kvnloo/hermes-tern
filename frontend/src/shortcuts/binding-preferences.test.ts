import type { SettingsGetResult } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import { FakeGateway, key } from '../__tests__/fakes.js'

import { APP_SHORTCUTS } from './actions.js'
import { BindingPreferences } from './binding-preferences.js'

function profile(name: string, bindings: unknown = {}, identity = false): SettingsGetResult {
  return {
    profile: name,
    fields: {
      'display.tern_keybindings': { category: 'display', default: {}, description: 'App chords', type: 'object', value: bindings },
      'display.tern_profile_identity': { category: 'display', default: false, description: 'Profile identity', type: 'boolean', value: identity }
    }
  }
}

function fixture(initial: SettingsGetResult = profile('work')) {
  let sid: string | null = 's1'
  let stored = initial
  const gw = new FakeGateway({ replies: { 'settings.get': () => stored } })
  const notice = vi.fn()
  const changed = vi.fn()
  const prefs = new BindingPreferences({ gw: gw.client, sid: () => sid, changed, notice })

  return {
    gw, prefs, notice, changed,
    get sid() { return sid },
    set sid(value: string | null) { sid = value },
    set stored(value: SettingsGetResult) { stored = value }
  }
}

describe('owning-session binding preferences', () => {
  it('loads and resets from the correct owning gateway, including explicit profile identity', async () => {
    const f = fixture(profile('work', { 'app.help': 'alt+k' }, true))
    expect(f.prefs.profile).toBe('')
    await f.prefs.refresh()
    expect(f.gw.sent('settings.get')).toEqual([{ session_id: 's1' }])
    expect(f.prefs.profile).toBe('work')
    expect(f.prefs.matches('app.help', key('k', { alt: true }))).toBe(true)
    expect(f.prefs.matches('app.help', key('f1'))).toBe(false)

    f.stored = profile('work', { 'app.help': null }, false)
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('f1'))).toBe(true)
    expect(f.prefs.profile).toBe('')
    expect(f.changed).toHaveBeenCalled()
  })

  it('rejects invalid maps as a transaction while preserving last valid same-session bindings', async () => {
    const f = fixture(profile('work', { 'app.help': 'alt+k' }))
    await f.prefs.refresh()
    f.stored = profile('work', { 'app.help': 'alt+a' })
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('k', { alt: true }))).toBe(true)
    expect(f.prefs.matches('app.help', key('a', { alt: true }))).toBe(false)
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Overlapping chord'))
    f.sid = 's2'
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.prefs.profile).toBe('')
  })

  it('discards late reads after session replacement or a confirmed readback', async () => {
    const f = fixture()
    const first = Promise.withResolvers<SettingsGetResult>()
    f.gw.handlers.set('settings.get', () => first.promise)
    const pending = f.prefs.refresh()
    f.sid = 's2'
    f.prefs.accept(profile('personal', { 'app.help': 'alt+k' }, true), 's2')
    first.resolve(profile('work', { 'app.help': [] }, true))
    await pending
    expect(f.prefs.profile).toBe('personal')
    expect(f.prefs.matches('app.help', key('k', { alt: true }))).toBe(true)

    const later = Promise.withResolvers<SettingsGetResult>()
    f.gw.handlers.set('settings.get', () => later.promise)
    const reading = f.prefs.refresh()
    f.prefs.accept(profile('personal', { 'app.help': [] }), 's2')
    later.resolve(profile('personal', { 'app.help': 'alt+k' }))
    await reading
    expect(f.prefs.matches('app.help', key('k', { alt: true }))).toBe(false)
  })

  it('keeps defaults when the gateway does not support settings.get', async () => {
    const f = fixture()
    f.gw.handlers.set('settings.get', () => { throw new Error('Method not found') })
    await f.prefs.refresh()
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Method not found'))
  })
})
