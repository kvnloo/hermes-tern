import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Overlay } from '../overlays/overlay.js'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { SessionState } from '../session/state.js'
import { FakeGateway, key } from '../__tests__/fakes.js'

import { openCommandPalette, paletteRows, type PaletteHost } from './palette.js'

function fixture(catalog: CommandsCatalogResult = { categories: [{ name: 'Fixture', pairs: [['/zzfixture', 'Fixture command']] }] }) {
  const gw = new FakeGateway({ replies: { 'commands.catalog': () => catalog } })
  const session = new SessionState(() => {})
  session.ref = { live: liveSessionId('s1'), stored: null }
  const overlays: Overlay[] = []
  const set = vi.fn()
  const run = vi.fn()
  const changed = vi.fn()
  const notice = vi.fn()
  const host = {
    gw: gw.client, session, composer: { set }, run, changed,
    transcript: { notice },
    close: (overlay: Overlay) => void overlays.splice(overlays.indexOf(overlay), 1),
    open: (overlay: Overlay) => void overlays.push(overlay)
  } as unknown as PaletteHost

  return { gw, session, host, overlays, set, run, changed, notice }
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
    const overlay = f.overlays[0]!
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
    openCommandPalette(f.host)
    await vi.waitFor(() => expect(f.gw.sent('commands.catalog')).toHaveLength(1))
    const first = f.overlays[0]!
    first.onKey(key('escape'))
    expect(f.set).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()

    openCommandPalette(f.host)
    const second = f.overlays[0]!
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
    const old = f.overlays[0]!
    f.session.ref = { live: liveSessionId('s2'), stored: null }
    pending.resolve({ pairs: [['/zzfixture', 'Late command']] })
    await Promise.resolve()
    await Promise.resolve()
    expect(JSON.stringify(old.node('layer.command-palette'))).not.toContain('Late command')
    old.onKey(key('enter'))
    expect(f.run).not.toHaveBeenCalled()
  })
})
