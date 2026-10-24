// Conversation-owned completion notices belong in the dock, never the main transcript.
import type { JSX } from '@stencil-hq/tern'

import type { BtwNotice } from '../btw.js'

import type { DockActions } from './dock.js'
import { button } from './ui/button.js'

export function btwNoticesNode(
  notices: readonly BtwNotice[],
  on: Pick<DockActions, 'onBtwView' | 'onBtwDismiss'>
): JSX.Element {
  return (
    <col gap="xs" key="btw-notices" role="omp.btw.notices">
      {notices.map(notice => (
        <row align="center" gap="sm" key={notice.id} role="omp.btw.notice">
          <text
            grow={1}
            key="label"
            role="omp.btw.notice.message"
            text={notice.failed ? 'Side question failed' : 'Side question answered'}
            tone={notice.failed ? 'error' : 'muted'}
          />
          {button({ key: 'view', label: 'View', onClick: () => on.onBtwView(notice) })}
          {button({ key: 'dismiss', label: 'Dismiss', onClick: () => on.onBtwDismiss(notice) })}
        </row>
      ))}
    </col>
  )
}
