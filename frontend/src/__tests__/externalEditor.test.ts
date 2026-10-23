import { readFile, stat, writeFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { localCommand, type CommandHost } from '../commands/local.js'
import { Composer } from '../draft/composer.js'
import { editorArgv, editExternal, editTextExternal, type ExternalDraftHost } from '../draft/external-editor.js'

import { stub } from './fakes.js'

function host(text = 'draft') {
  const composer = new Composer()
  composer.set(text)
  let sid: string | null = 'session-1'
  const notice = vi.fn()
  const panel = vi.fn()
  const changed = vi.fn()
  const h: ExternalDraftHost = { composer, changed, notice, panel, sid: () => sid }
  return { composer, notice, panel, changed, h, setSid: (value: string | null) => { sid = value } }
}

describe('external draft editor', () => {
  it('parses editor argv without shell interpolation and respects quoted binary paths', () => {
    expect(editorArgv('nvim --cmd "set noswapfile"')).toEqual(['nvim', '--cmd', 'set noswapfile'])
    expect(editorArgv('"/tmp/my editor" -f')).toEqual(['/tmp/my editor', '-f'])
    expect(() => editorArgv('')).toThrow('empty')
    expect(() => editorArgv('nvim "unterminated')).toThrow('unterminated')
    expect(() => editorArgv('nvim \\')).toThrow('unterminated')
  })

  it('creates a private 0600 file, reads the edited text and always cleans up', async () => {
    let filename = ''
    let initial = ''
    const result = await editTextExternal('one\ntwo', async file => {
      filename = file
      initial = await readFile(file, 'utf8')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await writeFile(file, 'edited\n')
    })
    expect(initial).toBe('one\ntwo')
    expect(result).toBe('edited\n')
    await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('commits an edit only when both the session and revision still own the draft', async () => {
    const x = host('draft')
    await editExternal(x.h, async file => { await writeFile(file, 'from editor') })
    expect(x.composer.text).toBe('from editor')
    expect(x.panel).not.toHaveBeenCalled()
    expect(x.notice).not.toHaveBeenCalled()
    expect(x.changed).toHaveBeenCalledTimes(1)
  })

  it('does not replace a revised draft, including an ABA text edit', async () => {
    const x = host('same')
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const job = editExternal(x.h, async file => {
      started.resolve()
      await release.promise
      await writeFile(file, 'late result')
    })
    await started.promise
    x.composer.set('new')
    x.composer.set('same')
    release.resolve()
    await job
    expect(x.composer.text).toBe('same')
    expect(x.panel).toHaveBeenCalledWith('External editor result (draft changed while editing)', 'late result')
  })

  it('rejects a session-switched result, guards double opens and leaves failed edits untouched', async () => {
    const x = host('keep')
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const opener = vi.fn(async (file: string) => {
      started.resolve()
      await release.promise
      await writeFile(file, 'foreign')
    })
    const job = editExternal(x.h, opener)
    await started.promise
    await editExternal(x.h, opener)
    expect(opener).toHaveBeenCalledTimes(1)
    x.setSid('session-2')
    release.resolve()
    await job
    expect(x.composer.text).toBe('keep')
    expect(x.panel).toHaveBeenCalledOnce()
    await editExternal(x.h, async () => { throw new Error('cancelled') })
    expect(x.notice).toHaveBeenCalledWith('cancelled', 'error')
    expect(x.composer.text).toBe('keep')
  })

  it('refuses to open without an active session', async () => {
    const x = host()
    x.setSid(null)
    const opener = vi.fn()
    await editExternal(x.h, opener)
    expect(opener).not.toHaveBeenCalled()
    expect(x.notice).toHaveBeenCalledWith('No active session to edit.', 'warning')
  })
})

describe('/editor command registration', () => {
  it('routes to the local external editor and never forwards an argument to the gateway', async () => {
    const open = vi.fn(async () => undefined)
    const notice = vi.fn()
    const host = stub<CommandHost>({ editExternal: open, transcript: { notice } })
    const command = localCommand('editor')
    expect(command?.name).toBe('editor')
    await command?.run(host, '')
    expect(open).toHaveBeenCalledOnce()
    await command?.run(host, 'unexpected')
    expect(open).toHaveBeenCalledOnce()
    expect(notice).toHaveBeenCalledWith('Usage: /editor', 'warning')
  })
})
