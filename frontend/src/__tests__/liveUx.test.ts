import { Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from './appSetup.js'
import { FakeGateway, fakeTern, given, settle, topNodes } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

/** The actual dock tree, not a mock copy of the orb model. */
function flattened(items: Node[]): Node[] {
  return items.flatMap(n => [n, ...flattened(n.children.filter((child): child is Node => child instanceof Node))])
}

describe('the visible live UX in App', () => {
  it('paints an agent orb for its own session and ignores foreign events', async () => {
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    const orb = () => flattened(topNodes(tern.region('dock'))).find(n => n.props['role'] === 'hermes.agent.orb')

    try {
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      gw.event({ type: 'message.start', session_id: 'foreign', payload: {} })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      gw.event({ type: 'reasoning.delta', session_id: 's1', payload: { text: 'reasoning' } })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: thinking')

      gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')
    } finally {
      app.dispose()
      tern.end()
    }
  })

  it('does not paint hidden frames and delivers completion attention on return', async () => {
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    try {
      await settle(gw)
      tern.send({ ev: 'visible', sf: 'hermes', raw: {}, visible: false })
      await settle(gw)
      const before = tern.frame
      gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })
      await settle(gw)

      expect(tern.frame).toBe(before)
      expect(app.stores.notices.current()).toBeUndefined()

      tern.send({ ev: 'visible', sf: 'hermes', raw: {}, visible: true })
      await settle(gw)
      expect(app.stores.notices.current()?.text).toContain('turn finished')
      expect(tern.frame).not.toBe(before)
    } finally {
      app.dispose()
      tern.end()
    }
  })
})
