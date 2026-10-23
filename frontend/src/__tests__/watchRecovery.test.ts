// Watch pane recovery and native dispatch through actual @stencil-hq/tern@0.1.0.
// No synthetic ACK, mock Surface, or claimed native Tern loss-injection evidence.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Session, type Surface } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import type { SettingsSource } from '../settings.js'
import { INPUT_ID } from '../surface/host.js'
import { WatchApp } from '../watch/watchApp.js'
import type { WatchSpec } from '../watch/spec.js'

import { FakeGateway, must } from './fakes.js'
import { Peer } from './surfacePeer.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function painted() {
  for (let i = 0; i < 8; i++) {
    await turn()
  }
}

interface Harness {
  readonly watch: WatchApp
  readonly tern: Session
  readonly peer: Peer
  readonly gw: FakeGateway
  readonly running: Promise<number>
  surface(): Surface
  event(body: Record<string, unknown>): Promise<void>
  ack(sf: string, sequence: number): Promise<void>
}

async function withWatch(check: (h: Harness) => Promise<void>, credits = 64) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-watch-recovery-'))
  const previous = process.env['HERMES_HOME']
  process.env['HERMES_HOME'] = home
  const input = new EventEmitter()
  const peer = new Peer()
  const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
  const handshake = tern.handshake()
  input.emit('data', '\x1b_tsp;r;' + JSON.stringify({
    ...tern.caps, r: 'hello', v: 1, term: 'strict-watch-peer', ver: '0',
    features: [], credits, apc: 1048576
  }) + '\x1b\\')

  let running: Promise<number> | undefined
  try {
    expect(await handshake).toBe(true)
    const gw = new FakeGateway({
      replies: {
        'subagent.list': () => ({ subagents: [{ subagent_id: 'agent-1', accepting_steer: true }] }),
        'subagent.steer': () => ({ status: 'queued' }),
        'subagent.interrupt': () => ({ found: true })
      }
    })
    const spec: WatchSpec = {
      sid: liveSessionId('parent-1'), subagent: 'agent-1', name: 'Research',
      goal: 'Review changes', index: 0, startedAt: Date.now()
    }
    const settings: SettingsSource = { load: () => ({ theme: 'tern' }), save: patch => patch }
    const watch = new WatchApp(tern, gw.client, spec, settings)
    running = watch.run()
    gw.event({ type: 'gateway.ready', payload: {} })
    await painted()
    const harness: Harness = {
      watch, tern, gw, peer, running,
      surface: () => must(tern.surfaces[0], 'active real Tern Surface'),
      event: async body => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify(body) + '\x1b\\')
        await painted()
      },
      ack: async (sf, s) => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify({ ev: 'ack', sf, s }) + '\x1b\\')
        await painted()
      }
    }
    await check(harness)
  } finally {
    await tern.close()
    if (running) {
      await running
    }
    if (previous === undefined) {
      delete process.env['HERMES_HOME']
    } else {
      process.env['HERMES_HOME'] = previous
    }
    rmSync(home, { recursive: true, force: true })
  }
}

