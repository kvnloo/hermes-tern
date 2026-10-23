import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { localCommand } from '../commands/local.js'
import { preference, PROFILE_PREFERENCES } from '../preferences/contracts.js'
import { readProfile, writeProfile } from '../preferences/transactions.js'
import { openSettings } from '../overlays/settings.js'
import { openModelHub } from '../overlays/modelHub.js'
import { record } from '../wire/json.js'

import { settle, setup } from './appSetup.js'
import { key, must, stub, tree } from './fakes.js'
import type { GatewayClient } from '@tui/gatewayClient.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const starting = () => new Map(PROFILE_PREFERENCES.map(field => [field.key, field.options?.[0] ?? 'default']))

function prefsJson(node: NodeJson): Record<string, unknown> {
  expect(node.k).toBe('prefs')
  return node.p ?? {}
}

function ids(p: Record<string, unknown>): string[] {
  const sections = p['sections']

  if (!Array.isArray(sections)) {
    throw new Error('Tern prefs sections did not render')
  }

  return sections.flatMap(s => {
    const section = record(s)
    const rows = section?.['rows']

    return Array.isArray(rows) ? rows.flatMap(r => {
      const id = record(r)?.['id']
      return typeof id === 'string' ? [id] : []
    }) : []
  })
}

function fixture() {
  const values = starting()
  const replies = {
    'config.get': (params: Record<string, unknown>) => ({ value: values.get(String(params['key'])) }),
    'config.set': (params: Record<string, unknown>) => {
      const field = String(params['key'])
      const value = String(params['value'])
      values.set(field, value)
      return { key: field, value }
    },
    'model.options': () => ({
      model: 'model-one',
      provider: 'safe-provider',
      providers: [
        { slug: 'safe-provider', name: 'Safe provider', authenticated: true, models: ['model-one', 'model-two'], api_url: 'https://secret.invalid/?credential=must-not-render' },
        { slug: 'locked-provider', name: 'Locked provider', authenticated: false, models: [] }
      ]
    })
  }

  return { replies, values }
}

describe('native Settings registrations and real App rendering', () => {
  it('registers /settings, /prefs and /models without replacing /model', () => {
    expect(localCommand('settings')?.name).toBe('settings')
    expect(localCommand('prefs')?.name).toBe('prefs')
    expect(localCommand('models')?.name).toBe('models')
    expect(localCommand('model')?.name).toBe('model')
  })

  it('does no settings/model-hub read on closed startup or ordinary frames; paints native schema-supported field types on open', async () => {
    const { replies } = fixture()
    const { app, press, sent, type } = setup(replies)
    const config = () => sent('config.get').filter(p => PROFILE_PREFERENCES.some(f => f.key === p['key']))

    expect(config()).toEqual([])
    expect(sent('model.options')).toEqual([])
    await type('/settings')
    await press(key('enter'))
    await vi.waitFor(() => expect(config()).toHaveLength(PROFILE_PREFERENCES.length))
    expect(sent('config.get').some(p => p['key'] === 'full' && p['source'] === 'settings')).toBe(false)
    expect(sent('settings.get')).toEqual([])
    expect(sent('settings.set')).toEqual([])

    const overlay = must(app.overlays.find(o => o.key === 'settings'))
    const session = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(session)).toContain('session.model')
    expect(ids(session)).toContain('session.effort')
    expect(ids(session)).toContain('session.hub')
    expect(session['pages']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile.Agent' }),
      expect.objectContaining({ id: 'profile.Safety' }),
      expect.objectContaining({ id: 'profile.Display' })
    ]))

    await press(key('tab'))
    const agent = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(agent)).toContain('busy')
    expect(JSON.stringify(agent)).toContain('"k":"choice"')

    await press(key('tab'))
    const safety = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(safety)).toContain('approvals.mode')
    expect(JSON.stringify(safety)).toContain('manual')

    await press(key('tab'))
    const display = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(display)).toEqual(expect.arrayContaining(['details_mode', 'thinking_mode', 'theme', 'density', 'focus', 'skin']))
    expect(JSON.stringify(display)).toContain('"k":"switch"')
    expect(JSON.stringify(display)).toContain('"k":"text"')
  })

  it('writes only the active profile key, confirms readback, preserves the main composer caret/undo and its paste markers', async () => {
    const { replies, values } = fixture()
    const { app, press, sent } = setup(replies)
    app.stores.composer.set('Café 🧩 literal', { cursor: 4, pasted: ['!echo do-not-execute'] })
    const before = { text: app.stores.composer.text, cursor: app.stores.composer.cursor, pasted: [...app.stores.composer.pasted] }

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(1))
    await settle()
    await press(key('tab'))
    await press(key('enter'))
    await press(key('down'))
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('config.set')).toEqual([{ key: 'busy', value: 'steer', session_id: 's1' }]))
    await vi.waitFor(() => expect(values.get('busy')).toBe('steer'))
    expect(app.stores.composer.text).toBe(before.text)
    expect(app.stores.composer.cursor).toBe(before.cursor)
    expect(app.stores.composer.pasted).toEqual(before.pasted)
    expect(sent('shell.exec')).toEqual([])
    expect(sent('model.hub.set')).toEqual([])
  })

  it('does not treat Enter or Escape as approval confirmation, even for an explicit security-policy change', async () => {
    const { replies, values } = fixture()
    const { app, press, sent } = setup(replies)

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'approvals.mode')).toHaveLength(1))
    await settle()
    await press(key('tab'))
    await press(key('tab'))
    await press(key('enter'))
    await press(key('down'))
    await press(key('enter'))
    const confirm = must(app.overlays.find(o => o.key === 'settings'))
    expect(tree(confirm.node('layer.settings')).k).toBe('overlay')
    expect(JSON.stringify(tree(confirm.node('layer.settings')))).toContain('Confirm profile policy change')
    await press(key('enter'))
    expect(sent('config.set')).toEqual([])
    expect(values.get('approvals.mode')).toBe('manual')
  })

  it('drops late overlay reads after closing, replacing or switching sessions', async () => {
    const first = Promise.withResolvers<{ value: string }>()
    const values = starting()
    let busyReads = 0
    const { app, press, sent } = setup({
      'config.get': params => {
        if (params['key'] === 'busy' && ++busyReads === 1) {
          return first.promise
        }
        return { value: values.get(String(params['key'])) }
      }
    })

    openSettings(app)
    expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(1)
    const old = must(app.overlays.find(o => o.key === 'settings'))
    await press(key('escape'))
    expect(app.overlays.includes(old)).toBe(false)
    first.resolve({ value: 'steer' })
    await settle()
    expect(sent('config.set')).toEqual([])

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(2))
    await settle()
    expect(tree(must(app.overlays.find(o => o.key === 'settings')).node('layer.settings')).k).toBe('prefs')
  })

  it('uses the live gateway provider inventory with no role/fallback RPCs or leaked endpoints', async () => {
    const { replies } = fixture()
    const { app, sent } = setup(replies)

    expect(sent('model.options')).toEqual([])
    openModelHub(app)
    await vi.waitFor(() => expect(sent('model.options')).toHaveLength(1))
    const hub = must(app.overlays.find(o => o.key === 'model-hub'))
    const rendered = JSON.stringify(tree(hub.node('layer.model-hub')))
    expect(rendered).toContain('Safe provider')
    expect(rendered).toContain('Locked provider')
    expect(rendered).toContain('Auxiliary role assignments')
    expect(rendered).not.toContain('credential=must-not-render')
    expect(sent('model.hub.get')).toEqual([])
    expect(sent('model.hub.set')).toEqual([])
    expect(sent('config.set')).toEqual([])
  })
})

