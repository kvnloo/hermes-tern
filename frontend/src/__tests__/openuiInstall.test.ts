// Frozen-install regression: the existing real packaged suite must run without nested npm ci.
// All expected versions and integrity values come from the unchanged donor lock.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

type Workspace = { name?: string; version?: string; dependencies?: Record<string, string> }
type BunLock = { workspaces: Record<string, Workspace>; packages: Record<string, unknown[]> }
type NpmLock = { packages: Record<string, { version?: string; integrity?: string }> }

const root = new URL('../../', import.meta.url)
const generator = new URL('openui/openui-generation/', root)
const parserRequire = createRequire(fileURLToPath(new URL('package.json', generator)))

async function loadJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, 'utf8')) as T
}

describe('OpenUI dependencies in the standard frozen Bun install', () => {
  it('registers the donor parser as a self-contained workspace, not a test-time npm install', async () => {
    const frontend = await loadJson<{ workspaces?: { packages?: string[]; selfContained?: string[] } }>(new URL('package.json', root))
    const generation = await loadJson<{ name: string; version: string; dependencies: Record<string, string> }>(new URL('package.json', generator))
    const lockText = await readFile(new URL('bun.lock', root), 'utf8')
    const lock = JSON.parse(lockText.replace(/,\s*([}\]])/g, '$1')) as BunLock
    const donor = await loadJson<NpmLock>(new URL('package-lock.json', generator))

    expect(frontend.workspaces?.packages).toContain('openui/openui-generation')
    expect(frontend.workspaces?.selfContained).toContain('openui/openui-generation')
    expect(generation.dependencies).toEqual({ '@openuidev/lang-core': '0.3.1', zod: '4.0.0' })
    expect(lock.workspaces['openui/openui-generation']).toMatchObject({
      name: generation.name, version: generation.version, dependencies: generation.dependencies
    })
    expect(lock.packages[generation.name]?.[0]).toBe(
      'hermes-openui-generation-experiment@workspace:openui/openui-generation'
    )

    for (const [key, installed] of [
      ['@openuidev/lang-core', '@openuidev/lang-core'],
      ['ci-info', 'ci-info'],
      ['hermes-openui-generation-experiment/zod', 'zod']
    ] as const) {
      const original = donor.packages[`node_modules/${installed}`]
      expect(original?.integrity).toMatch(/^sha512-/)
      expect(lock.packages[key]?.[0]).toBe(`${installed}@${original?.version}`)
      expect(lock.packages[key]?.[3]).toBe(original?.integrity)
    }
    expect(lock.packages['@openuidev/lang-core']?.[2]).toMatchObject({
      hasInstallScript: true,
      optionalPeers: ['@modelcontextprotocol/sdk'],
      dependencies: { 'ci-info': '^4.4.0' }
    })
    expect(lock.packages['zod']?.[0]).toBe('zod@4.4.3')
  })

  it('resolves the exact generation-local Zod instead of the frontend Zod', async () => {
    const manifest = await loadJson<{ version: string }>(pathToFileURL(parserRequire.resolve('zod/package.json')))
    expect(manifest.version).toBe('4.0.0')
  })
})
