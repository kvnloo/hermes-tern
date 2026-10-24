import { describe, expect, it } from 'vitest'

import { artifactCard } from '../artifacts/card.js'
import { confirmedWriteArtifact, writtenArtifactNode } from '../artifacts/written.js'
import type { FileContext } from '../artifacts/links.js'
import { toolNode } from '../view/tools/shell.js'

import { must, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const local: FileContext = { cwd: '/repo', hostLocal: true, media: true }
const remote: FileContext = { cwd: '/repo', hostLocal: false, media: true }
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="5"/></svg>'

function written(path: string, source: string, result: Record<string, unknown> = {}) {
  return call('write_file', { content: source, path }, {
    result: { bytes_written: Buffer.byteLength(source, 'utf8'), resolved_path: '/repo/' + path, verified: true, ...result }
  })
}

describe('verified Hermes written artifacts', () => {
  it('promotes only a complete byte-verified SVG/Mermaid write, not streaming guesses', () => {
    const c = written('chart.svg', svg)
    const confirmed = confirmedWriteArtifact(c, '/repo', true)
    expect(confirmed).toMatchObject({ kind: 'source', language: 'svg', source: svg })

    const treeJson = tree(toolNode(c, 0, undefined, undefined, undefined, local))
    expect(treeJson.p).toMatchObject({ href: 'file:///repo/chart.svg', name: 'write', target: '/repo/chart.svg' })
    expect(treeJson.c).toEqual(expect.arrayContaining([
      expect.objectContaining({
        k: 'md',
        p: expect.objectContaining({ role: 'omp.tool.write.figure', text: '```svg\n' + svg + '\n```' })
      })
    ]))

    expect(confirmedWriteArtifact(written('flow.mmd', 'graph TD\n A-->B'), '/repo', true))
      .toMatchObject({ kind: 'source', language: 'mermaid' })

    for (const altered of [
      { verified: false }, { verified: undefined }, { bytes_written: 1 },
      { partial: true }, { truncated: true }, { error: 'denied' }, { success: false },
      { mime: 'application/x-executable' }
    ]) {
      expect(confirmedWriteArtifact(written('chart.svg', svg, altered), '/repo', true)).toBeUndefined()
    }

    expect(confirmedWriteArtifact({
      ...c, outcome: { kind: 'running' }
    }, '/repo', true)).toBeUndefined()
    expect(confirmedWriteArtifact({
      ...c, outcome: { duration: 1, kind: 'error' }
    }, '/repo', true)).toBeUndefined()
    expect(confirmedWriteArtifact(written('script.ts', svg), '/repo', true)).toBeUndefined()
  })

  it('uses native Markdown fences with enough ticks to contain generated fences', () => {
    const source = 'start ' + String.fromCharCode(96).repeat(4) + 'svg\ntext'
    const a = confirmedWriteArtifact(written('nested.svg', source), '/repo', true)
    if (!a || a.kind !== 'source') {
      throw new Error('expected confirmed source')
    }

    const body = tree(must(writtenArtifactNode(a, true)))
    expect(body.p?.['text']).toContain(String.fromCharCode(96).repeat(5) + 'svg\n')
    expect(body.p?.['text']).toContain(source)
  })

  it('only permits local 3D media with negotiated support', () => {
    const c = written('scene.glb', 'binary')
    const model = confirmedWriteArtifact(c, '/repo', true)
    expect(model).toMatchObject({ kind: 'model', path: '/repo/scene.glb' })
    if (!model) {
      throw new Error('expected model')
    }

    expect(tree(must(writtenArtifactNode(model, true)))).toMatchObject({ k: 'media', p: { path: '/repo/scene.glb' } })
    expect(writtenArtifactNode(model, false)).toBeUndefined()
    expect(confirmedWriteArtifact(c, '/repo', false)).toBeUndefined()
    expect(JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, { ...local, media: false })))).not.toContain('"k":"media"')
  })

  it('does not create host-local file hrefs for remote tool results', () => {
    const c = written('chart.svg', svg)
    const card = artifactCard(c, { body: [], name: 'write', title: 'Write' }, remote)
    expect(card.href).toBeUndefined()
    expect(JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, remote)))).not.toContain('file:///repo/')
    expect(JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, remote)))).toContain('omp.tool.write.figure')
  })

  it('adds numbered read links only from real returned row numbers', () => {
    const c = call('read_file', { path: 'a.ts' }, { result: { content: '  12|x', total_lines: 30 } })
    expect(tree(toolNode(c, 0, undefined, undefined, undefined, local)).p?.['href']).toBe('file:///repo/a.ts#L12')
    expect(tree(toolNode(c, 0, undefined, undefined, undefined, remote)).p?.['href']).toBeUndefined()
  })
})
