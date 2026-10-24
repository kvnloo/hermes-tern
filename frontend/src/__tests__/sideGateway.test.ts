import { describe, expect, it } from 'vitest'

import { BtwThreads } from '../btw.js'
import { PluginGatewayUnavailable, btwEvent, listBtw, readOperational } from '../wire/side.js'

import { FakeGateway } from './fakes.js'
import { sideSetup } from './sideSetup.js'

const sample = {
  id: 'side-a', revision: 3,
  turns: [{ id: 'turn-a', question: 'Unicode 🦉', answer: 'Outside main', state: 'answered' as const }]
}

describe('public registered Hermes gateway methods', () => {
  it('refuses a gateway with no plugin capability before any BTW request', async () => {
    const gw = new FakeGateway()
    await expect(listBtw(gw.client, 'live-a')).rejects.toBeInstanceOf(PluginGatewayUnavailable)
    expect(gw.sent('gateway.capabilities')).toEqual([{ session_id: 'live-a' }])
    expect(gw.methods('hermes-tern.btw.list')).toHaveLength(0)
    expect(gw.methods('btw.list')).toHaveLength(0)
    expect(gw.methods('prompt.btw')).toHaveLength(0)
  })

  it('denies malformed, other-plugin and detached capabilities', async () => {
    const gw = new FakeGateway({ replies: {
      'gateway.capabilities': () => ({ plugin_methods: ['other.btw.list'] })
    } })
    await expect(listBtw(gw.client, 'live-a')).rejects.toBeInstanceOf(PluginGatewayUnavailable)
    gw.handlers.set('gateway.capabilities', () => ({ plugin_methods: false }))
    await expect(listBtw(gw.client, 'live-a')).rejects.toBeInstanceOf(PluginGatewayUnavailable)
    gw.handlers.set('gateway.capabilities', () => { throw new Error('not attached') })
    await expect(listBtw(gw.client, 'live-a')).rejects.toBeInstanceOf(PluginGatewayUnavailable)
    expect(gw.methods('hermes-tern.btw.list')).toHaveLength(0)
  })

  it('reads only registered operational report, and rejects mismatched views', async () => {
    const gw = new FakeGateway({ replies: {
      'hermes-tern.operations.report': () => ({
        view: 'mcp-list', scope: 'owned', state: 'ready', read_only: true, rows: [], message: 'actual config'
      })
    } })
    expect((await readOperational(gw.client, 'live-a', 'mcp-list')).scope).toBe('owned')
    expect(gw.sent('hermes-tern.operations.report')).toEqual([
      { session_id: 'live-a', view: 'mcp-list' }
    ])
    await expect(readOperational(gw.client, 'live-a', 'ssh-list')).rejects.toThrow('Mismatched operational view')
  })

  it('keeps the new side question unsent when no public BTW method exists', async () => {
    const f = sideSetup()
    const model = new BtwThreads(f.host)
    await model.show('Side 🦉')
    expect(model.error).toContain('Needs Hermes plugin gateway methods')
    expect(model.draft.text).toBe('Side 🦉')
    expect(f.gw.methods('hermes-tern.btw.list')).toHaveLength(0)
    expect(f.gw.methods('prompt.submit')).toHaveLength(0)
    expect(f.gw.methods('prompt.btw')).toHaveLength(0)
  })

  it('accepts the real namespaced side event envelope, but no foreign plugin', () => {
    const raw = {
      type: 'plugin.event', session_id: 'live-a',
      payload: {
        plugin: 'hermes-tern', event_name: 'hermes-tern.btw.update',
        profile: 'owned', data: { thread: sample }
      }
    }
    expect(btwEvent(raw).success).toBe(true)
    expect(btwEvent({ ...raw, payload: { ...raw.payload, plugin: 'other' } }).success).toBe(false)
    expect(btwEvent({ ...raw, payload: { ...raw.payload, event_name: 'hermes-tern.other.event' } }).success).toBe(false)
  })
})
