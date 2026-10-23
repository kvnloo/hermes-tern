import { describe, expect, it } from 'vitest'

import { Composer } from '../draft/composer.js'
import { VIM_ACTIONS, vimActionForKey } from '../draft/vim.js'

import { key } from './fakes.js'

function enabled(text = '', cursor = 0) {
  const composer = new Composer()
  composer.set(text, { cursor })
  composer.vim.setEnabled(true)
  return composer
}

function command(c: Composer, keys: string) {
  for (const char of keys) {
    const shift = char.toUpperCase() === char && char.toLowerCase() !== char
    const name = shift ? char.toLowerCase() : char
    expect(c.vim.key(key(name, { shift, text: char })), `Unhandled Vim key: ${char}`).toBe(true)
  }
}
function normal(c: Composer) {
  expect(c.vim.key(key('escape'))).toBe(true)
  expect(c.vim.mode).toBe('normal')
}

describe('Hermes composer: optional Vim', () => {
  it('is disabled by default and preserves ordinary native editing until explicitly enabled', () => {
    const c = enabled('a')
    c.vim.setEnabled(false)
    expect(c.vim.enabled).toBe(false)
    expect(c.vim.nativeMode).toBeUndefined()
    expect(c.vim.key(key('escape'))).toBe(false)
    c.edit({ from: 1, to: 1, text: '文', cursor: 2, len: 1 })
    expect(c.text).toBe('a文')
    c.vim.setEnabled(true)
    c.edit({ from: 0, to: 2, text: 'bad', cursor: 3, len: 2 })
    expect(c.text).toBe('a文')
  })

  it('consumes Insert Escape, pending operators and Visual Escape, but not quiet Normal Escape', () => {
    const c = enabled('draft', 5)
    normal(c)
    expect(c.cursor).toBe(4)
    command(c, 'd')
    expect(c.vim.pending).toBe('d')
    expect(c.vim.key(key('escape'))).toBe(true)
    expect(c.vim.pending).toBe('')
    expect(c.vim.key(key('escape'))).toBe(false)
    command(c, 'v')
    expect(c.vim.mode).toBe('visual')
    expect(c.vim.key(key('escape'))).toBe(true)
    expect(c.vim.mode).toBe('normal')
  })

  it('moves across emoji and combining sequences as graphemes, with preserved vertical column', () => {
    const family = '👨‍👩‍👧‍👦'
    const text = `a${family}e\u0301\nZ\n甲乙丙`
    const c = enabled(text, 0)
    normal(c)
    command(c, 'll')
    expect(c.cursor).toBe(1 + family.length)
    command(c, 'j')
    expect(c.cursor).toBe(text.indexOf('Z'))
    command(c, 'j')
    expect(c.cursor).toBe(text.indexOf('丙'))
    command(c, 'j')
    expect(c.cursor).toBe(text.indexOf('丙'))
  })

  it('normal/visual native editor mode and inclusive anchor track grapheme selections', () => {
    const family = '👨‍👩‍👧‍👦'
    const c = enabled(`a${family}e\u0301\nZ`, 0)
    normal(c)
    command(c, 'lv')
    expect(c.vim.nativeMode).toBe('visual')
    command(c, 'l')
    expect(c.vim.selection).toEqual({ anchor: 1, cursor: 1 + family.length + 2 })
    command(c, 'r界')
    expect(c.text).toBe('a界界\nZ')
    expect(c.vim.mode).toBe('normal')
  })

  it('supports operator motions, counts, line edits, undo and redo', () => {
    const c = enabled('one two three', 0)
    normal(c)
    command(c, 'dw')
    expect(c.text).toBe('two three')
    command(c, 'u')
    expect(c.text).toBe('one two three')
    expect(c.vim.key(key('r', { ctrl: true }))).toBe(true)
    expect(c.text).toBe('two three')
    c.set('one\ntwo\nthree', { cursor: 0 })
    command(c, '2dd')
    expect(c.text).toBe('three')
    command(c, 'u')
    expect(c.text).toBe('one\ntwo\nthree')
    command(c, 'Gdd')
    expect(c.text).toBe('one\ntwo')
  })

  it('changes a word without removing whitespace, yanks and pastes from a composer-local register', () => {
    const c = enabled('one two', 0)
    normal(c)
    command(c, 'cw')
    expect(c.vim.mode).toBe('insert')
    c.key(key('X', { text: 'X' }))
    expect(c.text).toBe('X two')
    normal(c)
    c.set('first\nsecond', { cursor: 0 })
    command(c, 'yyGp')
    expect(c.text).toBe('first\nsecond\nfirst')
  })

  it('treats all pasted bytes as a single literal edit, preserving command-origin metadata', () => {
    const c = enabled('prefix', 0)
    normal(c)
    c.vim.key(key('paste', { text: '!rm -rf /\r\n' }))
    expect(c.text).toBe('!rm -rf /\nprefix')
    expect(c.pasted).toContain('!rm -rf /\n')
    expect(c.vim.mode).toBe('normal')
    command(c, 'u')
    expect(c.text).toBe('prefix')
    expect(c.pasted).toEqual([])
    command(c, 'i')
    c.key(key('paste', { text: '{!danger}' }))
    expect(c.pasted).toContain('{!danger}')
  })

  it('registers modal bindings without modifier collisions', () => {
    const names = new Set(VIM_ACTIONS.flatMap(action => action.keys.map(k => k.split('+').at(-1)!)))
    for (const name of names) for (let mask = 0; mask < 16; mask++) {
      const k = key(name, { ctrl: Boolean(mask & 1), alt: Boolean(mask & 2), shift: Boolean(mask & 4), meta: Boolean(mask & 8) })
      const matches = VIM_ACTIONS.filter(action => action.keys.some(chord => {
        const parts = chord.split('+')
        const n = parts.pop()
        return n === k.name.toLowerCase() && (['ctrl', 'alt', 'shift', 'meta'] as const).every(mod => parts.includes(mod) === Boolean(k[mod]))
      }))
      expect(matches.length, `${name}:${mask}`).toBeLessThanOrEqual(1)
      expect(vimActionForKey(k)).toBe(matches[0]?.id)
    }
  })
})
