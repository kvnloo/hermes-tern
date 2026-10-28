// Bounded gateway notice projection on the status strip. Inspection is user initiated.
import type { JSX } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import type { StatusLine } from './dock.js'

export function statusNotices(s: StatusLine, open: (() => void) | undefined): JSX.Element[] {
  return [
    s.otherError ? (
      <seg key="notice-error" priority={9} role="hermes.statusline.bad" {...optional('onClick', open)}
        spans={[{ t: s.otherError.text }]} title={s.otherError.text} />
    ) : null,
    s.notice ? (
      <seg key="notice" priority={s.notice.tone === 'error' ? 9 : 6} {...optional('onClick', open)}
        {...optional('role', s.notice.tone === 'info' ? undefined : `hermes.statusline.${s.notice.tone === 'warning' ? 'warn' : s.notice.tone === 'error' ? 'bad' : 'good'}`)}
        spans={[{ t: s.notice.text }]} title={s.notice.text} />
    ) : null,
    s.noticeCount ? (
      <seg key="notice-count" priority={7} {...optional('onClick', open)}
        spans={[{ t: `${s.noticeCount} notices · /notices` }]}
        title="Inspect retained notices (/notices)" />
    ) : null
  ].filter(node => node !== null)
}
