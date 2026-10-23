// Project completed read_file and verified write_file artifacts, never speculative tool arguments.
// Tern owns native PDF/video/model/image decoding; remote paths are not local file links.
import { createHash } from 'node:crypto'
import { extname, isAbsolute, resolve } from 'node:path'

import { node, type Node } from '@stencil-hq/tern'

import type { MediaPath } from './media-delivery.js'
import type { ToolCall } from './model.js'
import { mediaNode } from './tern-media.js'
import { record } from './wire/json.js'

export type MediaFamily = 'image' | 'pdf' | 'video' | 'audio' | 'model'

const EXTENSIONS: Record<MediaFamily, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'heif'],
  pdf: ['pdf'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'aiff'],
  model: ['glb', 'gltf', 'obj', 'usd', 'usda', 'usdc', 'usdz']
}

const FAMILY_BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([family, extensions]) =>
  extensions.map(extension => [extension, family as MediaFamily] as const)
))
const MODEL_MIMES: Record<string, readonly string[]> = {
  glb: ['model/gltf-binary'],
  gltf: ['model/gltf+json'],
  obj: ['model/obj', 'text/plain'],
  usd: ['model/vnd.usd', 'application/x-usd'],
  usda: ['model/vnd.usda', 'text/plain'],
  usdc: ['model/vnd.usdc'],
  usdz: ['model/vnd.usdz+zip', 'application/x-usdz']
}
const FIGURE_LANGUAGES: Record<string, 'svg' | 'mermaid'> = {
  svg: 'svg', mmd: 'mermaid', mermaid: 'mermaid'
}

export interface MediaContext {
  readonly cwd: string | undefined
  readonly native: boolean
  readonly local: boolean
  readonly remoteHost: MediaPath['host']
}

export type ToolMedia =
  | { readonly kind: 'node'; readonly node: Node }
  | { readonly kind: 'remote-image'; readonly source: MediaPath }
  | { readonly kind: 'unsupported'; readonly family: MediaFamily }

/** No scheme, network path, control byte, or implicit frontend cwd may become a terminal path. */
export function localMediaPath(path: string, cwd: string | undefined): string | undefined {
  if (!path || !path.trim() || /[\x00-\x1f\x7f]/.test(path) ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    return undefined
  }

  if (!isAbsolute(path) && (!cwd || !isAbsolute(cwd))) {
    return undefined
  }

  return isAbsolute(path) ? resolve(path) : resolve(cwd!, path)
}

/** Only a matching file suffix and reported MIME may claim a native media family. */
export function mediaFamily(path: string, reportedMime?: string): MediaFamily | undefined {
  const extension = extname(path).slice(1).toLowerCase()
  const family = FAMILY_BY_EXTENSION.get(extension)

  if (!family) {
    return undefined
  }

  const mime = reportedMime?.split(';')[0]?.trim().toLowerCase()

  if (!mime || mime === 'application/octet-stream') {
    return family
  }

  const compatible = family === 'image' ? mime.startsWith('image/')
    : family === 'pdf' ? mime === 'application/pdf'
      : family === 'video' ? mime.startsWith('video/')
        : family === 'audio' ? mime.startsWith('audio/')
          : MODEL_MIMES[extension]?.includes(mime) === true

  return compatible ? family : undefined
}

