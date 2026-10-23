import type { Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

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

describe('Vim composer plugged into the actual app and native Tern dock', () => {
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
      await press('v', 'v')
      await press('l', 'l')
      expect(editor().props['mode']).toBe('visual')
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
      if (typeof undo === 'function') undo()
      expect(app.stores.composer.text).toBe(before)
      expect(gw.sent('prompt.submit')).toHaveLength(0)

      app.stores.composer.vim.setEnabled(false)
      app.changed()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(editor().props['mode']).toBeUndefined()
      if (typeof edit === 'function') edit({ ev: 'edit', sf: 'hermes', id: 'dock.composer.line.input', raw: {}, from: 3, to: 3, text: '文', cursor: 4, len: 3 })
      expect(app.stores.composer.text).toBe('abc文')
    } finally {
      app.quit()
      await running
    }
  })
})
