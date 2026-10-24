import { openCommandPalette } from '../shortcuts/palette.js'

import type { ActionsCx } from './actions.js'

/** Adapt the app ports to the palette without duplicating the slash dispatcher. */
export function openAppPalette(cx: Pick<ActionsCx, 'chat' | 'composer'>, run: (command: string) => void) {
  const { chat, composer } = cx
  openCommandPalette({
    changed: () => chat.changed(),
    close: overlay => chat.close(overlay),
    composer,
    gw: chat.gw,
    open: overlay => chat.open(overlay),
    run,
    session: chat.session,
    transcript: chat.transcript
  })
}
