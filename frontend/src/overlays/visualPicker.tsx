// A user-invoked picker of completed terminal-reported visual files. Selection
// delegates to the same bounded validator as the explicit /visual path.
import { basename } from 'node:path'

import type { Key } from '@stencil-hq/tern'

import type { Entry } from '../model.js'
import { actionsRow, button } from '../view/ui/button.js'
import { recentVisualCandidates, type VisualCandidate } from '../visual-discovery.js'
import { readPreparedVisual, visualScope } from '../visuals.js'

import type { Overlay } from './overlay.js'
import { type LoadVisual, openVisual, type VisualHost } from './visual.js'

export type VisualPickerHost = VisualHost

/** Read no candidate bytes until a row is explicitly chosen. */
export async function openVisualPicker(
  host: VisualPickerHost,
  path: string,
  load: LoadVisual = readPreparedVisual
): Promise<void> {
  const sid = host.session.ref.live
  const scope = visualScope(host)
  const entries: readonly Entry[] = host.transcript.entries
  const candidates = !path && scope ? recentVisualCandidates(entries, scope) : []

  if (path || !scope || !candidates.length) {
    return openVisual(host, path, load)
  }

  let selected = 0
  let expired = false

  const current = () => {
    expired ||= host.session.ref.live !== sid || visualScope(host) !== scope || host.transcript.entries !== entries

    return !expired && host.overlays.includes(overlay)
  }

  const close = () => host.close(overlay)

  const choose = async (candidate: VisualCandidate) => {
    if (!current() || host.overlays.at(-1) !== overlay) {
      return
    }

    close()
    await openVisual(host, candidate.path, load, candidate.id)
  }

  const overlay: Overlay = {
    key: 'visual-candidates',
    modal: true,
    node: () => (
      <overlay anchor="center" head="Recent visual candidates" key="visual-candidates" modal role="omp.overlay.visual" size="lg">
        <col gap="sm" key="body">
          {!current() ? (
            <text key="expired" text="Session, branch or transcript changed. Reopen /visual." />
          ) : (
            <col gap="sm" key="choices">
              <text key="status" text="Reported files only · not validated, visually verified or published" tone="warning" />
              <text key="hint" text="Select to validate. Up/Down, Enter or click; Escape closes." />
              {candidates.map((candidate, index) =>
                button({
                  key: `candidate-${index}`,
                  label: `${index === selected ? '› ' : ''}${basename(candidate.path)} · ${candidate.id.slice(0, 12)}`,
                  hint: candidate.path,
                  onClick: () => void choose(candidate)
                })
              )}
              <text key="limits" text="Up to 12 completed results; no file scan or live polling. Reopen to refresh." />
              <text key="scope" text={scope} />
            </col>
          )}
          {actionsRow([{ hint: 'escape', key: 'close', label: 'Close', onClick: close }])}
        </col>
      </overlay>
    ),
    onKey: (key: Key) => {
      if (!current()) {
        close()

        return true
      }

      if (host.overlays.at(-1) !== overlay) {
        return true
      }

      if (key.name === 'escape' || key.name === 'q') {
        close()
      } else if (key.name === 'up' || key.name === 'down') {
        selected = (selected + (key.name === 'up' ? -1 : 1) + candidates.length) % candidates.length
        host.changed()
      } else if (key.name === 'enter' || key.name === 'return') {
        const candidate = candidates[selected]

        if (candidate) {
          void choose(candidate)
        }
      }

      return true
    }
  }

  host.open(overlay)
}
