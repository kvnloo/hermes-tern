import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { openBrowserBlocks, type BrowserHost } from '../overlays/browser.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'

const user = { target_id: '7', title: 'User page', url: 'https://example.org/', owner: null, owned: false, available: true }
const owned = { ...user, target_id: '9', title: 'Hermes page', owned: true, owner: 123 }
const confirmed = (id: string) => ({ target_id: id, title: 'Confirmed page', url: 'https://example.org/', in_tern: true, frame: 'main' })

function harness(blocks = [user, owned]) {
  const gateway = new FakeGateway({ replies: {
    'browser.blocks': () => ({ available: true, blocks }),
    'browser.adopt': p => confirmed(String(p['target_id'])),
    'browser.focus': p => confirmed(String(p['target_id'])),
    'browser.frame': p => confirmed(String(p['target_id'])),
    'browser.release': p => ({ target_id: p['target_id'], released: true })
  } })
  const overlays: Overlay[] = []
  const session = { ref: { live: liveSessionId('s1'), stored: null }, info: null }
  let running = false
  let revisions = 0
  const host = stub<BrowserHost>({
    gw: gateway.client,
    session,
    get busy() { return running ? { label: 'Working', since: {}, startedAt: 0 } : null },
    get overlays() { return overlays },
    changed: () => { revisions++ },
    open: (o: Overlay) => { overlays.push(o) },
    close: (o: Overlay) => { const i = overlays.indexOf(o); if (i >= 0) { overlays.splice(i, 1); o.onClose?.() } }
  })

  const sheet = async () => {
    openBrowserBlocks(host)
    await vi.waitFor(() => expect(gateway.methods('browser.blocks')).toHaveLength(1))
    await vi.waitFor(() => expect(JSON.stringify(tree(must(overlays.at(-1)).node('layer.browser-blocks')))).toContain('User page'))

    return must(overlays.at(-1))
  }

  return { gateway, overlays, session, setBusy: (v: boolean) => { running = v }, sheet, updates: () => revisions }
}

describe('Tern browser-block sheet', () => {
  it('discovery shows title, URL and ownership without adopting; Escape closes', async () => {
    const h = harness()
    const sheet = await h.sheet()
    const shown = JSON.stringify(tree(sheet.node('layer.browser-blocks')))
    expect(shown).toContain('7 · User page · https://example.org/ · owner docked')
    expect(h.gateway.calls.map(c => c.method)).toEqual(['browser.blocks'])
    sheet.onKey(key('escape'))
    expect(h.overlays).toHaveLength(0)
  })

  it('explicit Enter hands over only the selected undriven block', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.methods('browser.adopt')).toHaveLength(1))
    expect(h.gateway.sent('browser.adopt')).toEqual([{ session_id: 's1', target_id: '7' }])
    await vi.waitFor(() => expect(h.overlays).toHaveLength(0))
  })

  it('focuses an owned block and releases only that block, refreshing after confirmation', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('down'))
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.sent('browser.focus')).toEqual([{ session_id: 's1', target_id: '9' }]))

    const second = await h.sheet()
    second.onKey(key('down'))
    second.onKey(key('r'))
    await vi.waitFor(() => expect(h.gateway.sent('browser.release')).toEqual([{ session_id: 's1', target_id: '9' }]))
    await vi.waitFor(() => expect(h.gateway.methods('browser.blocks')).toHaveLength(3))
    expect(h.overlays).toHaveLength(1)
  })

  it('blocks handover/release/frame changes while busy, but keeps owned focus available', async () => {
    const h = harness()
    const sheet = await h.sheet()
    h.setBusy(true)
    sheet.onKey(key('enter'))
    expect(h.gateway.methods('browser.adopt')).toHaveLength(0)
    sheet.onKey(key('down'))
    sheet.onKey(key('r'))
    sheet.onKey(key('f'))
    expect(h.gateway.methods('browser.release')).toHaveLength(0)
    expect(h.gateway.methods('browser.frame')).toHaveLength(0)
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.methods('browser.focus')).toHaveLength(1))
  })

  it('frame selection is an explicit verified RPC, not a promise to drive a child frame', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('down'))
    sheet.onKey(key('f'))
    expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Evaluation frame path')
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.sent('browser.frame')).toEqual([
      { session_id: 's1', target_id: '9', frame: 'main' }
    ]))
  })

  it('late listing and a switched session never adopt or mutate a newer sheet', async () => {
    const h = harness()
    const pending = Promise.withResolvers<unknown>()
    h.gateway.handlers.set('browser.blocks', () => pending.promise)
    openBrowserBlocks(stub<BrowserHost>({
      gw: h.gateway.client,
      session: h.session,
      busy: null,
      get overlays() { return h.overlays },
      changed: () => undefined,
      open: (o: Overlay) => { h.overlays.push(o) },
      close: (o: Overlay) => { const i = h.overlays.indexOf(o); if (i >= 0) h.overlays.splice(i, 1) }
    }))
    const sheet = must(h.overlays.at(-1))
    sheet.onKey(key('escape'))
    h.session.ref.live = liveSessionId('s2')
    pending.resolve({ available: true, blocks: [user] })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.overlays).toHaveLength(0)
    expect(h.gateway.calls.map(c => c.method)).toEqual(['browser.blocks'])
  })

  it('reports a gateway refusal without claiming browser ownership', async () => {
    const h = harness()
    h.gateway.handlers.set('browser.blocks', () => { throw new Error('Method not found') })
    openBrowserBlocks(stub<BrowserHost>({
      gw: h.gateway.client,
      session: h.session,
      busy: null,
      get overlays() { return h.overlays },
      changed: () => undefined,
      open: (o: Overlay) => { h.overlays.push(o) },
      close: () => undefined
    }))
    await vi.waitFor(() => expect(JSON.stringify(tree(must(h.overlays.at(-1)).node('layer.browser-blocks')))).toContain('does not support browser-block controls'))
    expect(h.gateway.calls.map(c => c.method)).toEqual(['browser.blocks'])
  })
})
