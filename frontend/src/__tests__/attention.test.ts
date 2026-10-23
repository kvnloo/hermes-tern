import { afterEach, describe, expect, it, vi } from 'vitest'

import { Dispatches } from '../chrome/attention.js'
import { NoticeStrip } from '../chrome/notices.js'

afterEach(() => vi.useRealTimers())

describe('Hermes × Tern attention', () => {
  it('replaces keys, expires only TTL entries, and preserves sticky alerts', () => {
    const notes = new Dispatches()
    notes.show({ key: 'work', text: 'Starting', kind: 'ttl' }, 100)
    notes.show({ key: 'work', text: 'Working', kind: 'ttl', ttl_ms: 2000 }, 200)
    notes.show({ key: 'alert', text: 'Approval needed', level: 'warn', kind: 'sticky' }, 300)
    expect(notes.active(301).map(n => n.text)).toEqual(['Working', 'Approval needed'])
    expect(notes.nextExpiry(301)).toBe(2200)
    expect(notes.active(2200).map(n => n.key)).toEqual(['alert'])
    expect(notes.nextExpiry(2200)).toBeNull()
    expect(notes.clear('alert')).toBe(true)
    expect(notes.active(2201)).toEqual([])
  })

  it('bounds count, TTL, and ignores empty notices', () => {
    const notes = new Dispatches()
    notes.show({ text: '   ' }, 0)
    for (let i = 0; i < 20; i++) {
      notes.show({ key: `n:${i}`, text: `note ${i}`, ttl_ms: Infinity, level: 'bogus' }, 0)
    }
    const active = notes.active(0)
    expect(active).toHaveLength(8)
    expect(active[0]?.text).toBe('note 12')
    expect(active.every(n => n.expiresAt === 6000 && n.level === 'info')).toBe(true)
    notes.show({ key: 'cap', text: 'cap', kind: 'ttl', ttl_ms: 999999 }, 100)
    expect(notes.active(100).find(n => n.key === 'cap')?.expiresAt).toBe(60100)
  })

  it('coalesces hidden updates, cancels deferred keys and starts TTL on return', () => {
    const notes = new Dispatches()
    notes.show({ key: 'job', text: 'Old', kind: 'ttl', ttl_ms: 100 }, 10, true)
    notes.show({ key: 'job', text: 'New', kind: 'ttl', ttl_ms: 100 }, 20, true)
    notes.show({ key: 'gone', text: 'Cancel me', kind: 'sticky' }, 30, true)
    expect(notes.clear('gone')).toBe(true)
    expect(notes.active(30000)).toEqual([])
    notes.resume(31000)
    expect(notes.active(31099).map(n => n.text)).toEqual(['New'])
    expect(notes.active(31100)).toEqual([])
  })

  it('keeps only the latest eight pending keys and clears on session change', () => {
    const notes = new Dispatches()
    for (let i = 0; i < 20; i++) {
      notes.show({ key: `job:${i}`, text: `job ${i}` }, i, true)
    }
    notes.resume(20000)
    expect(notes.active(20000).map(n => n.text)).toEqual(Array.from({ length: 8 }, (_, i) => `job ${i + 12}`))
    notes.show({ key: 'late', text: 'Hidden' }, 20001, true)
    notes.reset()
    notes.resume(30000)
    expect(notes.active(30000)).toEqual([])
  })
})

describe('visible Tern notice strip', () => {
  it('holds notices and has no timers or expiry paints while hidden', () => {
    vi.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const changed = vi.fn()
    const strip = new NoticeStrip({ changed })
    strip.visible(false)
    strip.show({ key: 'task', text: 'Finished in background', kind: 'ttl', ttl_ms: 100 })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(strip.current()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()

    strip.visible(true)
    expect(strip.current()?.text).toBe('Finished in background')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(109)
    expect(strip.current()?.key).toBe('task')
    vi.advanceTimersByTime(1)
    expect(strip.current()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    strip.dispose()
  })

  it('clear and session reset cancel deferred notifications and timers', () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const strip = new NoticeStrip({ changed: vi.fn() })
    strip.show({ key: 'old', text: 'Old', kind: 'ttl' })
    expect(vi.getTimerCount()).toBe(1)
    strip.reset()
    expect(vi.getTimerCount()).toBe(0)
    strip.visible(false)
    strip.show({ key: 'cancel', text: 'Do not show', kind: 'ttl' })
    strip.clear('cancel')
    strip.visible(true)
    expect(strip.current()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    strip.dispose()
  })
})
