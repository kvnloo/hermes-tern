import { describe, expect, it } from 'vitest'

import { projectToolMedia } from '../read-media.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'

import { must, stub, tree } from './fakes.js'
import { setup } from './mediaDeliveryFixtures.js'
import { call } from './toolFixtures.js'

// Captured from pinned tools.file_tools._dedup_stub_or_block with an in-memory
// tracker and path diagram.svg; the helper does not read the target file.
const stubResult = JSON.stringify({
  status: 'unchanged',
  message: 'File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.',
  path: 'diagram.svg', dedup: true, content_returned: false
})

const nodes = (value: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
  [value, ...(value.c ?? []).flatMap(nodes)]

describe('read media without returned content', () => {
  it('refuses the pinned unchanged SVG result in a live call and stored replay', () => {
    const transcript = new Transcript()
    transcript.messageStart()
    transcript.toolStart({ args: { path: 'diagram.svg' }, name: 'read_file', tool_id: 'live' })
    transcript.toolComplete({ name: 'read_file', result: stubResult, tool_id: 'live' })
    const live = must(transcript.calls('read_file')[0])

    const replay = new Transcript()
    replay.load(stub([
      { role: 'user', text: 'Read the figure' },
      { role: 'tool', name: 'read_file', args: { path: 'diagram.svg' }, content: stubResult, tool_call_id: 'stored' }
    ]))
    const stored = must(replay.calls('read_file')[0])
    const { delivery, gw, blob } = setup({ attached: false, native: true })

    for (const read of [live, stored]) {
      expect(read.outcome.kind).toBe('done')
      const card = tree(toolNode(read, 0, undefined, undefined, delivery))
      const detail = toolDetail(read, 0, undefined, undefined, delivery).map(tree)
      expect(nodes(card).some(n => n.k === 'media' || n.k === 'image')).toBe(false)
      expect(detail.flatMap(nodes).some(n => n.k === 'media' || n.k === 'image')).toBe(false)
      expect(projectToolMedia(read, delivery.context())).toBeUndefined()
    }
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()
  })

  it('rejects an explicit no-content result even with contradictory content in every host mode', () => {
    const contexts = [
      setup({ attached: false, native: true }), setup({ attached: false, native: false }),
      setup({ attached: true, native: true }), setup({ backend: null, native: true }),
      setup({ backend: 'docker', native: true })
    ]
    for (const { delivery, gw, blob } of contexts) {
      for (const path of ['diagram.svg', 'image.png', 'report.pdf', 'model.glb']) {
        const read = call('read_file', { path }, { result: {
          content_returned: false, content: 'contradictory data', is_image: true, resolved_path: '/gateway/' + path
        } })
        expect(projectToolMedia(read, delivery.context())).toBeUndefined()
        expect(nodes(tree(toolNode(read, 0, undefined, undefined, delivery))).some(n =>
          n.k === 'media' || n.k === 'image' || n.p?.['role'] === 'omp.media.notice')).toBe(false)
      }
      expect(gw.sent('hermes-tern.media.image')).toEqual([])
      expect(blob).not.toHaveBeenCalled()
    }
  })

  it('preserves completed binary, older absent-flag, explicit true, failed and truncated behavior', () => {
    const local = setup({ attached: false, native: true }).delivery.context()
    const remote = setup({ attached: true, native: true }).delivery.context()
    for (const result of [{ is_image: true, is_binary: true }, {}, { content_returned: true, content: '1|<svg/>' }]) {
      const read = call('read_file', { path: 'image.png' }, { result })
      expect(projectToolMedia(read, local)?.kind).toBe('node')
      expect(projectToolMedia(read, remote)?.kind).toBe('remote-image')
    }
    for (const result of [{ error: 'denied' }, { success: false }, { truncated: true }, { partial: true }]) {
      expect(projectToolMedia(call('read_file', { path: 'image.png' }, { result }), local)).toBeUndefined()
    }
  })
})
