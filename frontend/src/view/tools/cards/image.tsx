// A tool that shows an image (vision, image generation, a browser screenshot): the image itself.

import type { JSX } from '@stencil-hq/tern'

import { clip } from '../../../core/text.js'
import type { MediaDelivery } from '../../../media-delivery.js'
import { localSource } from '../../../media.js'
import { localMediaPath } from '../../../read-media.js'
import type { ToolCall } from '../../../model.js'
import type { GenericFields } from '../../../tools/misc.js'
import type { Card } from '../types.js'
import { imagePreviewNode } from '../../media.js'

/** The image itself, open; what the tool said of it under it (not the JSON it came in). */
export function imageCard(call: ToolCall, d: GenericFields, look: { name: string; title: string }, src: string | undefined, media?: MediaDelivery): Card {
  const said = call.outcome.kind === 'running' ? undefined : d.said

  return {
    ...look,
    body: [
      ...(src ? [imageNode(call, d, src, media)] : []),
      ...(said ? [<text key="said" lines={6} spans={[{ s: 'muted', t: clip(said, { mark: 'line', max: 2000 }) }]} wrap="word" />] : [])
    ],
    folded: false,
    target: d.prompt ?? d.question ?? (call.context || undefined),
    targetKind: 'text'
  }
}

/** The image a call showed; a click opens it large in Tern's lightbox. A URL shows once its bytes came. */
function imageNode(call: ToolCall, d: GenericFields, src: string, media?: MediaDelivery): JSX.Element {
  const source = localSource(src) ?? call.image
  const alt = d.prompt ?? 'Image'

  // A screenshot or generated image on a remote owner is not a local Tern file.
  if (source && 'path' in source && media && !media.context().local) {
    const path = localMediaPath(source.path, media.context().cwd)
    const host = media.context().remoteHost

    if (!path || (host !== 'gateway' && host !== 'frontend')) {
      return <text key="image" role="omp.media.notice" text="Screenshot is not host-local; preview is unavailable." />
    }

    return imagePreviewNode({ host, id: String(call.id), kind: 'path', path, toolCallId: String(call.id) }, media, clip(alt, { mark: 'line', max: 200 }), 'image')
  }

  if (source) {
    return <image alt={clip(alt, { mark: 'line', max: 200 })} key="image" role="hermes.tool.image" {...source} />
  }

  // A data URL is no address to show; an http(s) one is, as a link.
  const link = /^https?:\/\//i.test(src) ? [{ href: src, t: clip(src, { mark: 'line', max: 120 }) }] : []

  return (
    <text
      key="image"
      spans={[{ s: 'muted', t: call.image === null ? `Could not load the image${link.length ? ': ' : '.'}` : 'Loading the image…' }, ...(call.image === null ? link : [])]}
      wrap="word"
    />
  )
}
