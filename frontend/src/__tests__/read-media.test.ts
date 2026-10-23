import { describe, expect, it } from 'vitest'

import { mediaFamily, localMediaPath, projectToolMedia, readMedia, type MediaContext } from '../read-media.js'
import { hasNativeMedia, mediaNode } from '../tern-media.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'

import { fakeTern, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const local: MediaContext = { cwd: '/project', local: true, native: true, remoteHost: 'frontend' }
const remote: MediaContext = { cwd: '/project', local: false, native: true, remoteHost: 'gateway' }
const all = (root: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
  [root, ...(root.c ?? []).flatMap(all)]

describe('native media projection', () => {
  it('uses the SDK wire props without an invented MIME/blob/revision', () => {
    expect(mediaNode({ path: '/project/world.glb', rev: 'HEAD', link: 'compare' }).toJSON()).toEqual({
      k: 'media', p: { key: 'media', path: '/project/world.glb', rev: 'HEAD', link: 'compare' }
    })
    expect(hasNativeMedia(fakeTern().session)).toBe(false)
  })

  it.each(['png', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'mp4', 'webm', 'mov', 'glb', 'gltf', 'obj', 'usd', 'usda', 'usdc', 'usdz'])(
    'projects a completed .%s read into native media when negotiated', extension => {
      const path = 'document.' + extension
      const result = projectToolMedia(call('read_file', { path }), local)
      expect(result?.kind).toBe('node')

      if (result?.kind === 'node') {
        expect(result.node.toJSON()).toEqual({ k: 'media', p: { key: 'media', path: '/project/' + path } })
      }
    }
  )

  it('falls back to a local image only when native media is absent', () => {
    expect(readMedia('a.png', '/project', 'image/png', false, true)?.toJSON()).toEqual({
      k: 'image', p: { alt: 'a.png', key: 'media', path: '/project/a.png' }
    })
    expect(readMedia('a.pdf', '/project', 'application/pdf', false, true)).toBeUndefined()
    expect(readMedia('a.mp4', '/project', 'video/mp4', true, false)).toBeUndefined()
  })

  it.each([
    ['a.png', 'image/png; charset=binary', 'image'],
    ['a.pdf', 'application/octet-stream', 'pdf'],
    ['a.usda', 'text/plain', 'model'],
    ['a.usdz', 'model/vnd.usdz+zip', 'model'],
    ['a.mp4', 'video/mp4', 'video'],
    ['a.pdf', 'text/plain', undefined],
    ['a.png', 'application/pdf', undefined],
    ['a.glb', 'text/html', undefined],
    ['file.unknown', 'application/pdf', undefined]
  ])('rejects contradictory file suffix / MIME: %s, %s', (path, mime, expected) => {
    expect(mediaFamily(path, mime)).toBe(expected)
  })

  it('rejects schemes, network paths, implicit cwd and control characters', () => {
    expect(localMediaPath('image.png', undefined)).toBeUndefined()
    expect(localMediaPath('image.png', 'relative/cwd')).toBeUndefined()

    for (const path of ['https://x/a.png', 'file:///tmp/a.png', '//evil/a.png', 'x\0.pdf', 'x\n.pdf', '']) {
      expect(localMediaPath(path, '/project')).toBeUndefined()
    }

    expect(localMediaPath('renders/model.glb', '/project')).toBe('/project/renders/model.glb')
  })

  it('never promotes running, failed, partial or contradictory reads', () => {
    const candidates = [
      call('read_file', { path: 'a.pdf' }, { outcome: { kind: 'running' } }),
      call('read_file', { path: 'a.pdf' }, { outcome: { duration: 4, kind: 'error' } }),
      call('read_file', { path: 'a.pdf' }, { result: { partial: true } }),
      call('read_file', { path: 'a.pdf' }, { result: { mime: 'text/plain' } })
    ]

    expect(candidates.map(c => projectToolMedia(c, local))).toEqual(candidates.map(() => undefined))
  })

  it('refuses remote PDF/video/3D/non-raster preview paths', () => {
    const names = ['a.pdf', 'a.mp4', 'a.glb', 'a.svg', 'a.avif']
    const plans = names.map(path => projectToolMedia(call('read_file', { path }), remote))

    expect(plans.map(plan => plan?.kind)).toEqual(names.map(() => 'unsupported'))
    expect(readMedia('/gateway/a.glb', '/gateway', undefined, true, false)).toBeUndefined()
  })

  it('binds remote image reads to the exact completed call, and blocks compute paths', () => {
    const c = call('read_file', { path: '/gateway/photo.png' })
    expect(projectToolMedia(c, remote)).toEqual({
      kind: 'remote-image',
      source: { host: 'gateway', id: String(c.id), kind: 'path', mime: undefined, path: '/gateway/photo.png', toolCallId: String(c.id) }
    })
    expect(projectToolMedia(c, { ...remote, remoteHost: 'compute' }))
      .toMatchObject({ family: 'image', kind: 'unsupported' })
  })
})

describe('confirmed file write projections', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>λ</text></svg>'
  const mermaid = 'graph TD\n A[Start] --> B[Done]'
  const verified = (source: string) => ({ bytes_written: Buffer.byteLength(source, 'utf8'), verified: true })

  it.each([
    ['art.svg', svg, 'svg'],
    ['diagram.mmd', mermaid, 'mermaid'],
    ['diagram.mermaid', mermaid, 'mermaid']
  ])('shows confirmed %s through a native Markdown fence', (path, source, language) => {
    const plan = projectToolMedia(call('write_file', { content: source, path }, { result: verified(source) }), remote)

    expect(plan?.kind).toBe('node')

    if (plan?.kind === 'node') {
      expect(plan.node.toJSON()).toMatchObject({
        k: 'md', p: { role: 'omp.tool.write.figure', text: '\x60\x60\x60' + language + '\n' + source + '\n\x60\x60\x60' }
      })
    }
  })

  it('contains inner code fences; no generated code is evaluated', () => {
    const source = svg + '\n\x60\x60\x60js\nalert(1)\n\x60\x60\x60'
    const plan = projectToolMedia(call('write_file', { path: 'figure.svg', content: source }, { result: verified(source) }), local)

    expect(plan?.kind).toBe('node')

    if (plan?.kind === 'node') {
      expect(plan.node.toJSON()).toMatchObject({
        k: 'md', p: { text: '\x60\x60\x60\x60svg\n' + source + '\n\x60\x60\x60\x60' }
      })
    }
  })

  it('requires verified exact UTF-8 byte counts, complete writes and compatible MIME', () => {
    const calls = [
      call('write_file', { path: 'a.svg', content: svg }),
      call('write_file', { path: 'a.svg', content: svg }, { result: { ...verified(svg), bytes_written: 1 } }),
      call('write_file', { path: 'a.svg', content: svg }, { result: { ...verified(svg), truncated: true } }),
      call('write_file', { path: 'a.svg', content: svg }, { result: { ...verified(svg), partial: true } }),
      call('write_file', { path: 'a.svg', content: svg }, { result: { ...verified(svg), verified: false } }),
      call('write_file', { path: 'a.svg', content: svg }, { result: { ...verified(svg), mime: 'image/png' } })
    ]

    expect(calls.map(c => projectToolMedia(c, local))).toEqual(calls.map(() => undefined))
  })

  it('only renders local models with negotiated native media; uses result-resolved path', () => {
    const c = call('write_file', { path: 'a.glb', content: 'glTF' }, {
      result: { ...verified('glTF'), mime: 'model/gltf-binary', resolved_path: '/actual/a.glb' }
    })

    const plan = projectToolMedia(c, local)
    expect(plan?.kind).toBe('node')

    if (plan?.kind === 'node') {
      expect(plan.node.toJSON().p?.['path']).toBe('/actual/a.glb')
      expect(plan.node.toJSON().p?.['rev']).toBeUndefined()
    }

    expect(projectToolMedia(c, { ...local, native: false })).toBeUndefined()
    expect(projectToolMedia(c, remote)).toMatchObject({ family: 'model', kind: 'unsupported' })
  })
})

describe('no regression in existing cards', () => {
  it('retains numbered read source with no preview service supplied', () => {
    const c = call('read_file', { path: 'a.ts' }, { result: { content: '  1|hello', total_lines: 1 } })
    expect(all(tree(toolNode(c, 0))).some(node => node.k === 'code')).toBe(true)
    expect(all(tree(toolNode(c, 0))).some(node => node.k === 'media')).toBe(false)
  })

  it('retains original written code when no preview service is supplied', () => {
    const c = call('write_file', { path: 'a.svg', content: '<svg />' }, { result: { verified: true, bytes_written: 7 } })
    expect(toolDetail(c, 0).map(tree).some(n => n.k === 'code')).toBe(true)
  })
})
