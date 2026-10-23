import type { ModelOptionsResult } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import type { ModelsHost } from '../overlays/models.js'
import type { Overlay } from '../overlays/overlay.js'
import { liveSessionId } from '../core/ids.js'
import { SessionState } from '../session/state.js'
import { FakeGateway, key } from '../__tests__/fakes.js'

import { activeModel, availableModels, cycleModel, cycleTarget } from './model-cycle.js'
import { modelRecents } from './model-recents.js'

function options(models = ['alpha', 'beta', 'gamma']): ModelOptionsResult {
  return {
    model: 'alpha',
    provider: 'fixture',
    providers: [{ authenticated: true, is_current: true, models, name: 'Fixture', slug: 'fixture' }]
  }
}

function fixture(models = ['alpha', 'beta', 'gamma'], expensive = false) {
  let current = 'alpha'
  const gw = new FakeGateway({ canonical: false })
  const state = new SessionState(() => {})
  state.ref = { live: liveSessionId('s1'), stored: null }
  state.info = { model: 'alpha', provider: 'fixture' }
  const notice = vi.fn()
  const overlays: Overlay[] = []
  const changed = vi.fn()
  gw.handlers.set('model.options', () => ({ ...options(models), model: current }))
  gw.handlers.set('config.set', p => {
    if (expensive && !p['confirm_expensive_model']) {
      return { key: 'model', confirm_required: true, confirm_message: 'Expensive fixture' }
    }

    current = String(p['value']).split(' ')[0] ?? ''

    return { key: 'model', value: current }
  })
  const host = {
    gw: gw.client, session: state, transcript: { notice }, changed,
    open: (overlay: Overlay) => void overlays.push(overlay),
    close: (overlay: Overlay) => void overlays.splice(overlays.indexOf(overlay), 1),
    setEffort: async () => undefined
  } as unknown as ModelsHost

  return { gw, host, state, notice, overlays, changed }
}

describe('model recents and cycling', () => {
  it('filters unauthenticated and unavailable models and honors pending model intent', () => {
    const opts: ModelOptionsResult = {
      ...options(),
      pending_model: 'beta',
      pending_provider: 'fixture',
      providers: [
        { name: 'Fixture', slug: 'fixture', models: ['alpha', 'beta', 'gamma'], unavailable_models: ['gamma'], is_current: true },
        { name: 'Not configured', slug: 'absent', models: ['x'], authenticated: false }
      ]
    }
    expect(availableModels(opts)).toEqual([{ model: 'alpha', provider: 'fixture' }, { model: 'beta', provider: 'fixture' }])
    expect(activeModel(opts, { model: 'alpha', provider: 'fixture' })).toEqual({ model: 'beta', provider: 'fixture' })
  })

  it('starts with inventory, then tracks successful choices, resets for a new session', async () => {
    const f = fixture()
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('beta')
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('gamma')
    expect(modelRecents(f.state).list('s1').map(r => r.model)).toEqual(['beta', 'gamma'])
    await cycleModel(f.host, -1)
    expect(f.state.info?.model).toBe('beta')
    expect(f.gw.sent('config.set').every(p => p['session_id'] === 's1' && String(p['value']).includes('--session'))).toBe(true)
    f.state.ref = { live: liveSessionId('s2'), stored: null }
    expect(modelRecents(f.state).list('s2')).toEqual([])
  })

  it('serializes rapid key repeats and does not bypass expensive-model confirmation', async () => {
    const f = fixture(['alpha', 'beta'], true)
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('alpha')
    expect(f.overlays[0]?.key).toBe('confirm:Switch to an expensive model?')
    f.overlays[0]!.onKey(key('y'))
    await vi.waitFor(() => expect(f.state.info?.model).toBe('beta'))
    expect(f.gw.sent('config.set')).toEqual([
      { key: 'model', session_id: 's1', value: 'beta --provider fixture --session', confirm_expensive_model: false },
      { key: 'model', session_id: 's1', value: 'beta --provider fixture --session', confirm_expensive_model: true }
    ])
  })

  it('drops an old inventory reply after switching sessions', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ModelOptionsResult>()
    f.gw.handlers.set('model.options', () => pending.promise)
    const running = cycleModel(f.host, 1)
    f.state.ref = { live: liveSessionId('s2'), stored: null }
    pending.resolve(options())
    await running
    expect(f.gw.sent('config.set')).toEqual([])
  })

  it('cycles against explicit recent rows, with a one-model no-op', () => {
    const all = [
      { model: 'alpha', provider: 'p' },
      { model: 'beta', provider: 'p' },
      { model: 'gamma', provider: 'p' }
    ]
    expect(cycleTarget(all, [all[0]!, all[2]!], all[2]!, 1)).toEqual(all[0])
    expect(cycleTarget(all.slice(0, 1), [], all[0]!, 1)).toBeNull()
  })
})
