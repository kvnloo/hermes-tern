// A session, one overlay stack and a recording gateway for BTW/inventory.
// The real app's overlay identity and session ports are reproduced here.
import type { Overlay } from '../overlays/overlay.js'
import type { ChatPorts } from '../app/ports.js'

import { FakeGateway, stub } from './fakes.js'
import { vi } from 'vitest'

export function sideSetup() {
  const gw = new FakeGateway()
  const session = { ref: { live: 's1' } }
  const overlays: Overlay[] = []
  const changed = vi.fn()
  const scroll = vi.fn()

  const close = (overlay: Overlay) => {
    const index = overlays.indexOf(overlay)

    if (index >= 0) {
      overlays.splice(index, 1)
      overlay.onClose?.()
      changed()
    }
  }

  const open = (overlay: Overlay) => {
    const prior = overlays.find(item => item.key === overlay.key)

    if (prior) {
      close(prior)
    }

    overlays.push(overlay)
    changed()
  }

  const host = stub<ChatPorts>({ changed, close, gw: gw.client, open, overlays, scroll, session })

  return { changed, close, gw, host, open, overlays, scroll, session }
}
