// The isolated read/write card adapter; the registry and parser keep their existing behavior.
// Completion, path and host validation are owned by projectToolMedia().
import type { JSX } from '@stencil-hq/tern'

import type { MediaDelivery } from '../../media-delivery.js'
import type { ToolCall } from '../../model.js'
import { projectToolMedia } from '../../read-media.js'
import { imagePreviewNode } from '../media.js'

/** Build declarative nodes only; the preview's transfer starts on the user's action. */
export function toolMediaNode(call: ToolCall, delivery: MediaDelivery | undefined): JSX.Element | undefined {
  if (!delivery) {
    return undefined
  }

  const projection = projectToolMedia(call, delivery.context())

  if (!projection) {
    return undefined
  }

  if (projection.kind === 'node') {
    return projection.node
  }

  if (projection.kind === 'unsupported') {
    return (
      <text
        key="media"
        role="omp.media.notice"
        text={"Remote " + projection.family + " preview unavailable; the file is not host-local."}
        wrap="word"
      />
    )
  }

  return imagePreviewNode(projection.source, delivery, projection.source.path)
}