describe('pinned Hermes Settings transaction and isolation contract', () => {
  const gateway = (handler: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown) =>
    stub<GatewayClient>({ request: handler })

  it('never requests full config or unknown fields and uses the session profile on every supported read', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const values = starting()
    const gw = gateway((method, params) => {
      calls.push({ method, params })
      return { value: values.get(String(params['key'])) }
    })
    const rows = await readProfile({ active: () => true, gw, sid: 'profile-a-session' })
    expect(rows.map(row => row.field.key)).toEqual(PROFILE_PREFERENCES.map(field => field.key))
    expect(calls).toHaveLength(PROFILE_PREFERENCES.length)
    expect(calls.every(call => call.method === 'config.get' && call.params['session_id'] === 'profile-a-session' && call.params['key'] !== 'full')).toBe(true)
  })

  it('rejects a conflicting owner read before write instead of bumping a silent revision', async () => {
    const calls: string[] = []
    const gw = gateway((method, params) => {
      calls.push(method)
      return { value: params['key'] === 'busy' ? 'interrupt' : '' }
    })
    const field = must(preference('busy'))
    await expect(writeProfile({ active: () => true, gw, sid: 's1' }, field, 'steer', 'queue')).rejects.toThrow('Profile changed')
    expect(calls).toEqual(['config.get'])
  })

  it('never calls config.set after the sheet became stale while the canonical read was in flight', async () => {
    const first = Promise.withResolvers<unknown>()
    const calls: string[] = []
    let alive = true
    const gw = gateway((method) => { calls.push(method); return first.promise })
    const write = writeProfile({ active: () => alive, gw, sid: 's1' }, must(preference('busy')), 'steer', 'queue')
    await vi.waitFor(() => expect(calls).toEqual(['config.get']))
    alive = false
    first.resolve({ value: 'queue' })
    await expect(write).rejects.toThrow('Settings session changed')
    expect(calls).toEqual(['config.get'])
  })

  it('reports contradictory ACK/readback and does not present a success receipt', async () => {
    let gets = 0
    const gw = gateway((method, params) => {
      if (method === 'config.get') {
        return { value: ++gets === 1 ? 'queue' : 'interrupt' }
      }
      return { key: params['key'], value: params['value'] }
    })
    await expect(writeProfile({ active: () => true, gw, sid: 's1' }, must(preference('busy')), 'steer', 'queue')).rejects.toThrow('Canonical readback differs')
  })

  it('rejects undeclared setting values and cannot use a generic secret/role/fallback key', async () => {
    expect(() => preferenceValue(must(preference('approvals.mode')), 'administrator')).toThrow()
    expect(preference('providers.openai.api_key')).toBeUndefined()
    expect(preference('agent.fallbacks')).toBeUndefined()
    expect(preference('auxiliary.vision')).toBeUndefined()
  })
})
