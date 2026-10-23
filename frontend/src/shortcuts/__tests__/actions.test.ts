import { describe, expect, it } from 'vitest'

import { key } from '../../__tests__/fakes.js'

import { APP_SHORTCUTS, effectiveShortcuts, normalizeChord, shortcutGroups, shortcutMatches } from '../actions.js'

const action = (id: string, overrides: unknown = {}) => {
  const found = effectiveShortcuts(overrides).find(item => item.id === id)

  if (!found) {
    throw new Error(`Missing app action ${id}`)
  }

  return found
}

describe('Tern app action registry', () => {
  it('keeps the plugin key ownership and exact new chords', () => {
    expect(effectiveShortcuts({})).toEqual(APP_SHORTCUTS)
    expect(shortcutMatches(action('app.prs'), key('p', { alt: true, shift: true }))).toBe(true)
    expect(shortcutMatches(action('app.prs'), key('p', { alt: true, ctrl: true }))).toBe(false)
    expect(shortcutMatches(action('app.model.cycleBackward'), key('p', { ctrl: true, shift: true }))).toBe(true)
    expect(shortcutMatches(action('app.model.cycleBackward'), key('p', { ctrl: true, shift: true, alt: true }))).toBe(false)
    expect(shortcutMatches(action('app.help'), key('f1'))).toBe(true)
  })

  it('normalizes ordering/aliases and refuses host-reserved and editing keys', () => {
    expect(normalizeChord('Shift+CONTROL+K')).toBe('ctrl+shift+k')
    expect(normalizeChord('OPTION+M')).toBe('alt+m')
    for (const value of ['meta+k', 'cmd+h', 'super+p', 'ctrl+shift+c', 'ctrl+shift+v', 'alt+tab', 'ctrl+ctrl+p']) {
      expect(() => normalizeChord(value)).toThrow()
    }
    for (const value of ['j', 'space', 'enter', 'ctrl+a', 'alt+b', 'alt+enter', 'up']) {
      expect(() => effectiveShortcuts({ 'app.help': value })).toThrow(/Composer-owned/)
    }
  })

  it('applies disable, reset, and rebinding atomically', () => {
    const changed = effectiveShortcuts({ 'app.help': ['alt+k'] })
    expect(shortcutMatches(action('app.help', { 'app.help': ['alt+k'] }), key('k', { alt: true }))).toBe(true)
    expect(changed.find(item => item.id === 'app.help')?.keys).toEqual(['alt+k'])
    expect(action('app.help', { 'app.help': [] }).keys).toEqual([])
    expect(action('app.help', { 'app.help': null }).keys).toEqual(['f1', 'alt+/'])
    expect(() => effectiveShortcuts({ 'app.help': ['alt+k', 'option+k'] })).toThrow(/Duplicate/)
    expect(() => effectiveShortcuts({ 'app.help': ['alt+a'] })).toThrow(/Overlapping/)
    expect(() => effectiveShortcuts({ 'app.help': ['ctrl+shift+tab'] })).toThrow(/Overlapping/)
    expect(() => effectiveShortcuts({ 'app.help': 'alt+k', 'unknown.action': 'alt+y' })).toThrow(/Unknown/)
    expect(shortcutGroups(changed).flatMap(group => group.rows).some(([keys, title]) => keys[0] === 'alt+k' && title === 'Commands and shortcuts')).toBe(true)
  })
})
