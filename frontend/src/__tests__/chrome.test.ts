// The chrome stores on fake hosts, with no App: the status strip's notices and their expiry
// render, and the connection's one line per outage and its redial line.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'

import { isLoginNotice, noticeReport, Notices, NoticeStrip } from '../chrome/notices.js'
import { Reconnect } from '../chrome/reconnect.js'

/** A host that counts the renders it was asked for. */
function host() {
  return { changed: vi.fn() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Notices', () => {
  it('keeps the newest error available alongside later notices and handles clear, replacement and expiry', () => {
    const n = new Notices()
    n.show({ key: 'first', kind: 'sticky', level: 'error', text: 'First error' }, 0)
    n.show({ key: 'second', kind: 'sticky', level: 'error', text: 'Second error' }, 1)
    n.show({ key: 'latest', kind: 'ttl', text: 'Other update', ttl_ms: 100 }, 2)
    expect(n.current(3)?.text).toBe('Other update')
    expect(n.otherError(3)?.text).toBe('Second error')
    expect(n.active(3).map(item => item.text)).toEqual(['First error', 'Second error', 'Other update'])
    n.clear('second')
    expect(n.otherError(4)?.text).toBe('First error')
    n.show({ key: 'first', kind: 'sticky', level: 'info', text: 'Recovered' }, 5)
    expect(n.otherError(5)).toBeUndefined()
    expect(n.active(102).map(item => item.text)).toEqual(['Recovered'])
    n.reset()
    expect(n.active(103)).toEqual([])
  })

  it('formats a bounded snapshot without interpreting gateway Markdown', () => {
    const report = noticeReport([{ key: 'a', tone: 'error', text: 'failure\n[link](https://example.com)\r<script>' }])
    expect(report).toContain('Snapshot at open time')
    expect(report).toContain('    [link](https://example.com)\n    <script>')
    const parsed = unified().use(remarkParse).parse(report)
    expect(JSON.stringify(parsed)).not.toContain('"type":"link"')
    expect(JSON.stringify(parsed)).not.toContain('"type":"html"')
    expect(noticeReport([])).toContain('No retained notices')
  })
  it('replaces by key and shows the newest', () => {
    const n = new Notices()

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'warn', text: "⚠ You've used $8.00 of your $10 cap" })
    n.show({ key: 'credits.depleted', kind: 'sticky', level: 'error', text: '✕ Credit access paused · run /topup' })
    expect(n.current()).toMatchObject({ key: 'credits.depleted', tone: 'error' })

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'info', text: "• You've used $9.00 of your $10 cap" })
    expect(n.current()).toMatchObject({ key: 'credits.usage', text: "• You've used $9.00 of your $10 cap", tone: 'info' })
  })

  it('clears only a matching key', () => {
    const n = new Notices()

    n.show({ key: 'credits.depleted', kind: 'sticky', level: 'error', text: '✕ paused' })
    expect(n.clear('credits.usage')).toBe(false)
    expect(n.current()?.key).toBe('credits.depleted')
    expect(n.clear('credits.depleted')).toBe(true)
    expect(n.current()).toBeUndefined()
  })

  it('expires a ttl notice and falls back to the one under it', () => {
    const n = new Notices()

    n.show({ key: 'credits.usage', kind: 'sticky', level: 'warn', text: '⚠ used' }, 0)
    n.show({ key: 'credits.restored', kind: 'ttl', level: 'success', text: '✓ restored', ttl_ms: 5000 }, 0)
    expect(n.nextExpiry()).toBe(5000)
    expect(n.current(4999)).toMatchObject({ key: 'credits.restored', tone: 'success' })
    expect(n.current(5000)?.key).toBe('credits.usage')
    expect(n.nextExpiry()).toBeUndefined()
  })

  it('tells /login steps apart', () => {
    expect(isLoginNotice({ key: 'login:ab12cd34', text: 'Open https://portal.example/device · code ABCD-1234' })).toBe(true)
    expect(isLoginNotice({ key: 'credits.usage', text: 'x' })).toBe(false)
  })
})

describe('NoticeStrip', () => {
  it('re-renders when a ttl notice expires, then drops it from the strip', () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = host()
    const strip = new NoticeStrip(h)

    strip.show({ key: 'credits.usage', kind: 'sticky', level: 'warn', text: '⚠ used' })
    expect(vi.getTimerCount()).toBe(0)

    strip.show({ key: 'credits.restored', kind: 'ttl', level: 'success', text: '✓ restored', ttl_ms: 5000 })
    expect(strip.current()?.key).toBe('credits.restored')
    expect(vi.getTimerCount()).toBe(1)

    // Ten ms past the expiry, so the render reads it gone.
    vi.advanceTimersByTime(5009)
    expect(h.changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(strip.current()?.key).toBe('credits.usage')
    // Nothing else expires, so nothing is armed.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms for the sooner expiry, and reset() forgets every notice', () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = host()
    const strip = new NoticeStrip(h)

    strip.show({ key: 'a', kind: 'ttl', text: 'a', ttl_ms: 9000 })
    strip.show({ key: 'b', kind: 'ttl', text: 'b', ttl_ms: 1000 })
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1010)
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(strip.current()?.key).toBe('a')

    strip.clear('a')
    expect(strip.current()).toBeUndefined()

    strip.show({ key: 'c', kind: 'sticky', text: 'c' })
    strip.reset()
    expect(strip.current()).toBeUndefined()
  })

  it('dispose() stops the expiry render', () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = host()
    const strip = new NoticeStrip(h)

    strip.show({ key: 'a', kind: 'ttl', text: 'a', ttl_ms: 1000 })
    strip.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(h.changed).not.toHaveBeenCalled()
  })
})

describe('Reconnect', () => {
  it('writes one line per outage, until gateway.ready', () => {
    const r = new Reconnect(host())

    expect(r.lost(true, null)).toEqual({ text: 'Lost the connection to Hermes; reconnecting…', tone: 'warning' })
    // Each failed redial exits again: no second line.
    expect(r.lost(true, null)).toBeUndefined()
    expect(r.lost(false, 1)).toBeUndefined()

    r.ready()
    expect(r.lost(false, 1)).toEqual({ text: 'The agent backend exited (1).', tone: 'error' })
    r.ready()
    expect(r.lost(false, null)).toEqual({ text: 'The agent backend exited.', tone: 'error' })
  })

  it('shows the redial line, re-renders when its wait ends, and drops it on ready', () => {
    vi.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = host()
    const r = new Reconnect(h)

    expect(r.redial).toBeUndefined()
    r.redialing(1, 2000)
    expect(r.redial).toEqual({ attempt: 1, dueAt: 3000 })

    // The next try replaces the line and its timer.
    r.redialing(2, 4000)
    expect(r.redial).toEqual({ attempt: 2, dueAt: 5000 })
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(4049)
    expect(h.changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.changed).toHaveBeenCalledTimes(1)

    r.redialing(3, 1000)
    r.ready()
    expect(r.redial).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose() stops the redial render', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = new Reconnect(host())

    r.redialing(1, 1000)
    r.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
