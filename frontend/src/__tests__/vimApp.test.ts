import { readFile, writeFile } from 'node:fs/promises'

import type { Key, Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { editExternal, type DraftOpener } from '../draft/external-editor.js'

import { App } from './appSetup.js'
import { FakeGateway, fakeTern, given, key, topNodes } from './fakes.js'

function findEditor(nodes: readonly Node[]): Node {
  const editor = search(nodes)
  if (!editor) throw new Error('No native editor in Tern dock')
  return editor
}

function search(nodes: readonly Node[]): Node | undefined {
  for (const n of nodes) {
    if (n.kind === 'editor') return n
    const next = search(n.children)
    if (next) return next
  }
  return undefined
}

/** Keep the real App key dispatcher; only replace its OS editor opener with a fixture. */
function fixtureEditor(opener: DraftOpener) {
  const done = Promise.withResolvers<void>()
  const spy = vi.spyOn(App.prototype, 'editExternal').mockImplementation(function (this: InstanceType<typeof App>) {
    return editExternal({
      composer: this.stores.composer,
      sid: () => this.session.ref.live,
      changed: () => this.changed(),
      notice: (text, tone) => this.notice(text, tone),
      panel: (title, text) => this.transcript.panel(title, text)
    }, opener).finally(() => done.resolve())
  })
  return { finished: done.promise, spy }
}

async function appPress(tern: ReturnType<typeof fakeTern>, k: Key) {
  await vi.waitFor(() => expect(tern.reading).toBe(true))
  tern.press(k)
  await vi.waitFor(() => expect(tern.reading).toBe(true))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('Vim composer plugged into the actual app and native Tern dock', () => {
  it('opens an unsent draft with Ctrl+G through App and retains the caret and undo', async () => {
    const opener = vi.fn(async (file: string) => {
      expect(await readFile(file, 'utf8')).toBe('draft before')
      await writeFile(file, 'draft after')
    })
    const { finished, spy } = fixtureEditor(opener)
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')
    app.stores.composer.set('draft before', { cursor: 3 })
    try {
      await appPress(tern, key('g', { ctrl: true }))
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      await finished
      expect(opener).toHaveBeenCalledOnce()
      expect(app.stores.composer.text).toBe('draft after')
      expect(app.stores.composer.cursor).toBe(3)
      expect(gw.sent('prompt.submit')).toHaveLength(0)
      app.stores.composer.undo()
      expect(app.stores.composer.text).toBe('draft before')
      expect(app.stores.composer.cursor).toBe(3)
    } finally {
      app.quit()
      await running
      spy.mockRestore()
    }
  })

  it('preserves pasted {!cmd} through an unchanged editor transaction and never requests shell.exec', async () => {
    const untrusted = '{!echo should-not-execute}'
    const opener = vi.fn(async (file: string) => {
      expect(await readFile(file, 'utf8')).toBe(untrusted)
    })
    const { finished, spy } = fixtureEditor(opener)
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')
    app.stores.composer.paste(untrusted)
    try {
      await appPress(tern, key('g', { ctrl: true }))
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      await finished
      expect(app.stores.composer.pasted).toContain(untrusted)
      await appPress(tern, key('enter'))
      await vi.waitFor(() => expect(gw.sent('prompt.submit')).toHaveLength(1))
      expect(gw.sent('prompt.submit')[0]?.['text']).toBe(untrusted)
      expect(gw.sent('shell.exec')).toHaveLength(0)
    } finally {
      app.quit()
      await running
      spy.mockRestore()
    }
  })

  it('does not promote directives newly written by an external editor to shell instructions', async () => {
    const untrusted = ['!echo unsafe', '{!echo unsafe}'].join('\n')
    const opener = vi.fn(async (file: string) => { await writeFile(file, untrusted) })
    const { finished, spy } = fixtureEditor(opener)
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')
    app.stores.composer.set('safe')
    try {
      await appPress(tern, key('g', { ctrl: true }))
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
      await finished
      expect(app.stores.composer.pasted).toContain(untrusted)
      await appPress(tern, key('enter'))
      await vi.waitFor(() => expect(gw.sent('prompt.submit')).toHaveLength(1))
      expect(gw.sent('prompt.submit')[0]?.['text']).toBe(untrusted)
      expect(gw.sent('shell.exec')).toHaveLength(0)
    } finally {
      app.quit()
      await running
      spy.mockRestore()
    }
  })

  it('routes modal input after overlay ownership and blocks native edit/send/undo until disabled', async () => {
    const gw = new FakeGateway({ replies: {
      'config.get': () => ({ config: { display: { vim_mode: true } } })
    } })
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')
    const press = async (name: string, text?: string) => {
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(key(name, text === undefined ? {} : { text }))
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const editor = () => findEditor(topNodes(tern.region('dock')))

    try {
      expect(editor().props['mode']).toBeUndefined()
      await app.stores.vimPreference.refresh()
      expect(app.stores.composer.vim.enabled).toBe(true)
      app.stores.composer.set('abc', { cursor: 0 })
      app.changed()
      await new Promise<void>(resolve => setImmediate(resolve))
      await press('escape')
      expect(app.stores.composer.vim.mode).toBe('normal')
      expect(editor().props['mode']).toBe('normal')
      expect(editor().props['sendable']).toBe(false)
      await press('v', 'v')
      await press('l', 'l')
      expect(editor().props['mode']).toBe('visual')
      expect(editor().props['sendable']).toBe(false)
      expect(editor().props['anchor']).toBe(0)
      expect(editor().props['cursor']).toBe(2)

      const before = app.stores.composer.text
      const edit = editor().handlers?.onEdit
      const send = editor().handlers?.onSend
      const undo = editor().handlers?.onUndo
      expect(edit).toBeTypeOf('function')
      expect(send).toBeTypeOf('function')
      expect(undo).toBeTypeOf('function')
      if (typeof edit === 'function') edit({ ev: 'edit', sf: 'hermes', id: 'dock.composer.line.input', raw: {}, from: 0, to: 3, text: 'bad', cursor: 3, len: 3 })
      if (typeof send === 'function') send({ ev: 'send', sf: 'hermes', id: 'dock.composer.line.input', raw: {}, text: 'competing submit' })
      if (typeof undo === 'function') undo({ ev: 'undo', sf: 'hermes', id: 'dock.composer.line.input', raw: {} })
      expect(app.stores.composer.text).toBe(before)
      expect(gw.sent('prompt.submit')).toHaveLength(0)

      app.stores.composer.vim.setEnabled(false)
      app.changed()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(editor().props['mode']).toBeUndefined()
      expect(editor().props['sendable']).toBe(true)
      if (typeof edit === 'function') edit({ ev: 'edit', sf: 'hermes', id: 'dock.composer.line.input', raw: {}, from: 3, to: 3, text: '文', cursor: 4, len: 3 })
      expect(app.stores.composer.text).toBe('abc文')
    } finally {
      app.quit()
      await running
    }
  })
})
