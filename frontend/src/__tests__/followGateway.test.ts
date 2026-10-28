// Direct contract tests for gateway/follow.ts; the real tap writes only into each test's temp directory.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { followGateway } from '../gateway/follow.js'

import { FakeGateway, stub } from './fakes.js'

// Stub only the dispatcher boundary; no real handler tables or whole-App initialization.
const dispatch = vi.hoisted(() => vi.fn())
const captured = vi.hoisted((): { args: unknown[] } => ({ args: [] }))

vi.mock('../gateway/dispatch.js', () => ({
  dispatcher: (...args: unknown[]) => {
    captured.args = args
    return dispatch
  }
}))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follow-'))
  dispatch.mockReset()
  captured.args = []
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function context(eventLog = join(dir, 'events.jsonl')) {
  return {
    changed: vi.fn(),
    request: vi.fn(),
    btw: { onEvent: vi.fn().mockReturnValue(false) },
    activity: { endBusy: vi.fn() },
    reconnect: { lost: vi.fn().mockReturnValue(undefined) },
    life: { follow: vi.fn(), lost: vi.fn() },
    sheets: { dropAll: vi.fn() },
    transcript: { interrupt: vi.fn(), notice: vi.fn() },
    eventLog,
    onShown: vi.fn(),
    onLost: vi.fn()
  }
}

// Only the follow boundary is exercised; the dispatcher is mocked above.
function follow(gw: FakeGateway, cx: unknown) {
  followGateway(gw.client, stub(cx))
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n')
}

