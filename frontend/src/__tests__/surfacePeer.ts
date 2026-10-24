// Strict document peer shared by chat and watch SDK recovery regressions.
// This is a test-only TSP model; every frame is emitted by the real pinned SDK.
import type { WireNode } from '@stencil-hq/tern'
import { expect } from 'vitest'

import { record } from '../wire/json.js'

interface Frame {
  sf: string
  s: number
  ops: readonly unknown[]
}

/** Enforces add parent/sibling existence and bans touching evicted/unknown nodes. */
export class Peer {
  readonly documents = new Map<string, Map<string, WireNode>>()
  readonly frames: Frame[] = []
  readonly opened: string[] = []
  readonly palettes: Record<string, unknown>[] = []

  remove(sf: string, id: string) {
    const nodes = this.documents.get(sf)
    if (!nodes) {
      throw new Error('missing peer document ' + sf)
    }
    const removed = nodes.get(id)
    for (const child of removed?.c ?? []) {
      this.remove(sf, child.id)
    }
    for (const nodeId of [...nodes.keys()]) {
      if (nodeId === id || nodeId.startsWith(id + '.')) {
        nodes.delete(nodeId)
      }
    }
  }

  /** Validate peer input as unknown; production wire JSON decodes at wire/json.ts. */
  private id(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('TSP peer needs a string node id')
    }
    return value
  }

  private wire(value: unknown): WireNode {
    const raw = record(value)
    if (!raw) {
      throw new Error('missing wire node object')
    }
    const id = this.id(raw['id'])
    const k = this.id(raw['k'])
    const children = raw['c']
    if (children !== undefined && !Array.isArray(children)) {
      throw new Error('invalid wire children')
    }
    const c = children?.map((child: unknown) => this.wire(child))

    return c ? { id, k, c } : { id, k }
  }

  write(bytes: Uint8Array | string) {
    for (const piece of Buffer.from(bytes).toString().split('\x1b_tsp;').slice(1)) {
      const verb = piece[0]
      if (!['o', 'f', 't'].includes(verb ?? '')) {
        continue
      }
      const body = record(piece.slice(2).split('\x1b\\')[0] ?? '{}')
      if (!body) {
        throw new Error('non-object TSP message')
      }

      if (verb === 'o') {
        const id = this.id(body['id'])
        expect(this.documents.has(id), 'duplicate document ' + id).toBe(false)
        this.opened.push(id)
        this.documents.set(id, new Map([[id, { id, k: 'col' }]]))
      } else if (verb === 't') {
        this.palettes.push(body)
      } else {
        const sf = String(body['sf'])
        const nodes = this.documents.get(sf)
        if (!nodes) {
          throw new Error('frame on absent document ' + sf)
        }
        const payload: unknown = body['ops']
        if (!Array.isArray(payload)) {
          throw new Error('frame needs an ops array')
        }
        const ops: readonly unknown[] = payload
        this.frames.push({ sf, s: Number(body['s']), ops })

        const add = (n: WireNode) => {
          expect(nodes.has(n.id), 'duplicate add ' + n.id).toBe(false)
          nodes.set(n.id, n)
          n.c?.forEach(add)
        }
        const present = (id: string, verbName: string) =>
          expect(nodes.has(id), verbName + ' targets absent node ' + sf + ':' + id).toBe(true)

        for (const item of ops) {
          if (!Array.isArray(item)) {
            throw new Error('invalid TSP op array')
          }
          const op: readonly unknown[] = item
          const name = this.id(op[0])
          const target = op.length < 2 || op[1] === null ? null : this.id(op[1])
          switch (name) {
            case 'add':
              if (target === null) { throw new Error('null add id') }
              expect(nodes.has(target), 'duplicate add ' + target).toBe(false)
              present(this.id(op[2]), 'add parent')
              if (op[3] !== null) {
                present(this.id(op[3]), 'add sibling')
              }
              const next = this.wire(op[4])
              if (next.id !== target) {
                throw new Error('add op ID and wire root differ')
              }
              add(next)
              break
            case 'del':
              if (target === null) { throw new Error('null del id') }
              present(target, 'del')
              this.remove(sf, target)
              break
            case 'move':
              if (target === null) { throw new Error('null move id') }
              present(target, 'move')
              present(this.id(op[2]), 'move parent')
              if (op[3] !== null) {
                present(this.id(op[3]), 'move sibling')
              }
              break
            case 'focus':
              if (target !== null) {
                present(target, 'focus')
              }
              break
            case 'set':
            case 'text':
            case 'splice':
            case 'settle':
            case 'scroll':
            case 'reveal':
              if (target === null) { throw new Error('null ' + name + ' id') }
              present(target, name)
              break
            case 'suspend':
            case 'resume':
              break
            default:
              throw new Error('unknown TSP operation ' + name)
          }
        }
      }
    }
  }
}

