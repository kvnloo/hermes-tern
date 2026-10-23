// The isolated tool-card adapter: the existing registry, parsers and card shells stay unchanged.
// Completion and host ownership have already been checked by projectToolMedia().
import type { JSX } from '@stencil-hq/tern'

import type { MediaDelivery } from '../../media-delivery.js'
import type { ToolCall } from '../../model.js'
import { projectToolMedia } from '../../read-media.js'
import { button } from '../ui/button.js'

/** Build declarative nodes only. An image transfer starts exclusively on a user click. */
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

  const state = delivery.preview(projection.source)

  if (state.status === 'ready') {
    return <image alt={projection.source.path} blob={state.blob} key="media" role="omp.media.preview" />
  }

  if (state.status === 'available' || state.status === 'failed') {
    return (
      <col gap="xs" key="media" role="omp.media.preview">
        {state.status === 'failed' ? <text key="error" role="omp.media.notice" text={state.error} wrap="word" /> : null}
        {button({ key: 'load', label: state.label, onClick: () => void delivery.load(projection.source) })}
      </col>
    )
  }

  return <text key="media" role="omp.media.notice" text={state.label} wrap="word" />
}
