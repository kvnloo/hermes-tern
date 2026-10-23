import { describe, expect, it, vi } from 'vitest'

import { entryId, liveSessionId, storedSessionId, toolCallId } from '../core/ids.js'
import type { Entry, ToolCall } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { openVisual, type VisualHost } from '../overlays/visual.js'
import { openVisualPicker, type VisualPickerHost } from '../overlays/visualPicker.js'
import type { PreparedVisual } from '../visuals.js'

import { key, must, stub, stubOverlay } from './fakes.js'

const scope = '["stored","main"]'
const id = 'a'.repeat(64)
const visual: PreparedVisual = {
  id,
  title: 'Computed source data',
  mode: 'code',
  path: '/tmp/prepared.hvisual.json',
  href: 'file:///tmp/prepared.hvisual.json',
  metrics: [{ key: 'code', label: 'Text lines', value: 12 }]
}

function entries(): Entry[] {
  const call: ToolCall = {
    id: toolCallId('tool-1'),
    name: 'terminal',
    args: {},
    argsText: '',
    context: '',
    startedAt: 0,
    outcome: { kind: 'done', duration: 1 },
    via: { kind: 'direct' },
    result: { exit_code: 0, output: JSON.stringify({ kind: 'hermes.visual.candidate', version: 1, id, path: visual.path, scope }) }
  }

  return [{
    kind: 'turn', id: entryId('turn'), rev: 0, end: { status: 'done' }, startedAt: 0,
    blocks: [{ kind: 'tool', id: call.id, call }]
  }]
}

function host() {
  const overlays: Overlay[] = []
  const session = { ref: { live: liveSessionId('runtime'), stored: storedSessionId('stored') }, info: { branch: 'main' } }
  const transcript = { entries: entries() }
  const changed = vi.fn()

  const close = (overlay: Overlay) => {
    const index = overlays.indexOf(overlay)

    if (index >= 0) {
      overlays.splice(index, 1)
      overlay.onClose?.()
    }
  }

  const open = (overlay: Overlay) => {
    const prior = overlays.find(o => o.key === overlay.key)

    if (prior) {
      close(prior)
    }

    overlays.push(overlay)
  }

  return { overlays, session, transcript, changed, close, open }
}

const rendered = (o: Overlay) => JSON.stringify(o.node(`layer.${o.key}`))
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('OpenUI /visual native overlay ownership', () => {
  it('shows exact scope without IO and keeps preview path local to session', async () => {
    const app = host()
    const load = vi.fn(async () => visual)
    await openVisual(stub<VisualHost>(app), '', load)
    expect(rendered(must(app.overlays[0]))).toContain('stored')
    expect(load).not.toHaveBeenCalled()

    app.session.ref = { ...app.session.ref, live: liveSessionId('other') }
    expect(rendered(must(app.overlays[0]))).toContain('Session, branch or transcript changed')
  })

  it('mounts summary and file route without sending any gateway intent', async () => {
    const app = host()
    await openVisual(stub<VisualHost>(app), visual.path, async () => visual)
    const tree = rendered(must(app.overlays[0]))
    expect(tree).toContain(visual.href)
    expect(tree).toContain(visual.title)
    expect(tree).toContain('not visually verified or published')
  })

  it('Escape aborts pending file reads; late data cannot reopen a dismissed overlay', async () => {
    const app = host()
    const pending = Promise.withResolvers<PreparedVisual>()
    let signal: AbortSignal | undefined
    const read = openVisual(stub<VisualHost>(app), visual.path, (_path, _scope, abort) => {
      signal = abort

      return pending.promise
    })
    must(app.overlays[0]).onKey(key('escape'))
    expect(signal?.aborted).toBe(true)
    pending.resolve(visual)
    await read
    expect(app.overlays).toHaveLength(0)
    expect(app.changed).not.toHaveBeenCalled()
  })

  it('does not allow an old read or callback to mutate a same-key replacement', async () => {
    const app = host()
    const pending = Promise.withResolvers<PreparedVisual>()
    const first = openVisual(stub<VisualHost>(app), visual.path, () => pending.promise)
    const stale = must(app.overlays[0])
    await openVisual(stub<VisualHost>(app), visual.path, async () => ({ ...visual, title: 'New preview' }))
    app.changed.mockClear()
    pending.reject(new Error('late failure'))
    await first
    stale.onKey(key('escape'))
    expect(rendered(must(app.overlays[0]))).toContain('New preview')
    expect(app.changed).not.toHaveBeenCalled()
  })

  it('never moves above an approval opened while the read is pending', async () => {
    const app = host()
    const pending = Promise.withResolvers<PreparedVisual>()
    const read = openVisual(stub<VisualHost>(app), visual.path, () => pending.promise)
    const approval = stubOverlay('approval', { modal: true })
    app.open(approval)
    pending.resolve(visual)
    await read
    expect(app.overlays.at(-1)).toBe(approval)
    expect(app.overlays).toHaveLength(2)
  })

  it('expires already-loaded links on observed branch and transcript replacements', async () => {
    const app = host()
    await openVisual(stub<VisualHost>(app), visual.path, async () => visual)
    const overlay = must(app.overlays[0])
    app.session.info.branch = 'other'
    expect(rendered(overlay)).toContain('changed')
    app.session.info.branch = 'main'
    expect(rendered(overlay)).not.toContain(visual.href)
    await openVisual(stub<VisualHost>(app), visual.path, async () => visual)
    app.transcript.entries = []
    expect(rendered(must(app.overlays[0]))).not.toContain(visual.href)
  })
})

