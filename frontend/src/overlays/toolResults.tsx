// User-invoked inspection of text already retained in generic tool cards.
import type { JSX, Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { RESULT_PAGE_LIMIT, retainedGenericText, retainedResults, resultPage, safeResultText } from '../tool-results.js'
import { nativeOverlayKey } from './identity.js'
import type { Overlay } from './overlay.js'

export type ToolResultsHost = Pick<ChatPorts, 'changed' | 'close' | 'open' | 'overlays' | 'session' | 'transcript'>

/** Open from /tool-results or the command palette. This never reads a file or calls a gateway. */
export function openToolResults(host: ToolResultsHost): void {
  const source = host.session.ref
  const lifetime = host.transcript.lifetime
  const results = (source.live ? retainedResults(host.transcript.entries) : []).map(result => ({ ...result, outcome: result.call.outcome }))
  const candidates = new Map(results.map(result => [result.call, result.turn]))
  let selected = results.length - 1
  let starts = [0]
  let revision = 0
  let alive = true

  const current = () => results[selected]
  const top = () => alive && host.overlays.at(-1) === sheet
  const owns = () => Boolean(source.live) && top() && host.session.ref === source &&
    host.transcript.lifetime === lifetime
  const membership = () => {
    const members = new Set<(typeof results)[number]['call']>()
    if (!owns()) { return members }
    for (const entry of host.transcript.entries) {
      if (entry.kind !== 'turn') { continue }
      for (const block of entry.blocks) {
        if (block.kind === 'tool' && candidates.get(block.call) === entry) { members.add(block.call) }
      }
    }
    return members
  }
  const present = (candidate: (typeof results)[number], members?: ReadonlySet<(typeof results)[number]['call']>) => candidate.call.outcome === candidate.outcome &&
    candidate.turn.rev === candidate.rev &&
    retainedGenericText(candidate.call) === candidate.text &&
    (members ? members.has(candidate.call) : host.transcript.entries.some(entry => entry === candidate.turn &&
      entry.blocks.some(block => block.kind === 'tool' && block.call === candidate.call)))
  const valid = () => {
    const candidate = current()
    return owns() && candidate !== undefined && present(candidate)
  }
  const select = (index: number, stamp: number) => {
    const next = results[index]
    if (!owns() || stamp !== revision || !Number.isInteger(index) || !next || !present(next)) { return }
    if (index === selected) { return }
    selected = index
    starts = [0]
    revision++
    host.changed()
  }
  const selectItem = (item: string, stamp: number) => {
    const index = Number(item)
    if (String(index) === item) { select(index, stamp) }
  }
  const move = (direction: -1 | 1, stamp: number) => {
    if (!valid() || stamp !== revision) { return }
    if (direction < 0) {
      if (starts.length === 1) { return }
      starts = starts.slice(0, -1)
    } else {
      if (starts.length >= RESULT_PAGE_LIMIT) { return }
      const candidate = current()
      const page = candidate && resultPage(candidate.text, starts.at(-1) ?? 0)
      if (!candidate || !page || page.end >= candidate.text.length) { return }
      starts = [...starts, page.end]
    }
    revision++
    host.changed()
  }
  const close = (stamp: number) => {
    if (top() && stamp === revision) { host.close(sheet) }
  }
  const sheet: Overlay = {
    key: 'tool-results',
    modal: true,
    onClose: () => { alive = false },
    node: (id): JSX.Element => {
      const stamp = revision
      const members = membership()
      const selectedResult = current()
      const candidate = owns() && selectedResult && present(selectedResult, members) ? selectedResult : undefined
      const page = candidate && resultPage(candidate.text, starts.at(-1) ?? 0)
      const items: PickerItem[] = (owns() ? results : []).flatMap((result, index) => present(result, members) ? [{
        id: String(index),
        label: safeResultText(result.call.name.slice(0, 100).replace(/[\ud800-\udbff]$/u, '�')),
        detail: `${result.text.length.toLocaleString()} retained characters`
      }] : [])
      return (
        <overlay anchor="center" head="Retained tool results" key={nativeOverlayKey(id)} modal role="omp.overlay.report" size="lg">
          <picker
            actions={[
              { ...(!page || starts.length === 1 ? { disabled: 'First page' } : {}), id: 'previous', keys: ['p'], label: 'Previous' },
              { ...(!page || !candidate || page.end >= candidate.text.length ? { disabled: 'Last page' } : starts.length >= RESULT_PAGE_LIMIT ? { disabled: 'Page limit reached' } : {}), id: 'next', keys: ['n'], label: 'Next' },
              { end: true, id: 'close', keys: ['esc'], label: 'Close' }
            ]}
            empty={!source.live ? 'A live session is required.' : results.length ? 'This result is no longer available.' : 'No long generic text results in this session.'}
            items={items}
            key={`view-${stamp}`}
            noun="results"
            onAction={{ previous: () => move(-1, stamp), next: () => move(1, stamp), close: () => close(stamp) }}
            onActivate={ev => selectItem(ev.item, stamp)}
            onSelect={ev => selectItem(ev.item, stamp)}
            order={items.map(item => item.id)}
            preview="side"
            {...(candidate ? { selected: String(selected) } : {})}
            size="lg"
            title="80 most recent long generic results"
            total={items.length}
          >
            {candidate ? (
              <col key="page">
                <text key="notice" text={`Page ${starts.length}${starts.length >= RESULT_PAGE_LIMIT && page && page.end < candidate.text.length ? ' · inspection limit reached' : ''}. Retained text may already be truncated upstream; control characters are replaced.`} wrap="word" />
                {page ? <code key="content" lang="text" text={page.text} wrap /> : <text key="unavailable" text="This page contains an oversized character sequence and cannot be shown safely." wrap="word" />}
              </col>
            ) : null}
          </picker>
        </overlay>
      )
    },
    onKey: (key: Key) => {
      const stamp = revision
      if (!top()) { return true }
      if (key.name === 'escape') { close(stamp) }
      else if (!owns()) { return true }
      else if (!key.ctrl && !key.alt && !key.meta && key.name === 'n') { move(1, stamp) }
      else if (!key.ctrl && !key.alt && !key.meta && key.name === 'p') { move(-1, stamp) }
      else if (key.name === 'up' || key.name === 'down') {
        const direction = key.name === 'up' ? -1 : 1
        const members = membership()
        for (let index = selected + direction; index >= 0 && index < results.length; index += direction) {
          const item = results[index]
          if (item && present(item, members)) { select(index, stamp); break }
        }
      }
      return true
    }
  }
  host.open(sheet)
}
