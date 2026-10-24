import type { ActionsCx } from './actions.js'
import { nativePathIsLocal, type NativeImageEvent } from '../artifacts/attachments.js'
import { clipboardDraft } from '../artifacts/clipboard.js'
import { copyToClipboard } from '../clipboard.js'

/** Copy without consuming or editing the live draft. */
export function copyComposer(cx: ActionsCx, currentLine: boolean) {
  try {
    copyToClipboard(clipboardDraft(cx.composer.text, cx.composer.cursor, currentLine))
    cx.chat.notice('Composer text sent to the terminal clipboard (OSC 52).')
  } catch {
    cx.chat.notice('Could not copy the composer text to the clipboard.', 'warning')
  }
}

/** Native attachment intents retain their negotiated host authority. */
export function attachNativeImage(cx: ActionsCx, image: NativeImageEvent) {
  if (image.kind === 'rejected') {
    cx.transcript.notice(image.reason, 'warning')
    cx.changed()
  } else if (image.kind === 'path') {
    void cx.attachments.fromNativePath(image.path, nativePathIsLocal(cx.gw))
  } else {
    void cx.attachments.fromDataUrl(image.data, image.name)
  }
}
