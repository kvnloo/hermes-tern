import { describe, expect, it } from 'vitest'

import { langOf } from '../code/lang.js'
import { toolNode } from '../view/tools/shell.js'
import { decodeJson, record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const all = (root: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
  [root, ...(root.c ?? []).flatMap(all)]

describe('file language projection', () => {
  it.each(['x.constructor', 'x.__proto__', 'x.ConStrUcTor', 'x.__ProTo__', 'x.unknown', 'README'])('omits unknown extensions for %s', path => {
    expect(langOf(path)).toBeUndefined()
  })

  it('preserves known case-insensitive extensions', () => {
    expect(langOf('src/main.TS')).toBe('typescript')
    expect(langOf('src/main.py')).toBe('python')
  })

  it.each(['x.constructor', 'x.__proto__', 'x.ConStrUcTor', 'x.__ProTo__', 'x.unknown', 'x.PY'])('keeps file language props valid in read, write, patch and search nodes: %s', path => {
    const calls = [
      call('read_file', { path }, { result: { content: '1|hi' } }),
      call('write_file', { content: 'hi', path }, { result: { diff: '@@ -0,0 +1 @@\n+hi' } }),
      call('patch', { path }, { result: { diff: '@@ -1 +1 @@\n-hi\n+bye' } }),
      call('search_files', { pattern: 'hi' }, { result: { matches: [{ content: 'hi', line: 1, path }] } })
    ]
    const nodes = calls.flatMap(value => all(tree(toolNode(value, 0))))
      .filter(value => value.k === 'code' || value.k === 'diff')

    expect(nodes.map(value => value.k)).toEqual(['code', 'code', 'diff', 'code'])
    // The new-file write uses `text` when unknown; other cards omit an unknown language.
    const expected = path.endsWith('.PY') ? ['python', 'python', 'python', 'python'] : [undefined, 'text', undefined, undefined]
    expect(nodes.map(node => node.p?.['lang'])).toEqual(expected)
    const wire = nodes.map(node => record(record(decodeJson(JSON.stringify(node)))?.['p']))
    expect(wire.map(props => props?.['lang'])).toEqual(expected)
    expect(wire.map(props => props !== undefined && Object.hasOwn(props, 'lang')))
      .toEqual(expected.map(value => value !== undefined))
  })
})
