// MCP/SSH reports are read-only backend snapshots in a modal Tern sheet.
import type { NodeJson } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from '../clipboard.js'
import { localCommand } from '../commands/local.js'
import { OperationalSheets } from '../operations.js'
import { operationalText, operationalView } from '../reports.js'
import type { OperationalReport, OperationalView } from '../wire/side.js'

import { key, must, stubOverlay, tree } from './fakes.js'
import { sideSetup } from './sideSetup.js'

vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))

beforeEach(() => vi.mocked(copyToClipboard).mockClear())

function result(view: OperationalView = 'mcp-list'): OperationalReport {
  return { view, scope: 'owned-profile', state: 'ready', read_only: true, rows: [], message: 'Read-only Hermes inventory.' }
}

function walk(n: NodeJson): NodeJson[] {
  return [n, ...(n.c ?? []).flatMap(walk)]
}

function props(overlay: ReturnType<typeof sideSetup>['overlays'][number], role: string) {
  return walk(tree(overlay.node('layer.overlay-1'))).filter(n => n.p?.['role'] === role).map(n => n.p)
}

describe('read-only operational routes', () => {
  it.each([
    ['mcp', '', 'mcp-list'],
    ['mcp', 'list', 'mcp-list'],
    ['mcp', 'status', 'mcp-status'],
    ['mcp', 'tools', 'mcp-tools'],
    ['mcp', 'catalog', 'mcp-catalog'],
    ['ssh', '', 'ssh-list'],
    ['ssh', 'list', 'ssh-list']
  ] satisfies [string, string, OperationalView][])('%s %s calls the exactly scoped report read', async (service, arg, view) => {
    const f = sideSetup()
    const operations = new OperationalSheets(f.host)
    f.gw.handlers.set('hermes-tern.operations.report', () => result(view))
    const command = must(localCommand(service))
    await command.run({ ...f.host, operations }, arg)
    await vi.waitFor(() => expect(props(must(f.overlays.at(-1)), 'omp.report.state')[0]?.['text']).toBe('ready'))
    expect(f.gw.sent('hermes-tern.operations.report')).toEqual([{ session_id: 's1', view }])
    expect(f.gw.methods('slash.exec')).toHaveLength(0)
    expect(props(must(f.overlays.at(-1)), 'omp.report.scope')[0]?.['text']).toBe('Hermes profile: owned-profile · Read only')
  })

  it.each(['mcp reload', 'mcp auth inert-secret', 'mcp add name', 'mcp reconnect name', 'ssh remove host', 'ssh auth inert-secret'])(
    'never sends management or displays secret arguments for %s',
    async full => {
      const f = sideSetup()
      const ops = new OperationalSheets(f.host)
      const [service, ...args] = full.split(' ')
      await must(localCommand(must(service))).run({ ...f.host, operations: ops }, args.join(' '))
      const sheet = must(f.overlays.at(-1))
      expect(props(sheet, 'omp.report.state')[0]?.['text']).toBe('unsupported')
      expect(JSON.stringify(tree(sheet.node('layer.overlay-1')))).toContain('No command or mutation was sent')
      expect(JSON.stringify(tree(sheet.node('layer.overlay-1')))).not.toContain('inert-secret')
      expect(f.gw.calls).toEqual([])
      expect(operationalView(must(service), args.join(' '))).toBeUndefined()
    }
  )

  it('escapes untrusted inventory Markdown and never invents empty rows while unavailable', () => {
    const report = { ...result('mcp-tools'), rows: [{ name: '[server](https://secret)', details: ['key=x*', 'one\nnext'] }] }
    const content = operationalText(report)
    expect(content).toContain('\\[server\\]\\(https://secret\\)')
    expect(content).toContain('key=x\\*')
    expect(content).toContain('one next')
    expect(operationalText({ ...result('ssh-list'), state: 'unavailable' })).not.toContain('No SSH hosts configured')
    expect(operationalText(result('ssh-list'))).toContain('No SSH hosts configured')
  })

  it('exposes loading, then generic unavailable on errors without printing auth data', async () => {
    const f = sideSetup()
    const ops = new OperationalSheets(f.host)
    const pending = Promise.withResolvers<unknown>()
    f.gw.handlers.set('hermes-tern.operations.report', () => pending.promise)
    ops.show('mcp', 'status')
    expect(props(must(f.overlays.at(-1)), 'omp.report.state')[0]?.['text']).toBe('loading')
    pending.reject(new Error('Authorization: Bearer inert-secret-fixture'))
    await vi.waitFor(() => expect(props(must(f.overlays.at(-1)), 'omp.report.state')[0]?.['text']).toBe('unavailable'))
    expect(JSON.stringify(tree(must(f.overlays.at(-1)).node('layer.overlay-1')))).not.toContain('inert-secret-fixture')
  })

  it('copies exactly the read-only body and scrolls only its own sheet', async () => {
    const f = sideSetup()
    const ops = new OperationalSheets(f.host)
    const report = { ...result('mcp-tools'), rows: Array.from({ length: 300 }, (_, i) => ({
      name: 'tool-' + i, details: ['cached only']
    })) }
    f.gw.handlers.set('hermes-tern.operations.report', () => report)
    ops.show('mcp', 'tools')
    const sheet = must(f.overlays.at(-1))
    await vi.waitFor(() => expect(props(sheet, 'omp.report.state')[0]?.['text']).toBe('ready'))
    const content = props(sheet, 'omp.report.body')[0]?.['text']
    expect(content).toContain('tool\\-299')
    sheet.onKey(key('page_down'))
    expect(f.scroll).toHaveBeenCalledWith('layer.overlay-1.body.markdown', 'page-down')
    sheet.onKey(key('c'))
    expect(copyToClipboard).toHaveBeenCalledWith(content)
  })

  it('ignores older-session, replaced and dismissed reports, including callbacks under an approval', async () => {
    const f = sideSetup()
    const ops = new OperationalSheets(f.host)
    const replies = [
      Promise.withResolvers<unknown>(),
      Promise.withResolvers<unknown>(),
      Promise.withResolvers<unknown>()
    ]
    let next = 0
    f.gw.handlers.set('hermes-tern.operations.report', () => replies[next++]?.promise)
    ops.show('mcp', 'list')
    const first = must(f.overlays.at(-1))
    ops.show('mcp', 'status')
    const second = must(f.overlays.at(-1))
    replies[0]?.resolve({ ...result('mcp-list'), rows: [{ name: 'private-old', details: [] }] })
    replies[1]?.resolve(result('mcp-status'))
    await vi.waitFor(() => expect(props(second, 'omp.report.state')[0]?.['text']).toBe('ready'))
    expect(JSON.stringify(tree(second.node('layer.overlay-1')))).not.toContain('private-old')
    f.open(stubOverlay('approval', { modal: true }))
    first.onKey(key('c'))
    second.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    f.close(must(f.overlays.at(-1)))
    ops.show('ssh', 'list')
    const third = must(f.overlays.at(-1))
    f.close(third)
    replies[2]?.resolve({ ...result('ssh-list'), rows: [{ name: 'secret-old', details: [] }] })
    await Promise.resolve()
    expect(f.overlays).toEqual([])
    f.session.ref.live = 's2'
    ops.adopt('s2')
    expect(f.overlays).toEqual([])
  })

  it('rejects mismatched responses rather than presenting a different view as a valid report', async () => {
    const f = sideSetup()
    const ops = new OperationalSheets(f.host)
    f.gw.handlers.set('hermes-tern.operations.report', () => result('ssh-list'))
    ops.show('mcp', 'tools')
    await vi.waitFor(() => expect(props(must(f.overlays.at(-1)), 'omp.report.state')[0]?.['text']).toBe('unavailable'))
    expect(props(must(f.overlays.at(-1)), 'omp.report.body')[0]?.['text']).toContain('service is unavailable')
  })
})
