import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { openBrowserBlocks, type BrowserHost } from '../overlays/browser.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'
import { nativeBrowserSurface } from './browserSdk.js'

const user = { target_id: '7', title: 'User page', url: 'https://example.org/', owner: null, owned: false, available: true }
const owned = { ...user, target_id: '9', title: 'Hermes page', owned: true, owner: 123 }
const confirmed = (id: string) => ({ target_id: id, title: 'Confirmed page', url: 'https://example.org/', in_tern: true, frame: 'main' })

function harness(blocks = [user, owned]) {
  const gateway = new FakeGateway({ replies: {
    'config.get': () => ({ home: '/isolated', display: '/isolated/profiles/work' }),
    'gateway.capabilities': () => ({ plugin_methods: ['blocks', 'adopt', 'focus', 'release', 'frame'].map(name => 'hermes-tern.browser.' + name) }),
    'hermes-tern.browser.blocks': () => ({ available: true, blocks }),
    'hermes-tern.browser.adopt': p => confirmed(String(p['target_id'])),
    'hermes-tern.browser.focus': p => confirmed(String(p['target_id'])),
    'hermes-tern.browser.frame': p => confirmed(String(p['target_id'])),
    'hermes-tern.browser.release': p => ({ target_id: p['target_id'], released: true })
  } })
  const overlays: Overlay[] = []
  const session = { ref: { live: liveSessionId('s1'), stored: null }, info: { profile_name: 'work' } }
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
    const listings = gateway.methods('hermes-tern.browser.blocks').length
    openBrowserBlocks(host)
    await vi.waitFor(() => expect(gateway.methods('hermes-tern.browser.blocks')).toHaveLength(listings + 1))
    await vi.waitFor(() => expect(JSON.stringify(tree(must(overlays.at(-1)).node('layer.browser-blocks')))).toContain(must(blocks[0]).title))

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
    expect(h.gateway.calls.filter(c => c.method.startsWith('hermes-tern.browser.')).map(c => c.method)).toEqual(['hermes-tern.browser.blocks'])
    sheet.onKey(key('escape'))
    expect(h.overlays).toHaveLength(0)
  })

  it('explicit Enter hands over only the selected undriven block', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(1))
    expect(h.gateway.sent('hermes-tern.browser.adopt')).toEqual([{ session_id: 's1', target_id: '7' }])
    await vi.waitFor(() => expect(h.overlays).toHaveLength(0))
  })

  it('focuses an owned block and releases only that block, refreshing after confirmation', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('down'))
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.focus')).toEqual([{ session_id: 's1', target_id: '9' }]))
    await vi.waitFor(() => expect(h.overlays).toHaveLength(0))

    const second = await h.sheet()
    second.onKey(key('down'))
    second.onKey(key('r'))
    await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.release')).toEqual([{ session_id: 's1', target_id: '9' }]))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(3))
    expect(h.overlays).toHaveLength(1)
  })

  it('blocks handover/release/frame changes while busy, but keeps owned focus available', async () => {
    const h = harness()
    const sheet = await h.sheet()
    h.setBusy(true)
    sheet.onKey(key('enter'))
    expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(0)
    sheet.onKey(key('down'))
    sheet.onKey(key('r'))
    sheet.onKey(key('f'))
    expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)
    expect(h.gateway.methods('hermes-tern.browser.frame')).toHaveLength(0)
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.focus')).toHaveLength(1))
  })

  it('frame selection is an explicit verified RPC, not a promise to drive a child frame', async () => {
    const h = harness()
    const sheet = await h.sheet()
    sheet.onKey(key('down'))
    sheet.onKey(key('f'))
    expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Evaluation frame path')
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.frame')).toEqual([
      { session_id: 's1', target_id: '9', frame: 'main' }
    ]))
  })

  it('late listing and a switched session never adopt or mutate a newer sheet', async () => {
    const h = harness()
    const pending = Promise.withResolvers<unknown>()
    h.gateway.handlers.set('hermes-tern.browser.blocks', () => pending.promise)
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
    // Capability preflight is asynchronous: do not dismiss until the real
    // namespaced listing was dispatched and is waiting on this deferred reply.
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(1))
    sheet.onKey(key('escape'))
    h.session.ref.live = liveSessionId('s2')
    pending.resolve({ available: true, blocks: [user] })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.overlays).toHaveLength(0)
    expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(0)
    expect(h.gateway.methods('hermes-tern.browser.focus')).toHaveLength(0)
    expect(h.gateway.calls.filter(c => c.method.startsWith('hermes-tern.browser.')).map(c => c.method)).toEqual(['hermes-tern.browser.blocks'])
  })

  it('an adoption refusal keeps the sheet open and never claims control', async () => {
    const h = harness()
    h.gateway.handlers.set('hermes-tern.browser.adopt', () => { throw new Error('Block already driven') })
    const sheet = await h.sheet()
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Block already driven'))
    expect(h.overlays).toHaveLength(1)
    expect(h.gateway.sent('hermes-tern.browser.adopt')).toEqual([{ session_id: 's1', target_id: '7' }])
  })

  it('failed release retains ownership and allows a deliberate retry', async () => {
    const h = harness()
    h.gateway.handlers.set('hermes-tern.browser.release', () => { throw new Error('Cleanup failed') })
    const sheet = await h.sheet()
    sheet.onKey(key('down'))
    sheet.onKey(key('r'))
    await vi.waitFor(() => expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Cleanup failed'))
    expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(1)
    expect(h.overlays).toHaveLength(1)
    h.gateway.handlers.set('hermes-tern.browser.release', p => ({ target_id: p['target_id'], released: true }))
    sheet.onKey(key('r'))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(2))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(2))
  })

  it('reports a gateway refusal without claiming browser ownership', async () => {
    const h = harness()
    h.gateway.handlers.set('gateway.capabilities', () => ({ plugin_methods: [] }))
    openBrowserBlocks(stub<BrowserHost>({
      gw: h.gateway.client,
      session: h.session,
      busy: null,
      get overlays() { return h.overlays },
      changed: () => undefined,
      open: (o: Overlay) => { h.overlays.push(o) },
      close: () => undefined
    }))
    await vi.waitFor(() => expect(JSON.stringify(tree(must(h.overlays.at(-1)).node('layer.browser-blocks')))).toContain('requires Hermes plugin gateway methods'))
    expect(h.gateway.calls.filter(c => c.method.startsWith('hermes-tern.browser.'))).toEqual([])
    expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(0)
  })

  it('reports a namespaced listing refusal when capability preflight succeeds', async () => {
    const h = harness()
    h.gateway.handlers.set('hermes-tern.browser.blocks', () => { throw new Error('Listing denied') })
    openBrowserBlocks(stub<BrowserHost>({
      gw: h.gateway.client,
      session: h.session,
      busy: null,
      get overlays() { return h.overlays },
      changed: () => undefined,
      open: (o: Overlay) => { h.overlays.push(o) },
      close: () => undefined
    }))
    await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(1))
    await vi.waitFor(() => expect(JSON.stringify(tree(must(h.overlays.at(-1)).node('layer.browser-blocks')))).toContain('Listing denied'))
    expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(0)
    expect(h.overlays).toHaveLength(1)
  })
})

