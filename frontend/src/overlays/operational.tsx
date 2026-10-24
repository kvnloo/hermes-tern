// The operational report sheet is a view over one session-scoped backend read.
// Controls are owned by the open overlay, so old callbacks cannot copy a new report.
import type { JSX, Key, ScrollTo } from '@stencil-hq/tern'

import { copyToClipboard } from '../clipboard.js'
import type { OperationalSheets } from '../operations.js'
import type { Report } from '../reports.js'
import { actionsRow } from '../view/ui/button.js'

import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'

const SCROLL: Readonly<Record<string, ScrollTo>> = {
  up: 'line-up', down: 'line-down', page_up: 'page-up', page_down: 'page-down',
  home: 'start', end: 'end'
}

export function openOperationalOverlay(owner: OperationalSheets, report: Report): Overlay {
  const host = owner.host
  let message = ''
  let root = ''
  const valid = () => owner.owns(sheet)
  const close = () => {
    if (valid()) {
      host.close(sheet)
    }
  }
  const copy = () => {
    if (!valid()) {
      return
    }

    try {
      copyToClipboard(report.text)
      message = 'Report copied to the terminal clipboard.'
    } catch {
      message = 'Could not copy the report to the clipboard.'
    }

    host.changed()
  }

  const sheet: Overlay = {
    key: 'operational',
    modal: true,
    cancel: close,
    onClose: () => owner.closed(sheet),
    node: (id): JSX.Element => {
      root = id
      return (
      <overlay anchor="bottom" head={report.title} key={nativeOverlayKey(id)} modal role="omp.overlay.report" size="lg">
        <col gap="sm" key="body">
          <text key="state" role="omp.report.state" text={report.status} />
          {report.scope ? <text key="scope" role="omp.report.scope" text={'Hermes profile: ' + report.scope + ' · Read only'} wrap="word" /> : null}
          <md key="markdown" role="omp.report.body" text={report.text} />
          {message ? <text key="message" role="omp.report.notice" text={message} wrap="word" /> : null}
          {actionsRow([
            { key: 'copy', label: 'Copy', onClick: copy },
            { key: 'close', label: 'Close', hint: 'escape', onClick: close }
          ])}
        </col>
      </overlay>
      )
    },
    onKey: (key: Key) => {
      if (!valid()) {
        return true
      }

      if (key.name === 'escape') {
        close()
      } else if (!key.alt && !key.ctrl && !key.meta && key.name === 'c') {
        copy()
      } else {
        const to = SCROLL[key.name]

        if (to) {
          host.scroll(root + '.body.markdown', to)
        }
      }

      return true
    }
  }

  host.open(sheet)

  return sheet
}
