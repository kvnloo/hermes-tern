import { describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { VimPreference, type VimPreferenceHost } from '../draft/vim-preference.js'

import { stub } from './fakes.js'

function pref(initial?: unknown) {
  const composer = new Composer()
  let sid: string | null = 'sid-1'
  let value: unknown = initial
  const changed = vi.fn()
  const request = vi.fn(async () => ({ config: { display: { vim_mode: value } } }))
  const host = stub<VimPreferenceHost>({ gw: { request }, composer, sid: () => sid, changed })
  const preference = new VimPreference(host)
  return { changed, composer, preference, request, setSid: (next: string | null) => { sid = next }, setValue: (next: unknown) => { value = next } }
}

describe('Vim profile preference', () => {
  it.each([false, undefined, null, 'true', 'false', 1])('defaults off unless canonical value is true (%s)', async value => {
    const h = pref(value)
    await h.preference.refresh()
    expect(h.request).toHaveBeenCalledWith('config.get', { key: 'full', session_id: 'sid-1' })
    expect(h.composer.vim.enabled).toBe(false)
  })

  it('keeps Vim off when the fixture omits the config value altogether', async () => {
    const h = pref()
    await h.preference.refresh()
    expect(h.composer.vim.enabled).toBe(false)
    expect(h.request).toHaveBeenCalledWith('config.get', { key: 'full', session_id: 'sid-1' })
  })

  it('enables from canonical config, without changing the draft or writing a secondary setting', async () => {
    const h = pref(true)
    h.composer.set('keep this', { cursor: 3 })
    await h.preference.refresh()
    expect(h.composer.vim.enabled).toBe(true)
    expect(h.composer.text).toBe('keep this')
    expect(h.composer.cursor).toBe(3)
    h.setValue(false)
    await h.preference.refresh()
    expect(h.composer.vim.enabled).toBe(false)
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('discards session-stale and out-of-order readbacks, including ABA session changes', async () => {
    const h = pref(false)
    await h.preference.refresh()
    const first = Promise.withResolvers<{ config: { display: { vim_mode: unknown } } }>()
    h.request.mockImplementationOnce(() => first.promise)
    const pending = h.preference.refresh()
    h.setSid('sid-2')
    h.setValue(true)
    await h.preference.refresh()
    first.resolve({ config: { display: { vim_mode: false } } })
    await pending
    expect(h.composer.vim.enabled).toBe(true)
    h.setSid(null)
    await h.preference.refresh()
    expect(h.composer.vim.enabled).toBe(false)
  })

  it('preserves a draft and fails disabled on a new session if readback fails', async () => {
    const h = pref(true)
    await h.preference.refresh()
    h.composer.set('draft')
    h.setSid('sid-2')
    h.request.mockRejectedValueOnce(new Error('no gateway'))
    await h.preference.refresh()
    expect(h.composer.vim.enabled).toBe(false)
    expect(h.composer.text).toBe('draft')
  })
})
