// Tern loads confirmed local paths; cross-host images use SDK-owned blobs.
// Compute-host paths and non-image remote media remain explicitly unsupported.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { node, type Node } from '@stencil-hq/tern'

import { fileHref } from './links.js'
import type { ToolCall } from '../model.js'
import { mediaNode } from './media-node.js'
import { record } from '../wire/json.js'

interface ArtifactOwner {
  readonly callId: string
  /** Presentation identity only, never a Tern git revision or a blob id. */
  readonly revision: string
}

interface SourceArtifact extends ArtifactOwner {
  readonly kind: 'source'
  readonly language: 'svg' | 'mermaid'
  readonly source: string
}

interface ModelArtifact extends ArtifactOwner {
  readonly kind: 'model'
  /** Only constructed for a confirmed host-local path. */
  readonly path: string
}

export type ConfirmedWriteArtifact = SourceArtifact | ModelArtifact

const figureLanguages: Record<string, SourceArtifact['language']> = {
  svg: 'svg', mmd: 'mermaid', mermaid: 'mermaid'
}

const figureMimes: Record<SourceArtifact['language'], readonly string[]> = {
  svg: ['image/svg+xml'],
  mermaid: ['text/plain', 'text/vnd.mermaid', 'text/x-mermaid']
}

const modelMimes: Record<string, readonly string[]> = {
  glb: ['model/gltf-binary'], gltf: ['model/gltf+json'], obj: ['model/obj', 'text/plain'],
  usd: ['model/vnd.usd', 'application/x-usd'], usda: ['model/vnd.usda', 'text/plain'],
  usdc: ['model/vnd.usdc'], usdz: ['model/vnd.usdz+zip', 'application/x-usdz']
}

/** Project the owning completion, never the streaming arguments alone. No async cache to go stale. */
export function confirmedWriteArtifact(call: ToolCall, cwd: string, hostLocal: boolean): ConfirmedWriteArtifact | undefined {
  const result = record(call.result)
  const source = typeof call.args.content === 'string' ? call.args.content : call.args.contents

  // WriteResult.verified is the backend's on-disk hash check. bytes_written also
  // rejects partial results and differently sized/incomplete arguments.
  if (call.name !== 'write_file' || call.outcome.kind !== 'done' || !result || result.error || result.success === false ||
      result.verified !== true || result.partial === true || result.truncated === true || typeof source !== 'string' ||
      !source || result.bytes_written !== Buffer.byteLength(source, 'utf8')) {
    return undefined
  }

  const rawPath = result.resolved_path ?? call.args.path ?? call.args.file_path

  if (typeof rawPath !== 'string') { return undefined }

  const href = fileHref(rawPath, cwd)
  const ext = extname(rawPath).slice(1).toLowerCase()
  const reportedMime = result.mime ?? result.mime_type ?? result.mimetype

  if (!href || (reportedMime !== undefined && typeof reportedMime !== 'string')) { return undefined }

  const mime = typeof reportedMime === 'string' ? reportedMime.split(';')[0]?.trim().toLowerCase() : undefined
  const revision = createHash('sha256').update(JSON.stringify([call.id, href, source, result])).digest('hex')
  const owner = { callId: call.id, revision }
  const language = Object.hasOwn(figureLanguages, ext) ? figureLanguages[ext] : undefined

  if (language) {
    return !mime || mime === 'application/octet-stream' || figureMimes[language].includes(mime)
      ? { ...owner, kind: 'source', language, source }
      : undefined
  }

  if (hostLocal && Object.hasOwn(modelMimes, ext) && (!mime || mime === 'application/octet-stream' || modelMimes[ext]?.includes(mime))) {
    return { ...owner, kind: 'model', path: fileURLToPath(href) }
  }

  return undefined
}

/** Native fences own SVG/Mermaid rendering and theme; no generated JS or Luau is evaluated. */
export function writtenArtifactNode(artifact: ConfirmedWriteArtifact, native: boolean): Node | undefined {
  const key = `figure-${artifact.callId}-${artifact.revision}`

  if (artifact.kind === 'model') {
    return native ? mediaNode({ path: artifact.path }, key) : undefined
  }

  // A generated source containing a fence must not escape into a second Markdown block.
  const ticks = '`'.repeat([...artifact.source.matchAll(/`+/g)].reduce((size, match) => Math.max(size, match[0].length + 1), 3))

  return node('md', { key, role: 'omp.tool.write.figure', text: `${ticks}${artifact.language}\n${artifact.source}\n${ticks}` })
}