function sendButton(peer: Peer, sf: string): string {
  const nodes = must(peer.documents.get(sf), 'current TSP document')
  return must([...nodes.keys()].find(id => id.endsWith('.composer.bar.send')), 'native Send action')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WatchApp public SDK document and gesture recovery', () => {
  it('routes native edit/send/action, rejects held old buttons and preserves unsent draft on whole replacement', async () => {
    await withWatch(async h => {
      const old = h.surface()
      expect(h.peer.documents.get(old.id)?.has(INPUT_ID)).toBe(true)
      const nativeSend = sendButton(h.peer, old.id)
      await h.event({ ev: 'edit', sf: old.id, id: INPUT_ID, from: 0, to: 0, text: 'α', cursor: 1, len: 0 })
      expect(h.watch.composer.text).toBe('α')
      expect(h.watch.composer.cursor).toBe(1)
      await h.event({ ev: 'send', sf: old.id, id: INPUT_ID, text: 'native steer' })
      expect(h.gw.sent('subagent.steer')).toMatchObject([{ text: 'native steer', subagent_id: 'agent-1', session_id: 'parent-1' }])
      const oldAction = old.dispatch({ ev: 'action', sf: old.id, id: nativeSend, act: 'click', raw: {} })
      expect(oldAction).toBeTypeOf('function')
      h.watch.composer.set('draft kept', { cursor: 5 })
      const before = h.gw.sent('subagent.steer').length
      const other = h.gw.sent('subagent.interrupt').length
      const earlier = h.peer.palettes.at(-1)
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const next = h.surface()
      expect(next.id).toBe('hermes.recovery-1')
      expect(h.peer.documents.get(next.id)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.palettes.at(-1)).toMatchObject({ ...earlier, sf: next.id })
      expect(h.watch.composer.text).toBe('draft kept')
      expect(h.watch.composer.cursor).toBe(5)
      await oldAction?.()
      await h.event({ ev: 'action', sf: old.id, id: nativeSend, act: 'click' })
      await h.ack(old.id, old.seq)
      expect(h.gw.sent('subagent.steer')).toHaveLength(before)
      expect(h.gw.sent('subagent.interrupt')).toHaveLength(other)
      await h.event({ ev: 'action', sf: next.id, id: sendButton(h.peer, next.id), act: 'click' })
      expect(h.gw.sent('subagent.steer')).toHaveLength(before + 1)
      expect(h.gw.sent('subagent.steer').at(-1)).toMatchObject({ text: 'draft kept' })
      expect(h.watch.composer.text).toBe('')
      expect(h.peer.opened).toEqual(['hermes', 'hermes.recovery-1'])
    })
  })

  it('rebuilds a visible or hidden evicted child, preserves sibling IDs and refuses hidden native intents', async () => {
    await withWatch(async h => {
      const sf = h.surface().id
      const before = new Set(h.peer.documents.get(sf)?.keys())
      const sent = h.gw.sent('subagent.steer').length
      h.watch.composer.set('saved draft', { cursor: 3 })
      await h.event({ ev: 'visible', sf, visible: false })
      const frames = h.peer.frames.length
      await h.event({ ev: 'action', sf, id: sendButton(h.peer, sf), act: 'click' })
      h.peer.remove(sf, INPUT_ID)
      await h.event({ ev: 'gone', sf, ids: [INPUT_ID] })
      expect(h.peer.frames).toHaveLength(frames)
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(false)
      expect(h.gw.sent('subagent.steer')).toHaveLength(sent)
      await h.event({ ev: 'visible', sf, visible: true })
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(true)
      expect(h.watch.composer.text).toBe('saved draft')
      expect(h.watch.composer.cursor).toBe(3)
      for (const id of before) {
        expect(h.peer.documents.get(sf)?.has(id), 'sibling evicted: ' + id).toBe(true)
      }
      h.peer.remove(sf, INPUT_ID)
      await h.event({ ev: 'gone', sf, ids: [INPUT_ID] })
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.opened).toEqual(['hermes'])
    })
  })

  it('waits for explicit show on hidden whole loss and bounds distinct replacements to three', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withWatch(async h => {
      const first = h.surface()
      h.watch.composer.set('still here', { cursor: 4 })
      const intents = h.gw.sent('subagent.steer').length
      await h.event({ ev: 'visible', sf: first.id, visible: false })
      h.peer.remove(first.id, first.id)
      await h.event({ ev: 'gone', sf: first.id, ids: [first.id] })
      expect(h.peer.opened).toEqual(['hermes'])
      await h.event({ ev: 'visible', visible: true })
      expect(h.surface().id).toBe('hermes.recovery-1')
      expect(h.watch.composer.text).toBe('still here')
      expect(h.watch.composer.cursor).toBe(4)
      for (let i = 2; i <= 3; i++) {
        const current = h.surface()
        h.peer.remove(current.id, current.id)
        await h.event({ ev: 'gone', sf: current.id, ids: [current.id] })
        expect(h.surface().id).toBe('hermes.recovery-' + i)
      }
      const last = h.surface()
      h.peer.remove(last.id, last.id)
      await h.event({ ev: 'gone', sf: last.id, ids: [last.id] })
      const count = h.peer.frames.length
      h.watch.changed()
      await h.event({ ev: 'visible', visible: true })
      expect(h.peer.frames).toHaveLength(count)
      expect(h.peer.opened).toHaveLength(4)
      expect(h.tern.surfaces).toHaveLength(0)
      expect(diagnostic).toHaveBeenCalledTimes(1)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('recovery limit'))
      expect(h.gw.sent('subagent.steer')).toHaveLength(intents)
    })
  })

  it('fails closed on malformed real SDK event and on shutdown rejects a captured native callback', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withWatch(async h => {
      const old = h.surface()
      const nativeSend = sendButton(h.peer, old.id)
      h.watch.composer.set('do not send')
      const held = old.dispatch({ ev: 'action', sf: old.id, id: nativeSend, act: 'click', raw: {} })
      expect(held).toBeTypeOf('function')
      await h.event({ ev: 'ack', sf: old.id, s: 'malformed' })
      expect(h.tern.surfaces).toHaveLength(0)
      const frames = h.peer.frames.length
      await held?.()
      await h.event({ ev: 'action', sf: old.id, id: nativeSend, act: 'click' })
      h.watch.changed()
      await painted()
      expect(h.peer.frames).toHaveLength(frames)
      expect(h.gw.sent('subagent.steer')).toHaveLength(0)
      expect(diagnostic).toHaveBeenCalledTimes(1)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('malformed ack'))
      expect(await h.running).toBe(1)
    })
    expect(diagnostic).toHaveBeenCalledTimes(1)
  })

  it('disposes a live WatchApp before final Tern close; held handlers never reach the gateway', async () => {
    await withWatch(async h => {
      const live = h.surface()
      const held = live.dispatch({
        ev: 'action', sf: live.id, id: sendButton(h.peer, live.id), act: 'click', raw: {}
      })
      expect(held).toBeTypeOf('function')
      h.watch.composer.set('stay local')
      await h.tern.close()
      expect(await h.running).toBe(0)
      const count = h.gw.sent('subagent.steer').length
      await held?.()
      expect(h.gw.sent('subagent.steer')).toHaveLength(count)
      expect(live.closed).toBe(true)
    })
  })
})