describe('OpenUI /visual terminal-result discovery', () => {
  it('lists candidates without reading files; Enter validates the chosen file', async () => {
    const app = host()
    const load = vi.fn(async () => visual)
    await openVisualPicker(stub<VisualPickerHost>(app), '', load)
    const picker = must(app.overlays[0])
    expect(rendered(picker)).toContain('Recent visual candidates')
    expect(rendered(picker)).toContain('not validated')
    expect(load).not.toHaveBeenCalled()
    picker.onKey(key('enter'))
    await tick()
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith(visual.path, scope, expect.any(AbortSignal))
    expect(rendered(must(app.overlays[0]))).toContain(visual.href)
  })

  it('rejects a valid file swapped under a previously reported identity', async () => {
    const app = host()
    await openVisualPicker(stub<VisualPickerHost>(app), '', async () => ({ ...visual, id: 'b'.repeat(64) }))
    must(app.overlays[0]).onKey(key('enter'))
    await tick()
    expect(rendered(must(app.overlays[0]))).toContain('no longer matches')
    expect(rendered(must(app.overlays[0]))).not.toContain(visual.href)
  })

  it('ignores stale picker actions after replacement, approval or transcript clear', async () => {
    const app = host()
    const load = vi.fn(async () => visual)
    await openVisualPicker(stub<VisualPickerHost>(app), '', load)
    const stale = must(app.overlays[0])
    await openVisualPicker(stub<VisualPickerHost>(app), '', load)
    stale.onKey(key('enter'))
    await tick()
    expect(load).not.toHaveBeenCalled()

    const picker = must(app.overlays[0])
    app.open(stubOverlay('approval', { modal: true }))
    picker.onKey(key('enter'))
    await tick()
    expect(load).not.toHaveBeenCalled()

    app.close(must(app.overlays.at(-1)))
    app.transcript.entries = []
    expect(rendered(picker)).toContain('transcript changed')
    picker.onKey(key('enter'))
    await tick()
    expect(load).not.toHaveBeenCalled()
  })

  it('Escape cancels a selected read and never resurrects its preview', async () => {
    const app = host()
    const pending = Promise.withResolvers<PreparedVisual>()
    let signal: AbortSignal | undefined
    await openVisualPicker(stub<VisualPickerHost>(app), '', (_path, _scope, abort) => {
      signal = abort

      return pending.promise
    })
    must(app.overlays[0]).onKey(key('enter'))
    must(app.overlays[0]).onKey(key('escape'))
    expect(signal?.aborted).toBe(true)
    pending.resolve(visual)
    await tick()
    expect(app.overlays).toHaveLength(0)
  })
})
