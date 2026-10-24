import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, '', ''))
}))

import { execFile } from 'node:child_process'
import { Artifacts, modelSources, openArtifact } from '../artifacts.js'
import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('modelSources', () => {
  it('reads Meshy MCP JSON inside text content and prefers GLB to alternate exports', () => {
    const url = 'https://assets.meshy.ai/task/model.glb?Expires=123&Signature=private'
    expect(modelSources({ content: [{ type: 'text', text: JSON.stringify({ model_urls: { glb: url, fbx: 'https://assets.meshy.ai/task/model.fbx' } }) }] })).toEqual([url])
  })
  it('finds model paths in Markdown, prose and Meshy directives', () => {
    expect(modelSources('Saved /tmp/robot.glb\n::meshy-model{path="/tmp/robot.glb"}\n[model](https://example.com/a.glb?token=abc)')).toEqual(['/tmp/robot.glb', 'https://example.com/a.glb?token=abc'])
  })
  it('accepts all requested formats, relative files and paths with spaces', () => {
    for (const ext of ['glb', 'gltf', 'obj', 'fbx', 'usdz']) {
      expect(modelSources({ path: `models/robot.${ext}` })).toEqual([`models/robot.${ext}`])
      expect(modelSources({ path: `/tmp/my robot.${ext}` })).toEqual([`/tmp/my robot.${ext}`])
    }
  })
  it('does not interpret a whole prose sentence as a path', () => {
    expect(modelSources('The model is at /tmp/robot.glb')).toEqual(['/tmp/robot.glb'])
    expect(modelSources({ progress: 30, image: '/tmp/thumbnail.png', url: 'https://example.com/model.glb.html' })).toEqual([])
  })
})

describe('native artifact opening', () => {
  it('refuses to start Tern outside a pane', async () => {
    vi.stubEnv('TERN_PANE', '')
    await expect(openArtifact('/tmp/model.glb')).rejects.toThrow('inside Tern')
    expect(execFile).not.toHaveBeenCalled()
  })
  it('opens a relative local file using argument-safe native split, not a shell', async () => {
    vi.stubEnv('TERN_PANE', '123')
    const dir = await mkdtemp(join(tmpdir(), 'tern-artifact-'))
    dirs.push(dir)
    const filename = 'robot; echo unsafe.glb'
    await writeFile(join(dir, filename), 'unit-test bytes')
    await expect(openArtifact(filename, dir)).resolves.toBe(join(dir, filename))
    expect(execFile).toHaveBeenCalledWith('tern', ['open', '--split', 'right', join(dir, filename)], { timeout: 15_000 }, expect.any(Function))
  })
  it('refuses private network URLs before fetch', async () => {
    vi.stubEnv('TERN_PANE', '123')
    await expect(openArtifact('http://127.0.0.1/model.glb')).rejects.toThrow('public network')
    expect(execFile).not.toHaveBeenCalled()
  })
  it('opens a completed result once, but never opens failed or running calls', async () => {
    vi.stubEnv('TERN_PANE', '123')
    const dir = await mkdtemp(join(tmpdir(), 'tern-artifact-'))
    dirs.push(dir)
    await writeFile(join(dir, 'robot.glb'), 'unit-test bytes')
    const artifacts = new Artifacts()
    const notice = vi.fn()
    const call: ToolCall = { id: toolCallId('model'), name: 'mcp__meshy__meshy_download_model', args: {}, argsText: '', context: '', startedAt: 0, outcome: { kind: 'running' }, result: { path: 'robot.glb' }, via: { kind: 'direct' } }
    artifacts.show(call, dir, notice)
    call.outcome = { kind: 'error', duration: 1 }
    artifacts.show(call, dir, notice)
    expect(execFile).not.toHaveBeenCalled()
    call.outcome = { kind: 'done', duration: 1 }
    artifacts.show(call, dir, notice)
    artifacts.show(call, dir, notice)
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1))
    expect(notice).not.toHaveBeenCalled()
  })
})
