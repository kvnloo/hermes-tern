// Completed tools can publish models beside their chat. Tern owns the renderer and orbit controls.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { ToolCall } from './model.js'
import { parseJson, record } from './wire/json.js'

const run = promisify(execFile)
const MODEL = /\.(?:glb|gltf|obj|fbx|usdz)$/i
const MAX_BYTES = 128 * 1024 * 1024
const CACHE = join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'hermes-tern', 'artifacts')

/** File extension without a signed URL's query string. */
function extension(source: string): string {
  try {
    return extname(new URL(source).pathname).toLowerCase()
  } catch {
    return extname(source).toLowerCase()
  }
}

/** Structured MCP content, JSON strings, Markdown links and ordinary paths. Never inspect tool arguments. */
export function modelSources(value: unknown): string[] {
  const found = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 16) {
      return
    }
    if (typeof v === 'string') {
      const text = v.trim()
      if (MODEL.test(extension(text)) && !/[\n\r]/.test(text) && (!/\s/.test(text) || /^(?:\/|\.{1,2}\/|~\/|file:\/\/)/.test(text))) {
        found.add(text)
        return
      }
      const parsed = parseJson(text)
      if (parsed !== undefined) {
        walk(parsed, depth + 1)
        return
      }
      for (const match of text.matchAll(/(?:https?:\/\/|file:\/\/|\/|\.\.?\/|~\/)[^\s<>"'`]*?\.(?:glb|gltf|obj|fbx|usdz)(?:\?[^\s<>"'`)]*)?(?=$|[\s<>"'`)\],;])/gi)) {
        found.add(match[0])
      }
    } else if (Array.isArray(v)) {
      for (const item of v) {
        walk(item, depth + 1)
      }
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) {
        walk(item, depth + 1)
      }
    }
  }
  walk(value, 0)
  // Meshy returns several exports of one model. Prefer its portable, embedded GLB.
  const all = [...found]
  return all.some(src => extension(src) === '.glb') ? all.filter(src => extension(src) === '.glb') : all
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Reject mapped IPv4, loopback, link-local, unique-local and multicast ranges.
    return /^2[0-9a-f]{3}:/i.test(address)
  }
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127)
}

/** Do not turn model links in untrusted tool output into access to local services. */
async function remoteURL(source: string): Promise<URL> {
  const url = new URL(source)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Model downloads require an HTTP(S) URL without credentials')
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) {
    throw new Error('Model downloads require a public network address')
  }
  return url
}

async function download(source: string, target: string): Promise<void> {
  let url = await remoteURL(source)
  const signal = AbortSignal.timeout(60_000)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel()
      url = await remoteURL(new URL(location, url).href)
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed (HTTP ${response.status})`)
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel()
      throw new Error('Model exceeds the 128 MiB download limit')
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > MAX_BYTES) {
        throw new Error('Model exceeds the 128 MiB download limit')
      }
      chunks.push(chunk)
    }
    await writeFile(target, Buffer.concat(chunks), { mode: 0o600 })
    return
  }
  throw new Error('Too many model download redirects')
}

/** Fetch only relative companions under the model's directory. No absolute paths or traversal. */
async function companions(source: string, path: string): Promise<void> {
  const ext = extension(source)
  if (ext !== '.gltf' && ext !== '.obj') {
    return
  }
  const text = await readFile(path, 'utf8')
  let refs: string[]
  if (ext === '.gltf') {
    const doc = record(parseJson(text))
    if (!doc) {
      throw new Error('Invalid glTF document')
    }
    const resources = [doc['buffers'], doc['images']].flatMap(items => Array.isArray(items) ? items : [])
    refs = resources.flatMap(item => {
      const uri = record(item)?.['uri']
      return typeof uri === 'string' && !uri.startsWith('data:') ? [uri] : []
    })
  } else {
    refs = [...text.matchAll(/^mtllib\s+(.+)$/gm)].map(m => (m[1] ?? '').trim()).filter(Boolean)
  }
  if (refs.length > 64) {
    throw new Error('Model has more than 64 companion files. Use an embedded GLB instead.')
  }
  for (const ref of new Set(refs)) {
    if (/^[\w.+-]+:|^[/\\]|[?#]/.test(ref) || ref.split(/[/\\]/).includes('..')) {
      throw new Error('Model has an external companion. Use an embedded GLB instead.')
    }
    const target = resolve(dirname(path), ref)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await download(new URL(ref, source).href, target)
  }
}

/** Cache remote bytes atomically, then ask Tern to show a native file block. No CDN or viewer server. */
export async function openArtifact(source: string, cwd = process.cwd()): Promise<string> {
  if (!process.env['TERN_PANE']) {
    throw new Error('Open 3D models from a Hermes chat inside Tern')
  }
  let path: string
  if (/^https?:\/\//i.test(source)) {
    const ext = extension(source)
    if (!MODEL.test(ext)) {
      throw new Error('Use a .glb, .gltf, .obj, .fbx or .usdz URL')
    }
    const dir = join(CACHE, createHash('sha256').update(source).digest('hex'))
    path = join(dir, `model${ext}`)
    try {
      await stat(join(dir, '.complete'))
    } catch {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temp = `${path}.${process.pid}.part`
      try {
        await download(source, temp)
        await companions(source, temp)
        await rename(temp, path)
        await writeFile(join(dir, '.complete'), '', { mode: 0o600 })
      } finally {
        await rm(temp, { force: true })
      }
    }
  } else {
    path = source.startsWith('file://') ? fileURLToPath(source) : resolve(cwd, source.replace(/^~(?=\/)/, homedir()))
    if (!MODEL.test(extension(path))) {
      throw new Error('Use a .glb, .gltf, .obj, .fbx or .usdz file')
    }
    if (!(await stat(path)).isFile()) {
      throw new Error('Model path is not a file')
    }
  }
  await run('tern', ['open', '--split', 'right', path], { timeout: 15_000 })
  return path
}

/** Live completions only. History replays must not open blocks or fetch old signed URLs. */
export class Artifacts {
  readonly #seen = new Set<string>()

  show(call: ToolCall | undefined, cwd: string, notice: (text: string) => void): void {
    if (!call || call.outcome.kind !== 'done' || record(call.result)?.['success'] === false || record(call.result)?.['isError'] === true) {
      return
    }
    for (const source of modelSources([call.result, call.resultText])) {
      if (this.#seen.has(source)) {
        continue
      }
      this.#seen.add(source)
      void openArtifact(source, cwd).catch(() => {
        this.#seen.delete(source)
        // Do not echo signed asset URLs (which can contain credentials) in notices.
        notice('Could not open the 3D artifact. Use /view3d with a local model file to retry.')
      })
    }
  }
}
