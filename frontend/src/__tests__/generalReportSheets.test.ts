// App-level regression checks use the actual Tern JSX Node implementation.
import { EventEmitter } from 'node:events'

import { Session, type Op } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from '../clipboard.js'
import { isReportCommand } from '../reports.js'

import { App, setup, settle } from './appSetup.js'
import { FakeGateway, given, key, must, stubOverlay, tree } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
  vi.mocked(copyToClipboard).mockReset()
})

function sheetView(app: ReturnType<typeof setup>['app']) {
  const overlay = app.overlays.find(o => o.key === 'operational')
  const root = overlay ? tree(overlay.node('layer.overlay-1')) : undefined
  const collect = (n: typeof root): NonNullable<typeof root>[] =>
    n ? [n, ...(n.c ?? []).flatMap(collect)] : []

  return { root, body: collect(root).find(n => n.p?.['role'] === 'omp.report.body')?.p?.['text'] }
}

async function command(f: ReturnType<typeof setup>, text: string) {
  await f.type(text)
  await f.press(key('enter'))
  await settle()
}

describe('native general report sheets', () => {
  it('opens notice snapshots on demand and removes them on session adoption', () => {
    const f = setup()
    f.app.stores.composer.set('unfinished', { cursor: 3 })
    f.app.stores.notices.show({ key: 'error', kind: 'sticky', level: 'error', text: 'credit access paused' })
    f.app.openNotices()
    const sheet = must(f.app.overlays.at(-1))
    expect(sheetView(f.app).body).toContain('credit access paused')
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    expect(f.app.overlays).toEqual([])
    sheet.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(f.app.stores.composer.text).toBe('unfinished')
    expect(f.app.stores.composer.cursor).toBe(3)
  })
  it.each(['/usage', '/context', '/status', '/help usage'])('%s shows exact Markdown without main transcript churn', async name => {
    const text = '# Report\n\nUnicode 🦉 **literal**\n'
    const f = setup({ 'slash.exec': () => ({ output: text }) })
    const before = [...f.app.transcript.entries]
    await command(f, name)
    expect(f.sent('slash.exec')).toEqual([{ command: name.slice(1), session_id: 's1' }])
    expect(sheetView(f.app).root?.p?.['role']).toBe('omp.overlay.report')
    expect(sheetView(f.app).body).toBe(text)
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('renders the existing native report overlay into a real SDK Session/View surface', async () => {
    const input = new EventEmitter()
    const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
    const connecting = tern.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0', credits: 64 })}\x1b\\`)
    expect(await connecting).toBe(true)

    const gw = new FakeGateway()
    const app = new App(tern, gw.client, 'fixture')
    const running = app.run()
    const surface = must(tern.surfaces[0])
    const rendered: Op[] = []
    const original = surface.send.bind(surface)

    surface.send = ops => { rendered.push(...ops); original(ops) }

    try {
      given.session(app, 's1')
      const before = [...app.transcript.entries]
      app.stores.composer.set('  draft 🦉  ', { cursor: 3 })
      app.operations.showText('/history', '# Native\n\nExact 🦉')
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
      const nodes = rendered.filter(op => op[0] === 'add' && (op[1] === 'layer' || op[1].startsWith('layer.')))
      expect(JSON.stringify(nodes)).toContain('omp.overlay.report')
      expect(JSON.stringify(nodes)).toContain('Exact 🦉')
      expect(app.transcript.entries).toEqual(before)
      app.close(must(app.overlays.at(-1)))
      expect(app.stores.composer.text).toBe('  draft 🦉  ')
      expect(app.stores.composer.cursor).toBe(3)
    } finally {
      app.quit()
      await running
    }
  })

  it('retains the existing native bare /help and does not issue slash.exec', async () => {
    const f = setup({ 'commands.catalog': () => ({ categories: [] }) })
    await command(f, '/help')
    expect(f.app.overlays.at(-1)?.key).toBe('help')
    expect(f.sent('slash.exec')).toEqual([])
  })

  it('routes local history and canonical tools.show into the one report sheet', async () => {
    const f = setup({ 'tools.show': () => ({ sections: [{ name: 'Built-ins', tools: [{ name: 'read_file' }] }], total: 1 }) })
    const before = [...f.app.transcript.entries]
    await command(f, '/history')
    expect(sheetView(f.app).body).toBe('No conversation yet.')
    f.app.close(must(f.app.overlays.at(-1)))
    await command(f, '/tools list')
    expect(f.sent('tools.show')).toEqual([{ session_id: 's1' }])
    expect(sheetView(f.app).body).toBe('[Built-ins] read_file\nTotal: 1 tools')
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('nonreport compress keeps its old panel and report-shaped output grants no authority', async () => {
    const f = setup({ 'slash.exec': () => ({ output: '# Report-ish' }) }, { canonical: false })
    await command(f, '/compress')
    expect(sheetView(f.app).root).toBeUndefined()
    expect(f.app.transcript.entries.at(-1)).toMatchObject({ kind: 'panel', title: '/compress' })
    for (const [name, arg] of [['status', 'set'], ['tools', 'disable'], ['mcp', 'reload'], ['ssh', 'remove'], ['unknown', '']]) {
      expect(isReportCommand(must(name), must(arg))).toBe(false)
    }
  })

  it('copies exact Unicode and trailing newline, not the main conversation', async () => {
    const body = '# Report\nUnicode 🦉\n'
    const f = setup({ 'slash.exec': () => ({ output: body }) })
    const before = [...f.app.transcript.entries]
    await command(f, '/usage')
    const sheet = must(f.app.overlays.at(-1))
    sheet.onKey(key('c'))
    expect(copyToClipboard).toHaveBeenCalledWith(body)
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('shows a clipboard failure only inside the native report and never alters the transcript', () => {
    const f = setup()
    const before = [...f.app.transcript.entries]
    f.app.operations.showText('/history', 'Unicode 🦉 report-only')
    vi.mocked(copyToClipboard).mockImplementationOnce(() => { throw new Error('terminal clipboard unavailable') })
    must(f.app.overlays.at(-1)).onKey(key('c'))
    const report = f.app.overlays.at(-1)
    const root = tree(must(report).node('layer.overlay-1'))
    expect(JSON.stringify(root)).toContain('Could not copy the report to the clipboard.')
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('closes with the exact main draft and caret intact; stale copy is refused', () => {
    const f = setup()
    f.app.stores.composer.set('  Unicode 🦉 unsent  ', { cursor: 5 })
    const before = [...f.app.transcript.entries]
    f.app.operations.showText('/history', 'Report only')
    const sheet = must(f.app.overlays.at(-1))
    sheet.onKey(key('escape'))
    sheet.onKey(key('c'))
    expect(f.app.overlays).toEqual([])
    expect(f.app.stores.composer.text).toBe('  Unicode 🦉 unsent  ')
    expect(f.app.stores.composer.cursor).toBe(5)
    expect(f.app.transcript.entries).toEqual(before)
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('rejects replaced, closed and adopted old report results', () => {
    const f = setup()
    const first = must(f.app.operations.begin('/usage', 's1'))
    const newer = must(f.app.operations.begin('/context', 's1'))
    expect(f.app.operations.finish(first, 'old secret')).toBe(false)
    expect(f.app.operations.finish(newer, '# current')).toBe(true)
    first.sheet.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(sheetView(f.app).body).toBe('# current')
    f.app.close(newer.sheet)
    expect(f.app.operations.finish(newer, 'late closed')).toBe(false)
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    expect(f.app.overlays).toEqual([])
  })

  it('late asynchronous slash output cannot reopen a closed native report', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    f.app.close(must(f.app.overlays.at(-1)))
    pending.resolve({ output: 'PRIVATE late' })
    await settle()
    expect(f.app.overlays).toEqual([])
    expect(JSON.stringify(f.app.transcript.entries)).not.toContain('PRIVATE late')
  })

  it('rejects an in-flight report after session adoption instead of showing private output', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    pending.resolve({ output: 'OTHER SESSION PRIVATE' })
    await settle()
    expect(f.app.overlays).toEqual([])
    expect(JSON.stringify(f.app.transcript.entries)).not.toContain('OTHER SESSION PRIVATE')
  })

  it('a later approval remains topmost and blocks stale copy', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    const report = must(f.app.overlays.at(-1))
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    pending.resolve({ output: 'report under approval' })
    await settle()
    expect(f.app.overlays.at(-1)).toBe(approval)
    report.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    f.app.close(approval)
    expect(sheetView(f.app).body).toBe('report under approval')
  })

  it('pre-existing approval preempts a new report', () => {
    const f = setup()
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    expect(f.app.operations.begin('/usage', 's1')).toBeUndefined()
    expect(f.app.overlays).toEqual([approval])
  })
})
