import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatPorts } from '../app/ports.js'
import { readPreparedVisual, readVisualFile, summarizeVisual, type VisualBundle, visualScope } from '../visuals.js'

import { stub } from './fakes.js'

const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function file(contents: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-openui-test-'))
  dirs.push(dir)
  const path = join(dir, 'prepared.hvisual.json')
  await writeFile(path, contents)

  return path
}

const bundle: VisualBundle = {
  id: 'a'.repeat(64),
  selection: { view: { mode: 'code', metrics: ['files', 'code', 'churn'] } },
  artifact: {
    document: {
      title: 'Fixture',
      root: { code: 8, churn: 3, children: [{ children: [] }, { children: [{ children: [] }, { children: [] }] }] }
    }
  }
}

function scope(live: string | null, stored: string | null, branch: string) {
  return visualScope(stub<Pick<ChatPorts, 'session'>>({ session: { ref: { live, stored }, info: { branch } } }))
}

describe('OpenUI prepared visual front end', () => {
  it('uses durable-session/branch scopes without delimiter ambiguity or sessionless preview', () => {
    expect(scope('runtime', 'stored', 'a:b')).toBe('["stored","a:b"]')
    expect(scope('runtime', null, '')).toBe('["runtime",""]')
    expect(scope(null, 'stored', 'main')).toBeUndefined()
    expect(scope('x'.repeat(256), null, '')).toBeUndefined()
  })

  it('projects requested metrics once without mutating the source', () => {
    const before = JSON.stringify(bundle)
    const summary = summarizeVisual(bundle)
    expect(summary.metrics.map(m => m.value)).toEqual([3, 8, 3])
    expect(summary.metrics.map(m => m.label)).toEqual(['Files', 'Text lines', 'File touches'])
    expect(JSON.stringify(bundle)).toBe(before)
    expect(Object.isFrozen(summary.metrics[0])).toBe(true)
  })

  it('counts zero descendant files for an empty repository root', () => {
    expect(summarizeVisual({ ...bundle, artifact: { document: {
      title: 'Empty', root: { code: 0, churn: 0, children: [] }
    } } }).metrics[0]?.value).toBe(0)
  })

  it('does not inspect the tree for unrequested file counts', () => {
    const noFiles: VisualBundle = {
      ...bundle,
      selection: { view: { mode: 'churn', metrics: ['churn'] } },
      artifact: {
        document: {
          title: 'No scan',
          root: {
            code: 5,
            churn: 2,
            get children(): never {
              throw new Error('unexpected traversal')
            }
          }
        }
      }
    }

    expect(summarizeVisual(noFiles).metrics).toEqual([{ key: 'churn', label: 'File touches', value: 2 }])
  })

  it('reads valid JSON up to the exact UTF-8 byte bound', async () => {
    const path = await file('{"x":"é"}')
    expect((await readVisualFile(path, 10)).input).toEqual({ x: 'é' })
    await expect(readVisualFile(path, 9)).rejects.toThrow('bounded regular file')
    await expect(readVisualFile(path, 8 * 1024 * 1024 + 1)).rejects.toThrow('size limit')
  })

  it('rejects relative and mistyped paths, directories, malformed JSON and invalid UTF-8', async () => {
    await expect(readVisualFile('prepared.hvisual.json', 32)).rejects.toThrow('absolute path')
    await expect(readVisualFile('/tmp/prepared.json', 32)).rejects.toThrow('absolute path')
    await expect(readVisualFile('/tmp/a\n.hvisual.json', 32)).rejects.toThrow()
    await expect(readVisualFile(await file('{'), 32)).rejects.toThrow()

    const invalid = await file(Buffer.from([0xff]))
    await expect(readVisualFile(invalid, 32)).rejects.toThrow()
    await rm(invalid)
    await mkdir(invalid)
    await expect(readVisualFile(invalid, 32)).rejects.toThrow('bounded regular file')
  })

  it('aborts before I/O and refuses to claim validation without the real donor', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readVisualFile('/missing.hvisual.json', 32, controller.signal)).rejects.toThrow()
    vi.stubEnv('HERMES_PYTHON_SRC_ROOT', '')
    await expect(readPreparedVisual('/tmp/missing.hvisual.json', '["stored","main"]')).rejects.toThrow('HERMES_PYTHON_SRC_ROOT')
  })
})
