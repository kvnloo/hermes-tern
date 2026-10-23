// Typed Hermes LSP payloads through the plugin's tool-card registry, including
// stored JSON replay, malformed fallback, and Tern SDK semantic node metadata.

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { detailOf, toolKeyOf } from '../tools/detail.js'
import { parseLspResult } from '../tools/lsp-result.js'
import { hubIconOf } from '../view/tools/registry.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { actionOf, stepLabel } from '../view/workLogModel.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const base = { path: '/project/src/a.py', server: 'pyright', position_encoding: 'utf-16' }
const span = { start: { line: 2, col: 3 }, end: { line: 4, col: 5 } }
const location = (path: string) => ({ path, range: span })
const symbol = (id: string, name: string, children: unknown[] = []) => ({
  id,
  name,
  kind: 5,
  location: location(base.path),
  selection: span,
  children
})
const envelope = (result: Record<string, unknown>) => ({ lsp_result: { ...base, ...result } })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const role = (root: NodeJson, name: string): NodeJson[] => nodes(root).filter(n => n.p?.['role'] === name)
const lsp = (result: unknown, resultText?: string) => call('lsp', { operation: 'references', path: 'src/a.py' }, {
  result,
  ...(resultText === undefined ? {} : { resultText })
})

describe('LSP semantic result parsing', () => {
  it('retains cross-file locations, one-based UTF-16 ranges and checked-empty arrays', () => {
    const original = envelope({ kind: 'references', locations: [location(base.path), location('/project/src/b.py'), location(base.path)] })
    const parsed = parseLspResult(original.lsp_result)
    expect(parsed).toEqual(original.lsp_result)
    expect(parseLspResult(envelope({ kind: 'references', locations: [] }).lsp_result)).toMatchObject({ kind: 'references', locations: [] })
  })

  it('retains stable nested IDs, both ranges, and typed hover contents', () => {
    const nested = symbol('parent', 'Parent', [symbol('child', 'child')])
    expect(parseLspResult(envelope({ kind: 'symbols', symbols: [nested] }).lsp_result)).toMatchObject({ symbols: [nested] })
    expect(parseLspResult(envelope({ kind: 'hover', range: span, contents: [
      { format: 'markdown', text: '**bold**', language: null },
      { format: 'plaintext', text: '<literal>', language: null },
      { format: 'code', text: 'x = 1', language: 'python' }
    ] }).lsp_result)).toMatchObject({ kind: 'hover', range: span })
  })

  it('rejects legacy, foreign and malformed data instead of inventing results', () => {
    const malformed = [
      { text: '12 references' },
      { ...base, kind: 'references', locations: [{ path: '/project/a.py', range: { start: { line: 0, col: 1 }, end: span.end } }] },
      { ...base, kind: 'references', locations: [{ path: '/project/a.py', range: { start: span.end, end: span.start } }] },
      { ...base, kind: 'references', locations: [location(base.path), null] },
      { ...base, position_encoding: 'utf-8', kind: 'references', locations: [] },
      { ...base, server: undefined, kind: 'references', locations: [] },
      { ...base, kind: 'symbols', symbols: [symbol('same', 'A'), symbol('same', 'B')] },
      { ...base, kind: 'symbols', symbols: [symbol('outer', 'A', [symbol('outer', 'recursive ID')])] },
      { ...base, kind: 'symbols', symbols: [symbol('bad', 'A', 'not-an-array')] },
      { ...base, kind: 'symbols', symbols: [symbol('bad', 'A').children ? { ...symbol('bad', 'A'), kind: 27 } : null] },
      { ...base, kind: 'hover', contents: [{ format: 'html', text: '<b>raw</b>' }], range: null },
      { ...base, kind: 'hover', contents: [], range: undefined },
      { ...base, kind: 'error', operation: 'rename', message: 'invalid' },
      { ...base, kind: 'unavailable', operation: 'symbols', message: null }
    ]

    for (const item of malformed) {
      expect(parseLspResult(item)).toBeUndefined()
    }
  })

  it('guards overly deep symbol trees', () => {
    let child = symbol('leaf', 'Leaf')

    for (let i = 0; i < 130; i++) {
      child = symbol('n' + i, 'Nested', [child])
    }

    expect(parseLspResult(envelope({ kind: 'symbols', symbols: [child] }).lsp_result)).toBeUndefined()
  })
})

