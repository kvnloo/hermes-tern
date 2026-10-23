import { describe, expect, it } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { ternTargetOf } from '../tools/browser.js'
import { viewOf } from '../view/tools/registry.js'
import { browserTarget, listBrowserBlocks, releaseBrowserBlock, validBrowserFrame } from '../wire/browser.js'

import { FakeGateway } from './fakes.js'

const block = { target_id: '7', title: 'User page', url: 'https://example.org/', owner: null, owned: false, available: true }
const target = { target_id: '7', title: block.title, url: block.url, in_tern: true, frame: 'main' }

const call = (name: string, result: unknown): ToolCall => ({
  args: {},
  argsText: '',
  context: '',
  id: toolCallId('browser-test'),
  name,
  outcome: { kind: 'done', duration: 2 },
  result,
  startedAt: 0,
  via: { kind: 'direct' }
})

describe('browser block gateway boundary', () => {
  it('lists only, preserving live ownership fields and the exact session scope', async () => {
    const gateway = new FakeGateway({ replies: { 'browser.blocks': () => ({ available: true, blocks: [block] }) } })
    await expect(listBrowserBlocks(gateway.client, 's1')).resolves.toEqual({ available: true, blocks: [block] })
    expect(gateway.calls).toEqual([{ method: 'browser.blocks', params: { session_id: 's1' } }])
  })

  it('rejects malformed listing identities and owner flags', async () => {
    const gateway = new FakeGateway({ replies: { 'browser.blocks': () => ({ available: true, blocks: [{ ...block, target_id: '0' }] }) } })
    await expect(listBrowserBlocks(gateway.client, 's1')).rejects.toThrow('Invalid browser.blocks')
    gateway.handlers.set('browser.blocks', () => ({ available: true, blocks: [{ ...block, owner: 'someone' }] }))
    await expect(listBrowserBlocks(gateway.client, 's1')).rejects.toThrow('Invalid browser.blocks')
    gateway.handlers.set('browser.blocks', () => ({ blocks: [] }))
    await expect(listBrowserBlocks(gateway.client, 's1')).rejects.toThrow('Invalid browser.blocks')
  })

  it('uses distinct focus, handover, frame and release intents; requires backend confirmation', async () => {
    const gateway = new FakeGateway({ replies: {
      'browser.focus': () => target,
      'browser.adopt': () => target,
      'browser.frame': () => target,
      'browser.release': () => ({ target_id: '7', released: true })
    } })
    await browserTarget(gateway.client, 'browser.focus', 's1', '7')
    await browserTarget(gateway.client, 'browser.adopt', 's1', '7')
    await browserTarget(gateway.client, 'browser.frame', 's1', '7', 'main')
    await releaseBrowserBlock(gateway.client, 's1', '7')
    expect(gateway.calls).toEqual([
      { method: 'browser.focus', params: { session_id: 's1', target_id: '7' } },
      { method: 'browser.adopt', params: { session_id: 's1', target_id: '7' } },
      { method: 'browser.frame', params: { session_id: 's1', target_id: '7', frame: 'main' } },
      { method: 'browser.release', params: { session_id: 's1', target_id: '7' } }
    ])
    gateway.handlers.set('browser.release', () => ({ target_id: '7', released: false }))
    await expect(releaseBrowserBlock(gateway.client, 's1', '7')).rejects.toThrow('did not confirm')
    gateway.handlers.set('browser.focus', () => ({ ...target, target_id: '8' }))
    await expect(browserTarget(gateway.client, 'browser.focus', 's1', '7')).rejects.toThrow('Invalid browser target')
  })

  it('refuses unchecked identifiers and frame paths without contacting the gateway', async () => {
    const gateway = new FakeGateway()
    expect(['main', '0', '1.0', '0.12.3'].every(validBrowserFrame)).toBe(true)
    expect(['', 'top', '0.foo', '1..0', '-1', '01', 'window.open(1)'].some(validBrowserFrame)).toBe(false)
    await expect(browserTarget(gateway.client, 'browser.focus', 's1', '@focused')).rejects.toThrow('Invalid Tern')
    await expect(browserTarget(gateway.client, 'browser.frame', 's1', '7', 'window.open(1)')).rejects.toThrow('exact frame')
    await expect(releaseBrowserBlock(gateway.client, 's1', '0')).rejects.toThrow('Invalid Tern')
    expect(gateway.calls).toEqual([])
  })

  it('leaves a gateway without these methods unsupported, never changing browser mode', async () => {
    const gateway = new FakeGateway({ replies: { 'browser.blocks': () => { throw new Error('Method not found') } } })
    await expect(listBrowserBlocks(gateway.client, 's1')).rejects.toThrow('Method not found')
    expect(gateway.calls.map(c => c.method)).toEqual(['browser.blocks'])
  })
})

describe('browser tool card', () => {
  it('annotates confirmed Tern identity in the existing registry, including stored JSON', () => {
    const c = call('browser_navigate', JSON.stringify({ success: true, tern_target: target }))
    const card = viewOf(c).card(0)
    expect(ternTargetOf(c)).toEqual({ target_id: '7', title: 'User page', url: 'https://example.org/', frame: 'main' })
    expect(card).toMatchObject({
      name: 'browser',
      target: 'https://example.org/',
      targetKind: 'path',
      folded: false
    })
    expect(card.meta).toEqual(['User page', 'in Tern block 7', 'evaluation frame main'])
  })

  it('does not promote CDP, malformed or unrelated tool results into Tern authority', () => {
    for (const result of [
      { tern_target: { ...target, in_tern: false } },
      { tern_target: { ...target, target_id: '@focused' } },
      { tern_target: { ...target, title: 3 } }
    ]) {
      expect(ternTargetOf(call('browser_vision', result))).toBeUndefined()
      expect(viewOf(call('browser_vision', result)).card(0).meta).toBeUndefined()
    }

    expect(ternTargetOf(call('terminal', { tern_target: target }))).toBeUndefined()
  })
})