describe('browser-block SDK callback ownership', () => {
  const first = { ...owned, target_id: '7', title: 'First owned block' }

  it('a captured native SDK Focus for 7 never follows keyboard selection to 9', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      const clickSeven = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'choose', '7')
      sheet.onKey(key('down'))
      sdk.render('layer', sheet.node('layer.browser-blocks'))
      await clickSeven()
      await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.focus')).toEqual([{ session_id: 's1', target_id: '7' }]))
      expect(h.gateway.methods('hermes-tern.browser.adopt')).toHaveLength(0)
      expect(h.overlays).toHaveLength(0)
    } finally {
      await sdk.close()
    }
  })

  it('a captured native SDK Release for 7 never releases selected block 9', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      const clickSeven = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'release', '7')
      sheet.onKey(key('down'))
      sdk.render('layer', sheet.node('layer.browser-blocks'))
      await clickSeven()
      await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.release')).toEqual([{ session_id: 's1', target_id: '7' }]))
      await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(2))
    } finally {
      await sdk.close()
    }
  })

  it('a frame form begun for 7 stays owned by 7 after keyboard selection moves to 9', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    sheet.onKey(key('f'))
    const sdk = await nativeBrowserSurface()

    try {
      const clickSeven = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'apply-frame', '7')
      sheet.onKey(key('down'))
      expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Evaluation frame path')
      sdk.render('layer', sheet.node('layer.browser-blocks'))
      await clickSeven()
      await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.frame')).toEqual([{ session_id: 's1', target_id: '7', frame: 'main' }]))
      expect(h.gateway.sent('hermes-tern.browser.focus')).toEqual([])
      expect(h.gateway.sent('hermes-tern.browser.release')).toEqual([])
    } finally {
      await sdk.close()
    }
  })

  it('keyboard Enter in a frame form applies its original owner, not the selected row', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    sheet.onKey(key('f'))
    sheet.onKey(key('down'))
    sheet.onKey(key('enter'))
    await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.frame')).toEqual([{ session_id: 's1', target_id: '7', frame: 'main' }]))
  })


  it('a new native SDK Apply cannot submit old frame text after same-id refresh', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      sheet.onKey(key('f'))
      sheet.onKey(key('u', { ctrl: true }))
      sheet.onKey(key('paste', { text: '12.3' }))
      expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('12.3')

      const before = sdk.render('layer', sheet.node('layer.browser-blocks'))
      const oldApply = sdk.capture(before, 'layer', 'apply-frame', '7')
      const refresh = sdk.capture(before, 'layer', 'refresh')
      h.gateway.handlers.set('hermes-tern.browser.blocks', () => ({
        available: true,
        blocks: [{ ...first, title: 'Replacement block 7' }, owned]
      }))
      await refresh()
      await vi.waitFor(() => expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Replacement block 7'))

      const newView = sdk.render('layer', sheet.node('layer.browser-blocks'))
      expect(() => sdk.capture(newView, 'layer', 'apply-frame', '7')).toThrow('Missing native Tern handler node')
      expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).not.toContain('Evaluation frame path')
      expect(sheet.focus?.('layer.browser-blocks')).toBeNull()
      await oldApply()
      expect(h.gateway.methods('hermes-tern.browser.frame')).toHaveLength(0)

      sheet.onKey(key('enter'))
      await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.focus')).toEqual([{ session_id: 's1', target_id: '7' }]))
      expect(h.gateway.methods('hermes-tern.browser.frame')).toHaveLength(0)
    } finally {
      await sdk.close()
    }
  })

  it('only an explicit new edit exposes a clean frame Apply after same-id refresh', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      sheet.onKey(key('f'))
      sheet.onKey(key('u', { ctrl: true }))
      sheet.onKey(key('paste', { text: '12.3' }))
      const oldView = sdk.render('layer', sheet.node('layer.browser-blocks'))
      const oldApply = sdk.capture(oldView, 'layer', 'apply-frame', '7')
      const refresh = sdk.capture(oldView, 'layer', 'refresh')
      h.gateway.handlers.set('hermes-tern.browser.blocks', () => ({
        available: true,
        blocks: [{ ...first, title: 'Replacement block 7' }, owned]
      }))
      await refresh()
      await vi.waitFor(() => expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).toContain('Replacement block 7'))

      await oldApply()
      expect(h.gateway.methods('hermes-tern.browser.frame')).toHaveLength(0)
      sheet.onKey(key('f'))
      const apply = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'apply-frame', '7')
      await apply()
      await vi.waitFor(() => expect(h.gateway.sent('hermes-tern.browser.frame')).toEqual([
        { session_id: 's1', target_id: '7', frame: 'main' }
      ]))
    } finally {
      await sdk.close()
    }
  })

  it.each(['removed', 'error'] as const)('%s listing clears the native form and hidden keyboard sink', async outcome => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      sheet.onKey(key('f'))
      sheet.onKey(key('u', { ctrl: true }))
      sheet.onKey(key('paste', { text: '12.3' }))
      const before = sdk.render('layer', sheet.node('layer.browser-blocks'))
      const oldApply = sdk.capture(before, 'layer', 'apply-frame', '7')
      const refresh = sdk.capture(before, 'layer', 'refresh')
      h.gateway.handlers.set('hermes-tern.browser.blocks', () => {
        if (outcome === 'error') {
          throw new Error('Listing failed')
        }

        return { available: true, blocks: [owned] }
      })
      await refresh()
      await vi.waitFor(() => {
        const shown = JSON.stringify(tree(sheet.node('layer.browser-blocks')))
        expect(shown).toContain(outcome === 'error' ? 'Listing failed' : 'Hermes page')
        expect(shown).not.toContain('Evaluation frame path')
      })

      const current = sdk.render('layer', sheet.node('layer.browser-blocks'))
      expect(() => sdk.capture(current, 'layer', 'apply-frame', '7')).toThrow('Missing native Tern handler node')
      expect(sheet.focus?.('layer.browser-blocks')).toBeNull()
      await oldApply()
      expect(h.gateway.methods('hermes-tern.browser.frame')).toHaveLength(0)

      // Escape must close the overlay, not just the now-invisible editor.
      sheet.onKey(key('escape'))
      expect(h.overlays).toHaveLength(0)
    } finally {
      await sdk.close()
    }
  })

  it('a refresh revokes captured SDK actions, including same-id replacement and removed blocks', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      const oldSeven = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'release', '7')
      h.gateway.handlers.set('hermes-tern.browser.blocks', () => ({ available: true, blocks: [{ ...first }, owned] }))
      sheet.onKey(key('r', { shift: true }))
      await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(2))
      await vi.waitFor(() => expect(h.updates()).toBeGreaterThan(4))
      sdk.render('layer', sheet.node('layer.browser-blocks'))
      await oldSeven()
      expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)

      h.gateway.handlers.set('hermes-tern.browser.blocks', () => ({ available: true, blocks: [owned] }))
      sheet.onKey(key('r', { shift: true }))
      await vi.waitFor(() => expect(h.gateway.methods('hermes-tern.browser.blocks')).toHaveLength(3))
      await vi.waitFor(() => expect(JSON.stringify(tree(sheet.node('layer.browser-blocks')))).not.toContain('First owned block'))
      await oldSeven()
      expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)
    } finally {
      await sdk.close()
    }
  })

  it('closing, session replacement, or a busy state invalidates a queued SDK mutation', async () => {
    const h = harness([first, owned])
    const sheet = await h.sheet()
    const sdk = await nativeBrowserSurface()

    try {
      const release = sdk.capture(sdk.render('layer', sheet.node('layer.browser-blocks')), 'layer', 'release', '7')
      h.setBusy(true)
      await release()
      expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)

      h.setBusy(false)
      h.session.ref = { live: liveSessionId('s1'), stored: null }
      await release()
      expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)

      sheet.onKey(key('escape'))
      await release()
      expect(h.gateway.methods('hermes-tern.browser.release')).toHaveLength(0)
      expect(h.overlays).toHaveLength(0)
    } finally {
      await sdk.close()
    }
  })
})