describe('followGateway', () => {
  it('wiring: registers the replay callback and all three listeners before draining', () => {
    const gw = new FakeGateway()
    const cx = context()
    let listenersAtDrain: number[] | undefined
    const drain = vi.spyOn(gw, 'drain').mockImplementation(() => {
      listenersAtDrain = ['event', 'request', 'exit'].map(name => gw.listenerCount(name))
    })

    follow(gw, cx)

    expect(cx.life.follow).toHaveBeenCalledTimes(1)
    expect(cx.life.follow).toHaveBeenCalledWith(expect.any(Function))
    expect(gw.listenerCount('event')).toBe(1)
    expect(gw.listenerCount('request')).toBe(1)
    expect(gw.listenerCount('exit')).toBe(1)
    expect(drain).toHaveBeenCalledTimes(1)
    expect(listenersAtDrain).toEqual([1, 1, 1])
  })

  it('dispatcherArgs: passes the context and onShown and logs unknown event types', () => {
    const gw = new FakeGateway()
    const cx = context()
    follow(gw, cx)

    expect(captured.args).toHaveLength(3)
    expect(captured.args[0]).toBe(cx)
    expect(captured.args[2]).toBe(cx.onShown)
    const unknown = captured.args[1]
    expect(unknown).toEqual(expect.any(Function))
    if (typeof unknown !== 'function') {
      throw new Error('dispatcher did not receive its unknown-event callback')
    }

    unknown('weird.type')

    expect(lines(cx.eventLog)).toEqual(['{"unknown":"weird.type"}'])
  })

  it('eventRender: forwards the same event, redraws once, and taps one JSON line', () => {
    const gw = new FakeGateway()
    const cx = context()
    const event = { type: 'x' }
    dispatch.mockReturnValue('render')
    follow(gw, cx)

    gw.event(event)

    expect(cx.btw.onEvent).toHaveBeenCalledWith(event)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).toHaveBeenCalledTimes(1)
    expect(lines(cx.eventLog)).toEqual([JSON.stringify(event)])
  })

  it('eventQuiet: dispatches without asking for a redraw', () => {
    const gw = new FakeGateway()
    const cx = context()
    const event = { type: 'x' }
    dispatch.mockReturnValue('quiet')
    follow(gw, cx)

    gw.event(event)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).not.toHaveBeenCalled()
    expect(lines(cx.eventLog)).toEqual([JSON.stringify(event)])
  })

  it('btwConsumes: a claimed event reaches the tap but not dispatch or redraw', () => {
    const gw = new FakeGateway()
    const cx = context()
    const event = { type: 'btw.complete', payload: { text: 'side answer' } }
    cx.btw.onEvent.mockReturnValue(true)
    dispatch.mockReturnValue('render')
    follow(gw, cx)

    gw.event(event)

    expect(cx.btw.onEvent).toHaveBeenCalledTimes(1)
    expect(cx.btw.onEvent).toHaveBeenCalledWith(event)
    expect(dispatch).not.toHaveBeenCalled()
    expect(cx.changed).not.toHaveBeenCalled()
    expect(lines(cx.eventLog)).toEqual([JSON.stringify(event)])
  })

  it('btwAbsent: events still reach dispatch when the optional BTW handler is absent', () => {
    const gw = new FakeGateway()
    const cx = context()
    const withoutBtw = { ...cx }
    Reflect.deleteProperty(withoutBtw, 'btw')
    const event = { type: 'normal' }
    dispatch.mockReturnValue('render')
    follow(gw, withoutBtw)

    gw.event(event)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).toHaveBeenCalledTimes(1)
    expect(lines(cx.eventLog)).toEqual([JSON.stringify(event)])
  })

  it('btwDeclines: false from BTW permits dispatch and redraw', () => {
    const gw = new FakeGateway()
    const cx = context()
    const event = { type: 'normal' }
    cx.btw.onEvent.mockReturnValue(false)
    dispatch.mockReturnValue('render')
    follow(gw, cx)

    gw.event(event)

    expect(cx.btw.onEvent).toHaveBeenCalledWith(event)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).toHaveBeenCalledTimes(1)
    expect(lines(cx.eventLog)).toEqual([JSON.stringify(event)])
  })

  it('heldEventsRedelivered: follows held events without tapping them twice', () => {
    const gw = new FakeGateway()
    const cx = context()
    const event = { type: 'held' }
    dispatch.mockReturnValue('render')
    follow(gw, cx)
    const redeliver = cx.life.follow.mock.calls[0]?.[0]
    expect(redeliver).toEqual(expect.any(Function))
    if (typeof redeliver !== 'function') {
      throw new Error('life.follow did not receive the redelivery callback')
    }

    redeliver(event)

    expect(cx.btw.onEvent).toHaveBeenCalledWith(event)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('requestForwarded: passes through the same request and taps a request envelope', () => {
    const gw = new FakeGateway()
    const cx = context()
    const request = { id: 1, method: 'approval.request', params: { a: 1 } }
    follow(gw, cx)

    gw.emit('request', request)

    expect(cx.request).toHaveBeenCalledTimes(1)
    expect(cx.request.mock.calls[0]?.[0]).toBe(request)
    expect(lines(cx.eventLog)).toEqual([
      '{"request":{"id":1,"method":"approval.request","params":{"a":1}}}'
    ])
  })

  it('noTapWhenEmptyPath: event and request work without creating files', () => {
    const gw = new FakeGateway()
    const cx = context('')
    const event = { type: 'x' }
    const request = { id: 2, method: 'approval.request', params: {} }
    dispatch.mockReturnValue('render')
    follow(gw, cx)

    gw.event(event)
    gw.emit('request', request)

    expect(dispatch).toHaveBeenCalledWith(event)
    expect(cx.changed).toHaveBeenCalledTimes(1)
    expect(cx.request).toHaveBeenCalledTimes(1)
    expect(cx.request).toHaveBeenCalledWith(request)
    expect(readdirSync(dir)).toEqual([])
  })

  it('exitFirstOutage: notices once and tears down in the exact contract order', () => {
    const gw = new FakeGateway()
    const cx = context()
    const order: string[] = []
    const mark = (name: string) => () => { order.push(name) }
    cx.reconnect.lost.mockImplementation(() => {
      order.push('reconnect.lost')
      return { text: 'gone', tone: 'error' }
    })
    cx.transcript.notice.mockImplementation(mark('transcript.notice'))
    cx.life.lost.mockImplementation(mark('life.lost'))
    cx.activity.endBusy.mockImplementation(mark('activity.endBusy'))
    cx.onLost.mockImplementation(mark('onLost'))
    cx.sheets.dropAll.mockImplementation(mark('sheets.dropAll'))
    cx.transcript.interrupt.mockImplementation(mark('transcript.interrupt'))
    cx.changed.mockImplementation(mark('changed'))
    follow(gw, cx)

    gw.emit('exit', 3)

    expect(cx.reconnect.lost).toHaveBeenCalledTimes(1)
    expect(cx.reconnect.lost).toHaveBeenCalledWith(gw.attached, 3)
    expect(cx.transcript.notice).toHaveBeenCalledTimes(1)
    expect(cx.transcript.notice).toHaveBeenCalledWith('gone', 'error')
    for (const fn of [cx.life.lost, cx.activity.endBusy, cx.onLost, cx.sheets.dropAll, cx.transcript.interrupt, cx.changed]) {
      expect(fn).toHaveBeenCalledTimes(1)
    }
    expect(order).toEqual([
      'reconnect.lost',
      'transcript.notice',
      'life.lost',
      'activity.endBusy',
      'onLost',
      'sheets.dropAll',
      'transcript.interrupt',
      'changed'
    ])
  })

  it('exitLaterOutage: repeats teardown on later exits without another notice', () => {
    const gw = new FakeGateway()
    const cx = context()
    const order: string[] = []
    const mark = (name: string) => () => { order.push(name) }
    cx.reconnect.lost.mockImplementation(() => {
      order.push('reconnect.lost')
      return undefined
    })
    cx.life.lost.mockImplementation(mark('life.lost'))
    cx.activity.endBusy.mockImplementation(mark('activity.endBusy'))
    cx.onLost.mockImplementation(mark('onLost'))
    cx.sheets.dropAll.mockImplementation(mark('sheets.dropAll'))
    cx.transcript.interrupt.mockImplementation(mark('transcript.interrupt'))
    cx.changed.mockImplementation(mark('changed'))
    follow(gw, cx)

    gw.emit('exit', 3)
    gw.emit('exit', 4)

    expect(cx.reconnect.lost).toHaveBeenCalledTimes(2)
    expect(cx.reconnect.lost).toHaveBeenNthCalledWith(1, gw.attached, 3)
    expect(cx.reconnect.lost).toHaveBeenNthCalledWith(2, gw.attached, 4)
    expect(cx.transcript.notice).not.toHaveBeenCalled()
    for (const fn of [cx.life.lost, cx.activity.endBusy, cx.onLost, cx.sheets.dropAll, cx.transcript.interrupt, cx.changed]) {
      expect(fn).toHaveBeenCalledTimes(2)
    }
    const teardown = [
      'reconnect.lost',
      'life.lost',
      'activity.endBusy',
      'onLost',
      'sheets.dropAll',
      'transcript.interrupt',
      'changed'
    ]
    expect(order).toEqual([...teardown, ...teardown])
  })

  it('exitWithoutOnLost: allows a missing optional callback and null exit code', () => {
    const gw = new FakeGateway()
    const cx = context()
    const withoutOnLost = { ...cx }
    Reflect.deleteProperty(withoutOnLost, 'onLost')
    follow(gw, withoutOnLost)

    expect(() => gw.emit('exit', null)).not.toThrow()

    expect(cx.reconnect.lost).toHaveBeenCalledTimes(1)
    expect(cx.reconnect.lost).toHaveBeenCalledWith(gw.attached, null)
    expect(cx.life.lost).toHaveBeenCalledTimes(1)
    expect(cx.sheets.dropAll).toHaveBeenCalledTimes(1)
    expect(cx.transcript.interrupt).toHaveBeenCalledTimes(1)
    expect(cx.changed).toHaveBeenCalledTimes(1)
  })
})
