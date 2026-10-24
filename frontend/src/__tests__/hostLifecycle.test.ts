import { describe, expect, it } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import { HostLifecycle } from '../host-lifecycle.js'

import { FakeGateway, fakeTern, given, stubOverlay } from './fakes.js'

const WORKING = '\x1b]9;4;3\x07'
const WAITING = '\x1b]9;4;4\x07'
const CLEAR = '\x1b]9;4;0;\x07'
const REQUIRED = '\x1b]777;notify;Hermes;Input required\x07'
const FINISHED = '\x1b]777;notify;Hermes;Turn finished\x07'

describe('the Tern host lifecycle', () => {
  it('emits each real phase edge once; waiting and completion are the only alerts', () => {
    const bytes: string[] = []
    const life = new HostLifecycle(chunk => void bytes.push(chunk))
    const busy = { sid: 'a', working: true, waiting: false }
    life.project(busy)
    life.project(busy)
    life.project({ ...busy, waiting: true })
    life.project({ ...busy, waiting: true })
    life.project(busy)
    life.finish('done')
    life.finish('done')
    life.project({ ...busy, working: false })
    expect(bytes).toEqual([WORKING, WAITING, REQUIRED, WORKING, CLEAR, FINISHED])
  })

  it('does not clear a running handoff merely because a queued request awaits admission', () => {
    const bytes: string[] = []
    const life = new HostLifecycle(chunk => void bytes.push(chunk))
    life.project({ sid: 'a', working: true, waiting: false })
    life.project({ sid: 'a', working: false, submitting: true, waiting: false })
    expect(bytes).toEqual([WORKING])
    life.finish('interrupted')
    expect(bytes.at(-1)).toContain('Turn interrupted')
  })

  it('resets progress on session changes without pretending the old turn finished', () => {
    const bytes: string[] = []
    const life = new HostLifecycle(chunk => void bytes.push(chunk))
    life.project({ sid: 'a', working: true, waiting: false })
    life.project({ sid: 'b', working: true, waiting: false })
    life.project({ sid: null, working: true, waiting: false })
    expect(bytes).toEqual([WORKING, CLEAR, WORKING, CLEAR])
  })

  it('reports failed turns once and no completion notification from idle', () => {
    const bytes: string[] = []
    const life = new HostLifecycle(chunk => void bytes.push(chunk))
    life.finish('error')
    life.project({ sid: 'a', working: true, waiting: false })
    life.finish('error')
    expect(bytes).toEqual([WORKING, CLEAR, '\x1b]777;notify;Hermes;Turn failed\x07'])
  })
})

describe('gateway and app integration', () => {
  it('tracks a confirmed turn and a prompt sheet without a second render loop or duplicate finish', async () => {
    const chunks: string[] = []
    const gw = new FakeGateway()
    const tern = fakeTern()
    const { App } = await import('../app/chat.js')
    const app = new App(tern.session, gw.client, '', {
      launch: readLaunchEnv({}),
      writeHost: chunk => void chunks.push(chunk)
    })
    const done = app.run()
    given.session(app, 'runtime-parent')
    gw.event({ payload: {}, session_id: 'runtime-parent', type: 'message.start' })
    expect(chunks).toEqual([WORKING])
    const sheet = stubOverlay('prompt:one', { modal: true })
    app.open(sheet)
    expect(chunks).toEqual([WORKING, WAITING, REQUIRED])
    app.close(sheet)
    expect(chunks).toEqual([WORKING, WAITING, REQUIRED, WORKING])
    gw.event({ payload: { status: 'complete', text: 'done' }, session_id: 'runtime-parent', type: 'message.complete' })
    expect(chunks).toEqual([WORKING, WAITING, REQUIRED, WORKING, CLEAR, FINISHED])
    app.quit()
    await done
  })
})