describe('LSP tool cards', () => {
  it('registers one typed detail and work-log presentation, not a model tool', () => {
    const c = lsp(envelope({ kind: 'references', locations: [] }))
    expect(toolKeyOf('lsp')).toBe('lsp')
    expect(hubIconOf('lsp')).toBe('search')
    expect(stepLabel(c)).toBe('LSP references /project/src/a.py')
    expect(actionOf(c)).toBe('code-search')
    const first = detailOf(c)
    expect(detailOf(c)).toBe(first)
    expect(first).toMatchObject({ tool: 'lsp', result: { kind: 'references', locations: [] } })
    c.result = JSON.stringify(envelope({ kind: 'references', locations: [location(base.path)] }))
    expect(detailOf(c)).toMatchObject({ result: { locations: [location(base.path)] } })
  })

  it('groups references by source file without losing duplicates or complete spans', () => {
    const c = lsp(envelope({ kind: 'references', locations: [location(base.path), location('/project/src/b.py'), location(base.path)] }))
    const root = tree(toolNode(c, 4))
    expect(root).toMatchObject({ k: 'tool', p: { name: 'lsp', title: 'LSP', status: 'done', collapsed: false } })
    expect(role(root, 'omp.tool.references.file')).toHaveLength(2)
    expect(role(root, 'omp.tool.reference').map(n => n.p?.['text'])).toEqual(['2:3–4:5', '2:3–4:5', '2:3–4:5'])
    expect(nodes(root).every(n => n.p?.['href'] === undefined)).toBe(true)
    expect(role(root, 'omp.tool.notice')[0]?.p?.['spans']).toEqual([{ s: 'muted', t: 'File targets are not verified host-local; links disabled.' }])
  })

  it('preserves nested tree IDs and full source + selection range through stored JSON replay', () => {
    const payload = envelope({ kind: 'symbols', symbols: [symbol('parent', 'Outer', [symbol('child', 'method')])] })
    const live = tree(toolNode(lsp(payload), 1))
    const stored = tree(toolNode(lsp(JSON.stringify(payload)), 2))
    const a = role(live, 'omp.tool.symbols')[0]
    const b = role(stored, 'omp.tool.symbols')[0]
    expect(b?.p?.['nodes']).toEqual(a?.p?.['nodes'])
    expect(a?.p?.['nodes']).toMatchObject([{
      id: 'parent', open: true, children: [{ id: 'child', label: [{ t: 'method' }, {}] }]
    }])
    expect(role(stored, 'omp.tool.symbol.location')).toHaveLength(2)
    expect(role(stored, 'omp.tool.symbol.location')[1]?.p?.['text']).toContain('selection 2:3–4:5')
  })

  it('honors hover Markdown, literal plaintext and language-marked code', () => {
    const root = tree(toolNode(lsp(envelope({ kind: 'hover', range: span, contents: [
      { format: 'markdown', text: '**marked**', language: null },
      { format: 'plaintext', text: '<literal>', language: null },
      { format: 'code', text: 'def f(): pass', language: 'python' }
    ] })), 5))
    expect(role(root, 'omp.tool.hover').map(n => n.k)).toEqual(['md', 'text', 'code'])
    expect(role(root, 'omp.tool.hover').map(n => n.p?.['text'])).toEqual(['**marked**', '<literal>', 'def f(): pass'])
    expect(role(root, 'omp.tool.hover')[2]?.p?.['lang']).toBe('python')
    expect(role(root, 'omp.tool.hover.range')[0]?.p?.['text']).toBe('2:3–4:5')
  })

  it.each(['references', 'symbols', 'hover'] as const)('distinguishes empty %s from error and unavailable', kind => {
    const empty = kind === 'references' ? { locations: [] } : kind === 'symbols' ? { symbols: [] } : { contents: [], range: null }
    const checked = tree(toolNode(lsp(envelope({ ...empty, kind })), 0))
    expect(role(checked, 'omp.tool.lsp.summary')[0]?.p?.['text']).toContain('(checked)')

    for (const failure of ['error', 'unavailable'] as const) {
      const root = tree(toolNode(lsp(envelope({ kind: failure, operation: kind, message: 'server not ready' })), 0))
      expect(root.p?.['status']).toBe(failure === 'error' ? 'error' : 'done')
      expect(role(root, 'omp.tool.lsp.' + failure)[0]?.p?.['text']).toBe(kind + ': server not ready')
      expect(role(root, 'omp.tool.lsp.summary')).toHaveLength(0)
    }
  })

  it('retains 250 references and very long paths instead of clipping at pane width', () => {
    const long = 'dir-with-a-long-name-'.repeat(25)
    const root = tree(toolNode(lsp(envelope({ path: '/project/' + long + '.py', kind: 'references', locations: Array.from({ length: 250 }, () => location('/project/' + long + '.py')) })), 1))
    expect(role(root, 'omp.tool.reference')).toHaveLength(250)
    expect(role(root, 'omp.tool.file').some(n => n.p?.['text'] === '/project/' + long + '.py' && n.p?.['wrap'] === 'word')).toBe(true)
  })

  it('keeps foreign or malformed semantic objects in the literal generic fallback', () => {
    for (const result of [
      { text: '12 references' },
      envelope({ kind: 'references', locations: [{ path: 'bad', range: { start: { line: -1, col: 2 }, end: span.end } }] })
    ]) {
      const root = tree(toolNode(lsp(result), 0))
      expect(role(root, 'omp.tool.reference')).toHaveLength(0)
      expect(nodes(root).find(n => n.k === 'code')?.p?.['text']).toContain(JSON.stringify(result).slice(0, 1))
    }

    const raw = '{"raw":"stored legacy result"}'
    expect(nodes(tree(toolNode(lsp({ message: 'ignored' }, raw), 0))).find(n => n.k === 'code')?.p?.['text']).toBe(raw)
  })

  it('does not strip a valid tool result from a work-group detail', () => {
    const c = lsp(envelope({ kind: 'references', locations: [location(base.path)] }))
    const body = toolDetail(c, 10).map(tree)
    expect(body.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.reference')).toHaveLength(1)
  })

  it('escapes terminal controls in displayed paths and messages', () => {
    const path = '/project/' + String.fromCharCode(27) + '[31mred.py'
    const root = tree(toolNode(lsp(envelope({ path, kind: 'unavailable', operation: 'hover', message: 'bad' + String.fromCharCode(0) + 'file' })), 0))
    const shown = JSON.stringify(root)
    expect(shown).not.toContain('\u001b')
    expect(shown).toContain('bad\\\\u0000file')
  })
})
