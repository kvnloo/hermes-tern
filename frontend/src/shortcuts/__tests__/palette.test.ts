import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Overlay } from '../../overlays/overlay.js'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../../core/ids.js'
import { Composer } from '../../draft/composer.js'
import { SessionState } from '../../session/state.js'
import { Transcript } from '../../transcript/store.js'
import { FakeGateway, key } from '../../__tests__/fakes.js'

import { openCommandPalette, paletteRows, type PaletteHost } from '../palette.js'

function fixture(catalog: CommandsCatalogResult = { categories: [{ name: 'Fixture', pairs: [['/zzfixture', 'Fixture command']] }] }) {
  const gw = new FakeGateway({ replies: { 'commands.catalog': () => catalog } })
  const session = new SessionState(() => {})
  session.ref = { live: liveSessionId('s1'), stored: null }
  const overlays: Overlay[] = []
  const composer = new Composer()
  const transcript = new Transcript()
  const set = vi.spyOn(composer, 'set')
  const run = vi.fn()
  const changed = vi.fn()
  const notice = vi.spyOn(transcript, 'notice')
  const host: PaletteHost = {
    gw: gw.client, session, composer, run, changed,
    transcript,
    close: (overlay: Overlay) => void overlays.splice(overlays.indexOf(overlay), 1),
    open: (overlay: Overlay) => void overlays.push(overlay)
  }

  return { gw, session, host, composer, overlays, set, run, changed, notice }
}

function top(overlays: readonly Overlay[]): Overlay {
  const overlay = overlays[0]

  if (!overlay) {
    throw new Error('Expected command palette')
  }

  return overlay
}

const type = (overlay: Overlay, text: string) => {
  for (const ch of text) {
    overlay.onKey(key(ch, { text: ch }))
  }
}

describe('Tern native command palette', () => {
  it('deduplicates frontend and gateway catalog rows and omits hidden commands', () => {
    const rows = paletteRows({
      categories: [{ name: 'Fixture', pairs: [
        ['/palette', 'Duplicate local'],
        ['/zzfixture', 'Fixture command'],
        ['/mouse', 'Hidden']
      ] }]
    })
    expect(rows.filter(row => row.id === '/palette')).toHaveLength(1)
    expect(rows.filter(row => row.id === '/zzfixture')).toHaveLength(1)
    expect(rows.some(row => row.id === '/mouse')).toBe(false)
  })

  it('filters the native picker and runs the exact slash command on explicit Enter', async () => {
    const f = fixture()
    openCommandPalette(f.host)
    const overlay = top(f.overlays)
    await vi.waitFor(() => expect(JSON.stringify(overlay.node('layer.command-palette'))).toContain('/zzfixture'))
    type(overlay, 'zzfixture')
    expect(JSON.stringify(overlay.node('layer.command-palette'))).toContain('"query":"zzfixture"')
    overlay.onKey(key('enter'))
    expect(f.run).toHaveBeenCalledWith('/zzfixture')
    expect(f.set).not.toHaveBeenCalled()
    expect(f.overlays).toHaveLength(0)
  })

  it('Tab inserts an unsent command; Escape preserves the draft and query', async () => {
    const f = fixture()
    f.composer.set('draft with caret', { cursor: 6 })
    f.set.mockClear()
    openCommandPalette(f.host)
    await vi.waitFor(() => expect(f.gw.sent('commands.catalog')).toHaveLength(1))
    const first = top(f.overlays)
    first.onKey(key('escape'))
    expect(f.composer.text).toBe('draft with caret')
    expect(f.composer.cursor).toBe(6)
    expect(f.set).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()

    openCommandPalette(f.host)
    const second = top(f.overlays)
    await vi.waitFor(() => expect(JSON.stringify(second.node('layer.command-palette'))).toContain('/zzfixture'))
    type(second, 'zzfixture')
    second.node('layer.command-palette')
    second.onKey(key('tab'))
    expect(f.set).toHaveBeenCalledWith('/zzfixture ')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('does not apply a stale catalog or run commands for a replaced session', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<CommandsCatalogResult>()
    f.gw.handlers.set('commands.catalog', () => pending.promise)
    openCommandPalette(f.host)
    const old = top(f.overlays)
    f.session.ref = { live: liveSessionId('s2'), stored: null }
    pending.resolve({ pairs: [['/zzfixture', 'Late command']] })
    await Promise.resolve()
    await Promise.resolve()
    expect(JSON.stringify(old.node('layer.command-palette'))).not.toContain('Late command')
    old.onKey(key('enter'))
    expect(f.run).not.toHaveBeenCalled()
  })
})
