import type { ActionsCx } from './actions.js'
import { isModal } from '../view/dockModel.js'
import { busyIntent } from '../turn/busyInput.js'

/** Never redirect a live turn implicitly; shell, slash, images and modal answers retain their paths. */
export function shouldSteer(cx: ActionsCx, raw: string, alternate: boolean): boolean {
  const text = raw.trim()
  return Boolean(
    cx.activity.busy && cx.state.ref.live && !cx.life.switching && !cx.liveVoice.blocked &&
    !isModal(cx.chat.overlays) && !cx.attachments.any && !cx.attachments.uploading &&
    text && !text.startsWith('/') && !text.startsWith('!') &&
    busyIntent(cx.state.busyMode, alternate) === 'steer'
  )
}