/** Local supported media: native node when negotiated; legacy image fallback otherwise. */
export function readMedia(path: string, cwd: string | undefined, reportedMime: string | undefined, native: boolean, local: boolean): Node | undefined {
  const family = mediaFamily(path, reportedMime)
  const absolute = localMediaPath(path, cwd)

  if (!family || !absolute || !local) {
    return undefined
  }

  if (native) {
    return mediaNode({ path: absolute })
  }

  return family === 'image' ? node('image', { alt: path, key: 'media', path: absolute }) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function reportedMime(result: Record<string, unknown> | undefined): string | undefined {
  return text(result?.['mime']) ?? text(result?.['mime_type']) ?? text(result?.['mimetype'])
}

function writableFigure(path: string, source: string, call: ToolCall, mime: string | undefined): Node | undefined {
  const extension = extname(path).slice(1).toLowerCase()
  const language = Object.hasOwn(FIGURE_LANGUAGES, extension) ? FIGURE_LANGUAGES[extension] : undefined

  if (!language || (mime && mime !== 'application/octet-stream' &&
    !(language === 'svg' ? mime === 'image/svg+xml' : ['text/plain', 'text/vnd.mermaid', 'text/x-mermaid'].includes(mime)))) {
    return undefined
  }

  const hash = createHash('sha256').update(JSON.stringify([call.id, path, source, call.result])).digest('hex')
  const tickCount = [...source.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length + 1), 3)
  const ticks = '`'.repeat(tickCount)

  return node('md', { key: `figure-${call.id}-${hash}`, role: 'omp.tool.write.figure', text: `${ticks}${language}\n${source}\n${ticks}` })
}

/**
 * A source write has no visual authority until its result verifies the exact UTF-8 byte count.
 * Text-only SVG/Mermaid is fenced, not evaluated as executable JavaScript or Lua.
 */
export function confirmedWriteArtifact(call: ToolCall, cx: MediaContext): ToolMedia | undefined {
  if (call.name !== 'write_file' || call.outcome.kind !== 'done') {
    return undefined
  }

  const result = record(call.result)
  const source = text(call.args['content']) ?? text(call.args['contents'])

  if (!result || !source || result['verified'] !== true || result['success'] === false ||
      result['partial'] === true || result['truncated'] === true || result['error'] ||
      result['bytes_written'] !== Buffer.byteLength(source, 'utf8')) {
    return undefined
  }

  const path = text(result['resolved_path']) ?? text(call.args['path']) ?? text(call.args['file_path'])
  const absolute = path && localMediaPath(path, cx.cwd)

  if (!path || !absolute) {
    return undefined
  }

  const mime = reportedMime(result)?.split(';')[0]?.trim().toLowerCase()
  const figure = writableFigure(path, source, call, mime)

  if (figure) {
    return { kind: 'node', node: figure }
  }

  if (mediaFamily(path, mime) !== 'model') {
    return undefined
  }

  if (!cx.local) {
    return { family: 'model', kind: 'unsupported' }
  }

  if (!cx.native) {
    return undefined
  }

  const hash = createHash('sha256').update(JSON.stringify([call.id, absolute, source, call.result])).digest('hex')

  return { kind: 'node', node: mediaNode({ path: absolute }, `figure-${call.id}-${hash}`) }
}

/** Every read media projection is derived from a *completed* owning tool call. */
export function projectToolMedia(call: ToolCall, cx: MediaContext): ToolMedia | undefined {
  if (call.name === 'write_file') {
    return confirmedWriteArtifact(call, cx)
  }

  if (call.name !== 'read_file' || call.outcome.kind !== 'done') {
    return undefined
  }

  const result = record(call.result)

  if (result?.['success'] === false || result?.['error'] || result?.['partial'] === true || result?.['truncated'] === true) {
    return undefined
  }

  const path = text(result?.['resolved_path']) ?? text(call.args['path']) ?? text(call.args['file_path'])
  const absolute = path && localMediaPath(path, cx.cwd)
  const mime = reportedMime(result)
  const family = path && mediaFamily(path, mime)

  if (!family || !absolute || !path) {
    return undefined
  }

  if (cx.local) {
    const projected = readMedia(path, cx.cwd, mime, cx.native, cx.local)

    return projected ? { kind: 'node', node: projected } : undefined
  }

  if (family !== 'image' || cx.remoteHost === 'compute' || cx.remoteHost === 'tern') {
    return { family, kind: 'unsupported' }
  }

  return {
    kind: 'remote-image',
    source: {
      host: cx.remoteHost,
      id: String(call.id),
      kind: 'path',
      mime,
      path: absolute,
      toolCallId: String(call.id)
    }
  }
}
