// Off-host source-equivalent TSP retention replay. Run with: bun bench/retention.ts
// Exercises real Retention, entryNode, SDK Tree/View/Op and an ACK=1 surface port;
// native Tern rendering and gateway/process time are separate acceptance gates.
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

import type { Op, Surface } from '@stencil-hq/tern'

import { entryId } from '../src/core/ids.js'
import type { Entry, TurnEntry } from '../src/model.js'
import { stub } from '../src/__tests__/fakes.js'
import { Retention } from '../src/view/retention.js'
import type { TranscriptContext } from '../src/view/transcript.js'

const DELTAS = 5_000
const RUNS = 5
const SIZES = [200, 2_000] as const
const cx: TranscriptContext = { now: 1_000, welcome: { tip: '', version: 'v1' }, copy() {} }

interface Measure {
  entries: number
  repetition: number
  coldMs: number
  coldBytes: number
  coldOps: number
  steadyP50Ms: number
  steadyP95Ms: number
  steadyBytes: number
  steadyOps: number
  examined: number
  nodeBuilds: number
  visible: number
  first: string | undefined
  last: string | undefined
}

function history(size: number): { entries: Entry[]; tail: TurnEntry } {
  const entries: Entry[] = []
  let tail: TurnEntry | undefined

  for (let i = 0; i < size / 2; i++) {
    entries.push({ at: 1, id: entryId(`u${i}`), kind: 'user', text: `Prompt ${i}` })
    tail = {
      blocks: [{ id: entryId(`x${i}`), kind: 'text', text: `Answer ${i}` }],
      end: { status: 'done', endedAt: 2 },
      id: entryId(`t${i}`),
      kind: 'turn',
      rev: 1,
      startedAt: 1
    }
    entries.push(tail)
  }

  if (!tail) {
    throw new Error('Empty benchmark history')
  }

  return { entries, tail }
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)

  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0
}

function replay(size: number, repetition: number): Measure {
  const { entries, tail } = history(size)
  const changed = new Set<Entry>()
  const visible = new Set<string>()
  let outstanding = false
  let bytes = 0
  let opsCount = 0

  const surface = stub<Surface>({
    id: 'hermes',
    closed: false,
    get blocked() { return outstanding },
    dispatch: () => undefined,
    acknowledge: () => { outstanding = false },
    send: (ops: Op[]) => {
      if (outstanding) {
        throw new Error('Surface.send without an ACK credit')
      }
      outstanding = true
      bytes += Buffer.byteLength(JSON.stringify(ops))
      opsCount += ops.length
      for (const op of ops) {
        if (op[0] === 'add') {
          visible.add(op[1])
        } else if (op[0] === 'del') {
          visible.delete(op[1])
        }
      }
    }
  })

  const retention = new Retention(surface, () => undefined, () => ({ entries, lifetime: 0 }))
  const chrome = { dock: [], layer: [] }
  const coldStart = performance.now()
  retention.paint(chrome, entries, cx, false, changed)
  const coldMs = performance.now() - coldStart
  const coldBytes = bytes
  const coldOps = opsCount

  // Completing/starting a turn is a boundary transition and excluded from steady timing.
  surface.acknowledge(0)
  tail.end = { status: 'live' }
  tail.rev++
  changed.add(tail)
  retention.paint(chrome, entries, cx, false, changed)
  surface.acknowledge(1)

  const startBytes = bytes
  const startOps = opsCount
  const samples: number[] = []
  let examined = 0
  let nodeBuilds = 0
  for (let i = 0; i < DELTAS; i++) {
    const block = tail.blocks[0]
    if (block?.kind !== 'text') {
      throw new Error('Missing streaming block')
    }

    block.text += 'x'
    tail.rev++
    changed.add(tail)
    const start = performance.now()
    retention.paint(chrome, entries, cx, false, changed)
    samples.push(performance.now() - start)
    examined += retention.work.examined
    nodeBuilds += retention.work.nodeBuilds
    surface.acknowledge(i + 2) // Exactly one ACK for each emitted frame, both sizes.
  }

  const ids = [...visible].filter(id => id.startsWith('main.u') || id.startsWith('main.t')).sort()
  if (ids.length !== size || examined !== DELTAS || nodeBuilds !== DELTAS) {
    throw new Error(`Retention invariant failed: size=${size}, visible=${ids.length}, examined=${examined}, built=${nodeBuilds}`)
  }

  return {
    entries: size, repetition,
    coldMs, coldBytes, coldOps,
    steadyP50Ms: percentile(samples, 0.5),
    steadyP95Ms: percentile(samples, 0.95),
    steadyBytes: bytes - startBytes,
    steadyOps: opsCount - startOps,
    examined, nodeBuilds,
    visible: ids.length, first: ids[0], last: ids.at(-1)
  }
}

const runs: Measure[] = []
for (let i = 0; i < RUNS; i++) {
  // Interleave cold/steady experiments and reverse each second pair to limit
  // run-order, JIT and thermal bias. Each scenario gets a new writer/surface.
  for (const size of i % 2 ? [...SIZES].reverse() : SIZES) {
    runs.push(replay(size, i + 1))
  }
}

const summary = SIZES.map(size => {
  const items = runs.filter(r => r.entries === size)
  return {
    entries: size,
    coldP95Ms: percentile(items.map(r => r.coldMs), 0.95),
    coldBytes: items.map(r => r.coldBytes),
    coldOps: items.map(r => r.coldOps),
    steadyP50Ms: percentile(items.map(r => r.steadyP50Ms), 0.5),
    steadyP95Ms: percentile(items.map(r => r.steadyP95Ms), 0.95),
    steadyBytes: items.map(r => r.steadyBytes),
    steadyOps: items.map(r => r.steadyOps),
    examined: items.map(r => r.examined),
    nodeBuilds: items.map(r => r.nodeBuilds),
    visible: items.map(r => r.visible),
    first: items[0]?.first,
    last: items[0]?.last
  }
})

const baseline = summary[0]
const large = summary[1]
if (!baseline || !large) {
  throw new Error('Missing comparison cases')
}
const ratio = large.steadyP95Ms / baseline.steadyP95Ms
const pass = Number.isFinite(ratio) && ratio <= 1.5
console.log(JSON.stringify({ kind: 'off-host-source-equivalent', deltasPerRun: DELTAS,
  runsPerSize: RUNS, ackCadence: 'one ACK per emitted frame, credit=1',
  interleaved: true, cases: summary,
  gate: { expression: '2000-entry steady p95 <= 1.5 * 200-entry steady p95', ratio, pass } }, null, 2))
if (!pass) {
  process.exitCode = 1
}
