import { afterAll, describe, expect, it, vi } from 'vitest'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// CACHE is read when artifacts.ts loads, so point it at a throwaway directory first.
const { cache, fetchMock } = vi.hoisted(() => {
  const cache = `/tmp/tern-artifact-cache-${process.pid}`
  process.env['XDG_CACHE_HOME'] = cache
  return { cache, fetchMock: vi.fn() }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, '', ''))
}))
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
}))
vi.mock('undici', () => ({ Agent: class {}, fetch: fetchMock }))

import { execFile } from 'node:child_process'
import { openArtifact } from '../artifacts.js'

function response(chunks: unknown[]) {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    body: {
      cancel: vi.fn(() => Promise.resolve()),
      async *[Symbol.asyncIterator]() {
        yield* chunks
      }
    }
  }
}

afterAll(() => {
  rmSync(cache, { recursive: true, force: true })
})

describe('remote model download', () => {
  it('rejects a body chunk that is not bytes, and leaves no cached or partial file', async () => {
    vi.stubEnv('TERN_PANE', '123')
    fetchMock.mockResolvedValueOnce(response([new Uint8Array([1, 2]), 'not bytes']))
    await expect(openArtifact('https://models.example.com/robot.glb')).rejects.toThrow('non-byte chunk')
    expect(execFile).not.toHaveBeenCalled()
    const root = join(cache, 'hermes-tern', 'artifacts')
    for (const dir of readdirSync(root)) {
      expect(readdirSync(join(root, dir))).toEqual([])
    }
  })

  it('writes byte chunks and opens the cached model', async () => {
    vi.stubEnv('TERN_PANE', '123')
    fetchMock.mockResolvedValueOnce(response([new Uint8Array([1, 2]), new Uint8Array([3])]))
    const path = await openArtifact('https://models.example.com/ok.glb')
    expect(path.startsWith(join(cache, 'hermes-tern', 'artifacts'))).toBe(true)
    expect(execFile).toHaveBeenCalledWith('tern', ['open', '--split', 'right', path], { timeout: 15_000 }, expect.any(Function))
  })
})
